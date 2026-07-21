import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../../blueprints/screen-recording-session";
import { resolveAndroidBinary } from "../../../utils/android-binary";
import { adbShell, runAdb } from "../../../utils/adb";
import { waitForChildExit } from "../../../utils/profiler-shared/lifecycle";
import {
  clearActiveScreenRecording,
  markScreenRecordingFinalized,
  registerActiveScreenRecording,
} from "../../../utils/screen-recording-reminder";
import {
  assertNoActiveRecording,
  assertNotDisposed,
  assertStoppableSession,
  clip,
  statNonEmptyOutput,
  type StartRecordingResult,
  type StopRecordingFile,
} from "./shared";

// AOSP screenrecord hard-caps --time-limit at 180s (kMaxTimeLimitSec); a
// larger value is rejected before a single frame is captured, so clamp
// host-side and surface the applied cap in the result instead.
export const ANDROID_MAX_TIME_LIMIT_SECONDS = 180;
const START_TIMEOUT_MS = 15_000;
const START_FAILFAST_GRACE_MS = 800;
// screenrecord self-stops at --time-limit; the host timer only reaps an adb
// child left hanging by an unreachable device, so it fires past the cap.
const HOST_SAFETY_MARGIN_MS = 15_000;
const STOP_PROBE_TIMEOUT_MS = 5_000;
const FINALIZE_WAIT_MS = 15_000;
// A 180s capture at screenrecord's default bitrate can reach hundreds of MB;
// over wireless adb that pull is minutes, not seconds.
const PULL_TIMEOUT_MS = 600_000;

/**
 * Wait for the device-side `READY:<pid>` echo, then hold a short grace so an
 * instantly-failing screenrecord (bad flag, no encoder, SELinux denial) fails
 * the start instead of surfacing minutes later at stop time.
 */
function waitForScreenrecordStarted(
  child: ReturnType<typeof spawn>,
  streams: { stdout: string; stderr: string }
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;

    const finish = (err: Error | null, pid?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      child.removeListener("exit", onExit);
      child.stdout?.removeListener("data", onStdout);
      if (err) reject(err);
      else resolve(pid!);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      finish(
        new FailureError(
          `adb screenrecord did not report a PID within ${START_TIMEOUT_MS} ms. ` +
            `stdout: ${clip(streams.stdout)} | stderr: ${clip(streams.stderr)}`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_START_TIMEOUT,
            failure_stage: "android_screen_recording_ready",
            failure_area: "tool_server",
            error_kind: "timeout",
            failure_command: "adb",
          }
        )
      );
    }, START_TIMEOUT_MS);

    const startFailure = (code: number | null, signal: NodeJS.Signals | null): FailureError => {
      const reason = signal ? `signal ${signal}` : `code ${code ?? "?"}`;
      return new FailureError(
        `screenrecord exited (${reason}) before the recording started. ` +
          `stdout: ${clip(streams.stdout)} | stderr: ${clip(streams.stderr)}`,
        {
          error_code: FAILURE_CODES.SCREEN_RECORDING_START_EXITED,
          failure_stage: "android_screen_recording_ready",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata({ code, signal }, "adb"),
        }
      );
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(startFailure(code, signal));
    };
    child.once("exit", onExit);

    const onStdout = (): void => {
      // Only parse COMPLETE lines (everything before the last newline) — a
      // chunk split inside the PID would hand back a truncated number (same
      // guard as the perfetto start). adb may emit \r\n on pty-backed shells.
      const lines = streams.stdout.split(/\r?\n/).slice(0, -1);
      const match = lines.map((line) => /^READY:(\d+)$/.exec(line.trim())).find((m) => m !== null);
      if (!match) return;
      const pid = parseInt(match[1]!, 10);
      if (!Number.isFinite(pid) || pid <= 0) return;
      child.stdout?.removeListener("data", onStdout);
      // The PID is in hand — disarm the overall start timeout so a READY that
      // lands near the deadline is not SIGKILLed mid-grace as a false timeout.
      clearTimeout(timer);
      // PID echoed, but screenrecord may still die on its first frame; hold a
      // short grace before declaring the capture live.
      graceTimer = setTimeout(() => {
        child.removeListener("exit", onGraceExit);
        finish(null, pid);
      }, START_FAILFAST_GRACE_MS);
      child.removeListener("exit", onExit);
      const onGraceExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(startFailure(code, signal));
      };
      child.once("exit", onGraceExit);
    };
    child.stdout?.on("data", onStdout);
  });
}

export async function startScreenRecordingAndroid(
  api: ScreenRecordingSessionApi,
  params: { udid: string; timeLimitSeconds: number }
): Promise<StartRecordingResult> {
  assertNoActiveRecording(api, "android_screen_recording_start");
  // Set synchronously (no await between the assert and here) so an
  // overlapping start on the same session is rejected instead of racing this
  // one through the async spawn/readiness window below.
  api.startPending = true;
  try {
    return await startScreenRecordingAndroidLocked(api, params);
  } finally {
    api.startPending = false;
    api.pendingChild = null;
  }
}

async function startScreenRecordingAndroidLocked(
  api: ScreenRecordingSessionApi,
  params: { udid: string; timeLimitSeconds: number }
): Promise<StartRecordingResult> {
  const adbPath = await resolveAndroidBinary("adb");
  if (!adbPath) {
    throw new FailureError(
      "`adb` not found on PATH or under `$ANDROID_HOME/platform-tools`. " +
        "Install Android SDK Platform Tools or set `$ANDROID_HOME` to your SDK root.",
      {
        error_code: FAILURE_CODES.ANDROID_ADB_NOT_FOUND,
        failure_stage: "android_screen_recording_resolve_adb",
        failure_area: "tool_server",
        error_kind: "dependency_missing",
        failure_command: "adb",
      }
    );
  }

  // A previous capture that ended but was never retrieved (its reminder was
  // ignored) is superseded by this start — the profiler contract. Note the
  // file now, remove it only AFTER the new capture is live (below): a failed
  // start must stay side-effect-free so the pending recovery — including the
  // only copy of that video — survives.
  const staleOnDeviceFile = api.androidOnDeviceFile;

  const timeLimitSeconds = Math.min(params.timeLimitSeconds, ANDROID_MAX_TIME_LIMIT_SECONDS);
  const timestamp = Date.now();
  const onDeviceFile = `/sdcard/argent-screen-recording-${timestamp}.mp4`;
  const outputFile = path.join(
    os.tmpdir(),
    `argent-screen-recording-${params.udid.replace(/[^A-Za-z0-9._-]/g, "-")}-${timestamp}.mp4`
  );

  // Background + echo + wait: the PID echo is the readiness signal (and stop's
  // SIGINT target), while `wait` keeps the host child's lifetime tied to the
  // on-device capture so its exit event doubles as "the recording ended".
  const shellCommand =
    `screenrecord --time-limit ${timeLimitSeconds} ${onDeviceFile} & ` + `echo "READY:$!"; wait $!`;
  // No await between here and `api.pendingChild = child` below: if dispose()
  // ran (shutdown) across the `resolveAndroidBinary` hop above, abort now
  // rather than spawn a device-side recorder the teardown can no longer reap.
  assertNotDisposed(api, "android_screen_recording_start");
  const child = spawn(adbPath, ["-s", params.udid, "shell", shellCommand], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Visible to dispose() while readiness is pending (captureProcess is
  // stamped success-only); the wrapper's finally clears it.
  api.pendingChild = child;

  const streams = { stdout: "", stderr: "" };
  child.stdout?.on("data", (chunk: Buffer) => {
    streams.stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    streams.stderr += chunk.toString("utf8");
  });
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", (err) =>
      reject(
        new FailureError(
          `Failed to launch adb for screenrecord: ${err.message}`,
          {
            error_code: FAILURE_CODES.SCREEN_RECORDING_PROCESS_ERROR,
            failure_stage: "android_screen_recording_spawn",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "adb"),
          },
          { cause: err }
        )
      )
    );
  });

  let devicePid: number;
  try {
    devicePid = await Promise.race([waitForScreenrecordStarted(child, streams), spawnError]);
  } catch (err) {
    // A failed start may still have spawned a device-side screenrecord (e.g.
    // READY never parsed but the capture is running). Best-effort reap it and
    // its file so nothing keeps recording — or keeps 100+ MB — behind a start
    // the caller was told failed.
    void adbShell(params.udid, `pkill -INT -f ${onDeviceFile}; rm -f ${onDeviceFile}`, {
      timeoutMs: STOP_PROBE_TIMEOUT_MS,
    }).catch(() => {});
    throw err;
  }
  child.on("error", () => {});

  // Capture is live — stamp the session (success-only, like the iOS path).
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.pendingRetrieval = false;
  api.lastExitInfo = null;
  api.outputFile = outputFile;
  api.androidOnDeviceFile = onDeviceFile;
  api.androidDevicePid = devicePid;
  api.captureProcess = child;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = timeLimitSeconds;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, timeLimitSeconds);

  // The new capture is live and owns the session — only now is the superseded
  // capture's on-device file expendable. Best-effort, off the critical path.
  if (staleOnDeviceFile) {
    void adbShell(params.udid, `rm -f ${staleOnDeviceFile}`, {
      timeoutMs: STOP_PROBE_TIMEOUT_MS,
    }).catch(() => {});
  }

  api.recordingTimeout = setTimeout(
    () => {
      api.recordingTimeout = null;
      // Ownership guard: a newer capture may have stamped the session.
      if (api.captureProcess !== child) return;
      if (!api.recordingActive) return;
      // screenrecord should have self-stopped at the cap; getting here means
      // the adb child hung (device unplugged, daemon wedged). Reap it so the
      // session can't stay "recording" forever.
      api.recordingActive = false;
      api.recordingTimedOut = true;
      api.wallClockEndMs = Date.now();
      api.pendingRetrieval = true;
      markScreenRecordingFinalized(
        api.deviceId,
        `it hit its ${timeLimitSeconds}s time limit but the device stopped responding`
      );
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    },
    timeLimitSeconds * 1_000 + HOST_SAFETY_MARGIN_MS
  );

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
      api.recordingActive = false;
      api.wallClockEndMs = Date.now();
      api.pendingRetrieval = true;
      // `wait $!` propagates screenrecord's exit code on shell-v2 adb, but the
      // legacy shell protocol (old adb/devices) always reports 0 — so require
      // the clean exit to also LAND at the cap before calling it a time-limit
      // stop. A clean-looking exit long before the cap is still a death.
      const elapsedMs =
        api.wallClockStartMs === null ? null : api.wallClockEndMs - api.wallClockStartMs;
      const reachedTimeLimit =
        code === 0 && elapsedMs !== null && elapsedMs >= timeLimitSeconds * 1_000 - 2_000;
      if (reachedTimeLimit) {
        api.recordingTimedOut = true;
        markScreenRecordingFinalized(api.deviceId, `it hit its ${timeLimitSeconds}s time limit`);
      } else {
        api.recordingExitedUnexpectedly = true;
        markScreenRecordingFinalized(api.deviceId, "the recording process exited unexpectedly");
      }
    }
  });

  return { status: "recording", timeLimitSeconds, outputFile };
}

export async function stopScreenRecordingAndroid(
  api: ScreenRecordingSessionApi
): Promise<StopRecordingFile> {
  assertStoppableSession(api, "android_screen_recording_stop");
  // Set synchronously so a concurrent stop (double pull into the same host
  // file) or start is rejected while this one finalizes.
  api.stopPending = true;

  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }

  const outputFile = api.outputFile!;
  const onDeviceFile = api.androidOnDeviceFile;
  const startedAtMs = api.wallClockStartMs;
  const endedEarly = api.recordingTimedOut || api.recordingExitedUnexpectedly;
  let warning: string | undefined;
  // Distinguishes "video handed over (or provably gone)" from "video still on
  // the device": the finally below either fully resets the session, or keeps
  // it retrievable so this stop can be retried after e.g. a pull timeout.
  let delivered = false;
  // Whether the post-pull on-device `rm` actually succeeded. If it didn't, the
  // (already-pulled) mp4 is still on /sdcard, so we keep its path on the
  // session for the next start's stale-sweep instead of orphaning it forever.
  let onDeviceRemoved = false;

  try {
    const child = api.captureProcess;
    if (api.recordingActive && api.androidDevicePid) {
      // Flip active first so the exit handler reads the SIGINT-driven exit as
      // ours, not as an unexpected death. The capture stops at the SIGINT, so
      // that is the recording's end time.
      api.recordingActive = false;
      api.wallClockEndMs = Date.now();
      // SIGINT makes screenrecord stop capturing and write the MP4 trailer;
      // the device-side shell (and with it the host adb child) exits once the
      // file is complete.
      await adbShell(api.deviceId, `kill -INT ${api.androidDevicePid}`, {
        timeoutMs: STOP_PROBE_TIMEOUT_MS,
      }).catch(() => {
        // Device unreachable — the host-child wait below bounds the damage.
      });
      if (child && !(await waitForChildExit(child, FINALIZE_WAIT_MS))) {
        await adbShell(api.deviceId, `kill -KILL ${api.androidDevicePid}`, {
          timeoutMs: STOP_PROBE_TIMEOUT_MS,
        }).catch(() => {});
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        warning =
          `screenrecord did not finalize within ${FINALIZE_WAIT_MS} ms after SIGINT; ` +
          `escalated to SIGKILL. The video may be truncated or unplayable.`;
      }
    } else if (child) {
      // Recovery path — the capture already ended; just bound a lingering child.
      if (!(await waitForChildExit(child, FINALIZE_WAIT_MS))) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    }

    if (endedEarly && !warning) {
      warning = api.recordingTimedOut
        ? `Recording already ended at its ${api.timeLimitSeconds ?? "?"}s time limit; returning the finalized video.`
        : `screenrecord exited before stop was called (code=${api.lastExitInfo?.code ?? "?"}, ` +
          `signal=${api.lastExitInfo?.signal ?? "?"}); returning whatever was captured.`;
    }

    if (!onDeviceFile) {
      delivered = true; // nothing on the device to preserve for a retry
      throw new FailureError(
        `The screen recording session on ${api.deviceId} lost track of its on-device file — cannot pull the video.`,
        {
          error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
          failure_stage: "android_screen_recording_stop",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    }
    await runAdb(["-s", api.deviceId, "pull", onDeviceFile, outputFile], {
      timeoutMs: PULL_TIMEOUT_MS,
    });
    const size = await statNonEmptyOutput(outputFile, "android_screen_recording_stop");
    // The video is safely on the host — only now is the on-device copy
    // expendable and the session done.
    delivered = true;
    await adbShell(api.deviceId, `rm -f ${onDeviceFile}`, {
      timeoutMs: STOP_PROBE_TIMEOUT_MS,
    })
      .then(() => {
        onDeviceRemoved = true;
      })
      .catch(() => {
        // Swallowed: the video is already on the host, so a failed cleanup must
        // not fail the stop. The path is preserved below for later cleanup.
      });

    // Capture length, not wall-clock-since-start: after the cap fires the
    // recording is over even if stop arrives much later.
    const durationMs =
      startedAtMs === null ? null : (api.wallClockEndMs ?? Date.now()) - startedAtMs;
    return { outputFile, sizeBytes: size, durationMs, ...(warning ? { warning } : {}) };
  } finally {
    api.recordingActive = false;
    api.stopPending = false;
    api.captureProcess = null;
    api.androidDevicePid = null;
    if (delivered) {
      // Return the session to a fully startable state (same contract as the
      // Android native-profiler stop). If the post-pull `rm` failed, the mp4 is
      // still on /sdcard: keep its path (not null) so the next start's stale
      // sweep removes it instead of leaking it permanently — the video is
      // already delivered, so the reminder is still cleared below.
      api.pendingRetrieval = false;
      api.outputFile = null;
      api.androidOnDeviceFile = onDeviceRemoved ? null : onDeviceFile;
      api.wallClockStartMs = null;
      api.wallClockEndMs = null;
      api.timeLimitSeconds = null;
      api.recordingTimedOut = false;
      api.recordingExitedUnexpectedly = false;
      api.lastExitInfo = null;
      clearActiveScreenRecording(api.deviceId);
    } else {
      // The pull (or stat) failed but the finished video is still on the
      // device: keep the session retrievable so this stop can simply be
      // retried, and keep the reminder pointing at it. A new start remains
      // possible — it supersedes this capture and removes the on-device file.
      api.pendingRetrieval = true;
      markScreenRecordingFinalized(
        api.deviceId,
        "its video could not be pulled from the device — retry `screen-recording-stop`"
      );
    }
  }
}
