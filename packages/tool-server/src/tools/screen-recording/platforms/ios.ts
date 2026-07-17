import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../../blueprints/screen-recording-session";
import { shutdownChild, waitForChildExit } from "../../../utils/profiler-shared/lifecycle";
import {
  clearActiveScreenRecording,
  markScreenRecordingFinalized,
  registerActiveScreenRecording,
} from "../../../utils/screen-recording-reminder";
import {
  assertNoActiveRecording,
  assertStoppableSession,
  clip,
  statNonEmptyOutput,
  type StartRecordingResult,
  type StopRecordingFile,
} from "./shared";

const START_TIMEOUT_MS = 15_000;
const START_FILE_POLL_MS = 150;
// recordVideo finalizes the container (moov atom) after SIGINT; long capture =
// more to flush, so the grace is generous before escalating to signals that
// leave the file unplayable.
const STOP_GRACE_MS = 20_000;
const STOP_TERM_MS = 5_000;
const STOP_KILL_MS = 2_000;
// A capture that already ended (cap fired = SIGINT already sent) may still be
// flushing when stop arrives; bound how long stop waits for that exit.
const FINALIZE_WAIT_MS = 20_000;

/**
 * Resolves once recordVideo is actually capturing: the output file shows up on
 * disk (recordVideo creates it as soon as the first frames land) or simctl
 * announces the recording on stderr, whichever is observable first. Rejects if
 * the child exits before then (bad udid, unbooted simulator, codec error) or
 * nothing happens within the timeout.
 */
function waitForRecordVideoStarted(
  child: ReturnType<typeof spawn>,
  outputFile: string,
  stderrRef: { text: string }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: NodeJS.Timeout | null = null;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      finish(
        new FailureError(
          `simctl recordVideo did not start capturing within ${START_TIMEOUT_MS} ms. ` +
            `stderr: ${clip(stderrRef.text)}`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_START_TIMEOUT,
            failure_stage: "ios_screen_recording_ready",
            failure_area: "tool_server",
            error_kind: "timeout",
            failure_command: "xcrun_simctl",
          }
        )
      );
    }, START_TIMEOUT_MS);

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
      finish(
        new FailureError(
          `simctl recordVideo exited (${reason}) before the recording started. ` +
            `Is the simulator booted? stderr: ${clip(stderrRef.text)}`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_START_EXITED,
            failure_stage: "ios_screen_recording_ready",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata({ code, signal }, "xcrun_simctl"),
          }
        )
      );
    };
    child.once("exit", onExit);

    poll = setInterval(() => {
      // Either signal proves frames are flowing; stderr covers simctl builds
      // that buffer the file creation.
      if (/Recording started/i.test(stderrRef.text)) {
        finish();
        return;
      }
      void fs.stat(outputFile).then(
        () => finish(),
        () => {}
      );
    }, START_FILE_POLL_MS);
  });
}

export async function startScreenRecordingIos(
  api: ScreenRecordingSessionApi,
  params: { udid: string; timeLimitSeconds: number }
): Promise<StartRecordingResult> {
  assertNoActiveRecording(api, "ios_screen_recording_start");
  // Set synchronously (no await between the assert and here) so an
  // overlapping start on the same session is rejected instead of racing this
  // one through the async readiness window below.
  api.startPending = true;

  const outputFile = path.join(
    os.tmpdir(),
    `argent-screen-recording-${params.udid.slice(0, 8)}-${Date.now()}.mp4`
  );

  // h264 over the hevc default: universally decodable, and the whole point of
  // the artifact is to be watched/attached elsewhere.
  const child = spawn(
    "xcrun",
    ["simctl", "io", params.udid, "recordVideo", "--codec=h264", "--force", outputFile],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  const stderrRef = { text: "" };
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrRef.text += chunk.toString("utf8");
  });
  // An exec failure ('error' with no listener) would crash the server.
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (err) =>
      reject(
        new FailureError(
          `Failed to launch xcrun for recordVideo: ${err.message}`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_PROCESS_ERROR,
            failure_stage: "ios_screen_recording_spawn",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "xcrun_simctl"),
          },
          { cause: err }
        )
      )
    );
  });

  try {
    await Promise.race([waitForRecordVideoStarted(child, outputFile, stderrRef), spawnError]);
  } finally {
    // Stamping below is synchronous, so the pending window can close here on
    // both the success and the failure path.
    api.startPending = false;
  }
  // Keep the handle inert for the session's lifetime: a late exec error after
  // readiness (can't happen in practice, but 'error' unlistened is fatal).
  child.on("error", () => {});

  // Capture is live — this recording owns the session now. Stamping only on
  // success keeps a failed start from burning a previous capture's pending
  // recovery (same contract as the native-profiler start paths). A superseded
  // iOS recovery only strands a host tmpdir file, which is benign.
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.pendingRetrieval = false;
  api.lastExitInfo = null;
  api.outputFile = outputFile;
  api.captureProcess = child;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds);

  api.recordingTimeout = setTimeout(() => {
    api.recordingTimeout = null;
    // Ownership guard: if a newer capture stamped the session, this timer is
    // stale and must not touch shared state.
    if (api.captureProcess !== child) return;
    api.recordingTimedOut = true;
    // Flip active BEFORE the SIGINT so the exit handler reads this as the cap,
    // not an unexpected death.
    api.recordingActive = false;
    api.wallClockEndMs = Date.now();
    api.pendingRetrieval = true;
    markScreenRecordingFinalized(api.deviceId, `it hit its ${params.timeLimitSeconds}s time limit`);
    try {
      child.kill("SIGINT");
    } catch {
      // already dead
    }
  }, params.timeLimitSeconds * 1_000);

  child.on("exit", (code, signal) => {
    // Ownership guard: after this capture is superseded, its exit must not
    // clobber the newer capture's session state.
    if (api.captureProcess !== child) return;
    api.lastExitInfo = { code, signal };
    api.captureProcess = null;
    if (api.recordingTimeout) {
      clearTimeout(api.recordingTimeout);
      api.recordingTimeout = null;
    }
    if (api.recordingActive) {
      // Died without stop or the cap: simulator shut down, simctl crash, …
      api.recordingActive = false;
      api.recordingExitedUnexpectedly = true;
      api.wallClockEndMs = Date.now();
      api.pendingRetrieval = true;
      markScreenRecordingFinalized(api.deviceId, "the recording process exited unexpectedly");
    }
  });

  return {
    status: "recording",
    timeLimitSeconds: params.timeLimitSeconds,
    outputFile,
  };
}

export async function stopScreenRecordingIos(
  api: ScreenRecordingSessionApi
): Promise<StopRecordingFile> {
  assertStoppableSession(api, "ios_screen_recording_stop");
  // Set synchronously so a concurrent stop or start is rejected while this
  // one finalizes (see assertStoppableSession / assertNoActiveRecording).
  api.stopPending = true;

  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }

  const outputFile = api.outputFile!;
  const startedAtMs = api.wallClockStartMs;
  const endedEarly = api.recordingTimedOut || api.recordingExitedUnexpectedly;
  let warning: string | undefined;

  try {
    const child = api.captureProcess;
    if (api.recordingActive && child) {
      // Flip active first so the exit handler doesn't classify our own SIGINT
      // as an unexpected death. The capture stops producing frames at the
      // SIGINT, so that is the recording's end time (the finalize wait below
      // is container flushing, not captured footage).
      api.recordingActive = false;
      api.wallClockEndMs = Date.now();
      const result = await shutdownChild(child, {
        graceMs: STOP_GRACE_MS,
        termMs: STOP_TERM_MS,
        killMs: STOP_KILL_MS,
      });
      if (!result.clean) {
        warning =
          `simctl recordVideo did not finalize after SIGINT; ${result.signalUsed} was used. ` +
          `The video container may be truncated or unplayable.`;
      }
    } else if (child) {
      // Cap already SIGINTed it (or it died on its own); give the finalize a
      // bounded window before we stat the file.
      if (!(await waitForChildExit(child, FINALIZE_WAIT_MS))) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        warning =
          "recordVideo was still finalizing and had to be killed; the video may be truncated.";
      }
    }

    if (endedEarly && !warning) {
      warning = api.recordingTimedOut
        ? `Recording already ended at its ${api.timeLimitSeconds ?? "?"}s time limit; returning the finalized video.`
        : `recordVideo exited before stop was called (code=${api.lastExitInfo?.code ?? "?"}, ` +
          `signal=${api.lastExitInfo?.signal ?? "?"}); returning whatever was captured.`;
    }

    const size = await statNonEmptyOutput(outputFile, "ios_screen_recording_stop");
    // Capture length, not wall-clock-since-start: after the cap fires (or the
    // process dies) the recording is over even if stop arrives much later.
    const durationMs =
      startedAtMs === null ? null : (api.wallClockEndMs ?? Date.now()) - startedAtMs;
    return { outputFile, sizeBytes: size, durationMs, ...(warning ? { warning } : {}) };
  } finally {
    // Always return the session to a startable state — a failed stat must not
    // wedge the next start behind "already active" (same contract as the
    // Android native-profiler stop). The file is host-side, so unlike the
    // Android pull there is nothing a retried stop could recover.
    api.recordingActive = false;
    api.stopPending = false;
    api.pendingRetrieval = false;
    api.captureProcess = null;
    api.outputFile = null;
    api.wallClockStartMs = null;
    api.wallClockEndMs = null;
    api.timeLimitSeconds = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;
    clearActiveScreenRecording(api.deviceId);
  }
}
