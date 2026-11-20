import * as os from "os";
import { promises as fs } from "fs";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { MacosAppApi } from "../../blueprints/macos-app";
import type {
  EndedMacosRecording,
  MacosCapture,
  ScreenRecordingSessionApi,
} from "../../blueprints/screen-recording-session";
import { getTrackedMacosApp, issueSandboxExtension, macosFailure } from "../../utils/macos-apps";
import {
  clearActiveScreenRecording,
  markScreenRecordingFinalized,
  registerActiveScreenRecording,
} from "../../utils/screen-recording-reminder";
import { takeReapedSession } from "../../utils/reaped-sessions";
import {
  assertNoActiveRecording,
  assertNotDisposed,
  assertStoppableSession,
  statNonEmptyOutput,
  type StartRecordingResult,
  type StopRecordingFile,
  recordingOutputPath,
} from "./session-guards";
import { WATERMARK_PNG_BASE64 } from "./watermark-asset";

/**
 * Screen capture for Mac apps.
 *
 * argent's library inside the app records the app's window itself: it needs
 * no Screen Recording permission, shows no screen-sharing indicator, and needs
 * no ffmpeg on the host. It encodes the mp4, stamps the watermark, cuts still
 * stretches and draws the pointer while it records, so the capture is two
 * calls with a timer between them, as on a remote simulator: the stop has the
 * app write the finished video to the path this start chose.
 */

/** A start checks that the window can be recorded before it answers. */
const START_TIMEOUT_MS = 20_000;
/** A stop waits for the app to finish the video and write it out. */
const STOP_TIMEOUT_MS = 40_000;

/** What `ScreenRecording.stop` answers. */
interface MacosStopReply {
  durationMs?: unknown;
  wallClockMs?: unknown;
  trimmedMs?: unknown;
  timedOut?: unknown;
  warnings?: unknown;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Where the app writes the video: the host's temporary directory, resolved,
 * since a sandboxed app is granted the resolved path (/var is /private/var).
 */
async function outputPath(deviceId: string): Promise<string> {
  return recordingOutputPath(deviceId, await fs.realpath(os.tmpdir()));
}

/** A sandboxed app may write only the file it is given access to. */
async function sandboxTokens(app: MacosAppApi, file: string): Promise<{ tokens?: string[] }> {
  if (!getTrackedMacosApp(app.bundleId)?.sandboxed) return {};
  return { tokens: [await issueSandboxExtension(file)] };
}

/**
 * The library of an app started by an older argent has no recorder: the app
 * has to restart to load the current one.
 */
function asOutdatedLibrary(err: unknown, bundleId: string): FailureError | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!/Unsupported method: ScreenRecording\./.test(message)) return null;
  return macosFailure(
    `The argent library running in ${bundleId} is older than this argent and cannot record ` +
      `the screen. Restart the app with restart-app to load the current library, then start ` +
      `the recording again.`,
    FAILURE_CODES.MACOS_APP_LIBRARY_OUTDATED,
    "screen_recording_macos_start",
    "unsupported",
    err
  );
}

export async function startMacosCapture(
  api: ScreenRecordingSessionApi,
  app: MacosAppApi,
  params: {
    timeLimitSeconds: number;
    watermark: boolean;
    trimStatic: boolean;
    showTouches: boolean;
  }
): Promise<StartRecordingResult> {
  assertNoActiveRecording(api, "screen_recording_start");
  // Set synchronously (no await between the assert and here) so an overlapping
  // start or stop is rejected instead of racing this one; cleared on every exit.
  api.startPending = true;
  let outputFile: string;
  try {
    assertNotDisposed(api, "screen_recording_start");
    outputFile = await outputPath(api.deviceId);
    const tokens = await sandboxTokens(app, outputFile);
    await app.call(
      "ScreenRecording.start",
      {
        outputPath: outputFile,
        timeLimitSeconds: params.timeLimitSeconds,
        trimStatic: params.trimStatic,
        showPointer: params.showTouches,
        ...(params.watermark ? { watermark: WATERMARK_PNG_BASE64 } : {}),
        ...tokens,
      },
      { timeoutMs: START_TIMEOUT_MS }
    );
    // A dispose while the app was starting found nothing to end, so the
    // recording it left running is ended here.
    if (api.disposed) {
      await app.call("ScreenRecording.stop", {}, { timeoutMs: STOP_TIMEOUT_MS }).catch(() => {});
      await fs.rm(outputFile, { force: true }).catch(() => {});
      assertNotDisposed(api, "screen_recording_start");
    }
  } catch (err) {
    api.startPending = false;
    // A teardown closes the app's connection after it ends the session, so a
    // start it cut short reports the teardown, not the closed connection.
    assertNotDisposed(api, "screen_recording_start");
    throw asOutdatedLibrary(err, app.bundleId) ?? err;
  }

  // The capture is live: this recording owns the session now. Stamped only on
  // success, so a failed start never burns a previous capture's recovery.
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.pendingRetrieval = false;
  api.watermarkSkipped = null;
  api.outputFile = outputFile;
  api.trimStatic = params.trimStatic;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  let ended: Promise<EndedMacosRecording> | null = null;
  const macos: MacosCapture = {
    end: () => {
      if (!ended) {
        ended = endInApp(app);
        // The cap fires this with nobody awaiting; a failure is for the stop
        // that awaits it later, not an unhandled rejection now.
        ended.catch(() => {});
      }
      return ended;
    },
  };
  api.macos = macos;
  api.startPending = false;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds);
  // This recording's own stop will succeed, so an earlier teardown breadcrumb
  // would never be consumed.
  takeReapedSession("screen-recording", api.deviceId);

  // The app ends the capture at the limit by itself; this has the video
  // written out then, and keeps the reminder pointing at it until the stop.
  api.recordingTimeout = setTimeout(() => {
    api.recordingTimeout = null;
    // Ownership guard: a newer capture may have stamped the session.
    if (api.outputFile !== outputFile) return;
    api.recordingTimedOut = true;
    api.recordingActive = false;
    api.wallClockEndMs = Date.now();
    api.pendingRetrieval = true;
    markScreenRecordingFinalized(api.deviceId, `it hit its ${params.timeLimitSeconds}s time limit`);
    void macos.end();
  }, params.timeLimitSeconds * 1_000);

  return { status: "recording", timeLimitSeconds: params.timeLimitSeconds, outputFile };
}

/** Ends the recording in the app, which writes the video to the start's path. */
async function endInApp(app: MacosAppApi): Promise<EndedMacosRecording> {
  const reply = await app.call<MacosStopReply>(
    "ScreenRecording.stop",
    {},
    { timeoutMs: STOP_TIMEOUT_MS }
  );
  return {
    durationMs: num(reply?.durationMs),
    wallClockMs: num(reply?.wallClockMs),
    trimmedMs: num(reply?.trimmedMs),
    timedOut: reply?.timedOut === true,
    warnings: Array.isArray(reply?.warnings)
      ? reply.warnings.filter((w): w is string => typeof w === "string" && w.length > 0)
      : [],
  };
}

export async function stopMacosCapture(api: ScreenRecordingSessionApi): Promise<StopRecordingFile> {
  assertStoppableSession(api, "screen_recording_stop");
  // Set synchronously so a concurrent stop or start is rejected while this one
  // finalizes.
  api.stopPending = true;

  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }

  // Both set together by the start that `assertStoppableSession` just vouched for.
  const outputFile = api.outputFile!;
  const macos = api.macos!;
  const warnings: string[] = [];

  try {
    if (api.recordingActive) {
      api.recordingActive = false;
      api.wallClockEndMs = Date.now();
    }
    // Once: after the cap this joins the stop it started.
    const ended = await macos.end();
    if (api.recordingTimedOut || ended.timedOut) {
      warnings.push(
        `Recording already ended at its ${api.timeLimitSeconds ?? "?"}s time limit; ` +
          `returning the finalized video.`
      );
    }
    warnings.push(...ended.warnings);
    const size = await statNonEmptyOutput(outputFile, "screen_recording_stop");
    // The app cuts still stretches only when the start asked it to.
    const trimmed = ended.trimmedMs > 0;
    return {
      outputFile,
      sizeBytes: size,
      durationMs: ended.durationMs,
      ...(trimmed ? { wallClockMs: ended.wallClockMs, trimmedMs: ended.trimmedMs } : {}),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  } catch (err) {
    // Nothing usable came back, so the path is ours to clean up. Gated on the
    // file genuinely being empty or absent, so no error can delete a real video.
    const empty = await fs
      .stat(outputFile)
      .then((s) => s.size === 0)
      .catch(() => true);
    if (empty) await fs.rm(outputFile, { force: true }).catch(() => {});
    if (getFailureSignal(err)) throw err;
    throw new FailureError(
      `The Mac app's screen recording could not be retrieved: ${err instanceof Error ? err.message : String(err)}`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
        failure_stage: "screen_recording_macos_stop",
        failure_area: "tool_server",
        error_kind: "unknown",
      },
      err instanceof Error ? { cause: err } : undefined
    );
  } finally {
    // Always return the session to a startable state.
    api.recordingActive = false;
    api.stopPending = false;
    api.pendingRetrieval = false;
    api.macos = null;
    api.outputFile = null;
    api.watermarkSkipped = null;
    api.wallClockStartMs = null;
    api.wallClockEndMs = null;
    api.timeLimitSeconds = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    clearActiveScreenRecording(api.deviceId);
  }
}
