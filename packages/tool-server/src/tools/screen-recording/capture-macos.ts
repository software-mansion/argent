import * as os from "os";
import { constants as fsConstants, promises as fs } from "fs";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { MacosAppApi, MacosAppConnection } from "../../blueprints/macos-app";
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
 * app write the finished video to a path this start chose, then copies it to
 * the session's `outputFile`, which the app cannot reach.
 *
 * The library drops a recording when the connection that started it closes,
 * so every later call of a recording goes over that connection only: on a new
 * one it would close the connection of whoever connected to the app since,
 * another tool-server's recording included.
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
 * Where the video ends up: the host's temporary directory, resolved, since a
 * sandboxed app is granted the resolved path of its file (/var is /private/var).
 */
async function outputPath(deviceId: string): Promise<string> {
  return recordingOutputPath(deviceId, await fs.realpath(os.tmpdir()));
}

/**
 * Where the app writes the video, next to `outputFile`. The app can still
 * write this path after the stop, so the video is copied out of it.
 */
function appOutputPath(outputFile: string): string {
  return outputFile.replace(/\.mp4$/, ".from-app.mp4");
}

/**
 * A sandboxed app may write only the file it is given access to. Read from
 * the record of the process the start goes to: a launch writes the record
 * before the app connects, and `connect()` waits for a launch in flight.
 */
async function sandboxTokens(
  app: MacosAppApi,
  connection: MacosAppConnection,
  file: string
): Promise<{ tokens?: string[] }> {
  const tracked = getTrackedMacosApp(app.bundleId);
  if (tracked?.pid !== connection.pid) {
    throw macosFailure(
      `argent has no record of the ${app.bundleId} process it is connected to (pid ` +
        `${connection.pid}), so it cannot tell whether the app's sandbox lets it write the ` +
        `video. Run restart-app, then start the recording again.`,
      FAILURE_CODES.MACOS_APP_FILE_ACCESS_FAILED,
      "screen_recording_macos_start",
      "unknown"
    );
  }
  if (!tracked.sandboxed) return {};
  return { tokens: [await issueSandboxExtension(file)] };
}

/** The app dropped the recording: the connection that started it closed. */
function recordingLost(bundleId: string, cause?: unknown): FailureError {
  return new FailureError(
    `The recording in ${bundleId} was lost: the connection that started it closed, and the ` +
      `app drops a recording then. The app quit or restarted, stop-simulator-server closed ` +
      `the connection, or another tool-server connected to the app. Start a new recording.`,
    {
      error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
      failure_stage: "screen_recording_macos_stop",
      failure_area: "tool_server",
      error_kind: "not_found",
    },
    cause instanceof Error ? { cause } : undefined
  );
}

function outputRefused(detail: string, cause?: unknown): FailureError {
  return new FailureError(
    `The recording ended but ${detail}.`,
    {
      error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
      failure_stage: "screen_recording_macos_stop",
      failure_area: "tool_server",
      error_kind: "not_found",
    },
    cause instanceof Error ? { cause } : undefined
  );
}

/** Copied in chunks of this size, so a long video never sits in memory whole. */
const COPY_CHUNK_BYTES = 1 << 20;

/**
 * Copies the video the app wrote at `from` to `to`, a new file, and removes
 * `from` whatever the outcome. `from` is opened without following a symlink
 * and without blocking on a FIFO, and only a regular file with one link is
 * read, through that descriptor: the app can replace the path at any time, so
 * nothing that it points at is trusted, and no message names it. At most the
 * size seen at the open is copied.
 */
async function copyAppOutput(from: string, to: string): Promise<number> {
  try {
    return await copyFromDescriptor(from, to);
  } finally {
    await fs.rm(from, { force: true }).catch(() => {});
  }
}

async function copyFromDescriptor(from: string, to: string): Promise<number> {
  let src: fs.FileHandle;
  try {
    src = await fs.open(
      from,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw outputRefused(
      code === "ENOENT"
        ? `the app wrote no video`
        : code === "ELOOP"
          ? `the app's video file is a symbolic link`
          : `the app's video file could not be opened (${code ?? "unknown error"})`,
      err
    );
  }
  let copied = 0;
  try {
    const st = await src.stat();
    if (!st.isFile() || st.nlink !== 1) {
      throw outputRefused(`the app's video file is not a plain file with one link`);
    }
    if (st.size === 0) throw outputRefused(`the app's video file is empty`);
    const dst = await fs.open(to, "wx");
    try {
      const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, st.size));
      while (copied < st.size) {
        const { bytesRead } = await src.read(
          chunk,
          0,
          Math.min(chunk.length, st.size - copied),
          copied
        );
        if (bytesRead === 0) break;
        // A write can take only part of what it is given, for example at a
        // file size limit: the rest of the chunk is written before the next
        // read, so `copied` never counts a byte that is not in `to`.
        for (let written = 0; written < bytesRead;) {
          const { bytesWritten } = await dst.write(
            chunk,
            written,
            bytesRead - written,
            copied + written
          );
          if (bytesWritten === 0) throw outputRefused(`the video could not be written to ${to}`);
          written += bytesWritten;
        }
        copied += bytesRead;
      }
      // Emptied since the open.
      if (copied === 0) throw outputRefused(`the app's video file is empty`);
    } catch (err) {
      await dst.close().catch(() => {});
      await fs.rm(to, { force: true }).catch(() => {});
      throw err;
    }
    await dst.close();
  } finally {
    await src.close().catch(() => {});
  }
  return copied;
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
  let appFile: string;
  let connection: MacosAppConnection | undefined;
  try {
    assertNotDisposed(api, "screen_recording_start");
    connection = await app.connect();
    outputFile = await outputPath(api.deviceId);
    appFile = appOutputPath(outputFile);
    const tokens = await sandboxTokens(app, connection, appFile);
    await app.call(
      "ScreenRecording.start",
      {
        outputPath: appFile,
        timeLimitSeconds: params.timeLimitSeconds,
        trimStatic: params.trimStatic,
        showPointer: params.showTouches,
        ...(params.watermark ? { watermark: WATERMARK_PNG_BASE64 } : {}),
        ...tokens,
      },
      { timeoutMs: START_TIMEOUT_MS, connection }
    );
    // A dispose while the app was starting found nothing to end, so the
    // recording it left running is ended here.
    if (api.disposed) {
      await app
        .call("ScreenRecording.stop", {}, { timeoutMs: STOP_TIMEOUT_MS, connection })
        .catch(() => {});
      await fs.rm(appFile, { force: true }).catch(() => {});
      assertNotDisposed(api, "screen_recording_start");
    }
  } catch (err) {
    api.startPending = false;
    // A teardown closes the app's connection after it ends the session, so a
    // start it cut short reports the teardown, not the closed connection.
    assertNotDisposed(api, "screen_recording_start");
    if (connection && !connection.isOpen) {
      throw macosFailure(
        `The connection to ${app.bundleId} closed before the recording started, so nothing ` +
          `was recorded: the app quit or restarted, or another tool-server connected to it. ` +
          `Start the recording again.`,
        FAILURE_CODES.MACOS_APP_CONNECTION_LOST,
        "screen_recording_macos_start",
        "unknown",
        err
      );
    }
    throw asOutdatedLibrary(err, app.bundleId) ?? err;
  }
  const bound = connection;

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
        ended = endInApp(app, bound, appFile, outputFile);
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

/**
 * Ends the recording in the app over the connection that started it, which
 * has the app write the video to `appFile`, then copies it to `outputFile`.
 */
async function endInApp(
  app: MacosAppApi,
  connection: MacosAppConnection,
  appFile: string,
  outputFile: string
): Promise<EndedMacosRecording> {
  if (!connection.isOpen) throw recordingLost(app.bundleId);
  let reply: MacosStopReply;
  try {
    reply = await app.call<MacosStopReply>(
      "ScreenRecording.stop",
      {},
      { timeoutMs: STOP_TIMEOUT_MS, connection }
    );
  } catch (err) {
    const lost = !connection.isOpen;
    // What the app wrote before the failure is copied out of its path, as a
    // finished video is, so no error names a file the app can still change.
    // That includes a video the app finished just before its connection
    // closed, whose answer never arrived.
    const salvaged = await copyAppOutput(appFile, outputFile).then(
      () => true,
      () => false
    );
    if (!salvaged) throw lost ? recordingLost(app.bundleId, err) : err;
    const signal = getFailureSignal(err);
    const reason = lost
      ? `The connection to ${app.bundleId} closed as the recording ended, so the app's answer ` +
        `did not arrive.`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new FailureError(
      `${reason} What the app wrote before the failure is at ${outputFile}; it may be incomplete.`,
      (!lost && signal) || {
        error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
        failure_stage: "screen_recording_macos_stop",
        failure_area: "tool_server",
        error_kind: "unknown",
      },
      err instanceof Error ? { cause: err } : undefined
    );
  }
  const sizeBytes = await copyAppOutput(appFile, outputFile);
  return {
    sizeBytes,
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
    // The app cuts still stretches only when the start asked it to.
    const trimmed = ended.trimmedMs > 0;
    return {
      outputFile,
      sizeBytes: ended.sizeBytes,
      durationMs: ended.durationMs,
      ...(trimmed ? { wallClockMs: ended.wallClockMs, trimmedMs: ended.trimmedMs } : {}),
      ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    };
  } catch (err) {
    // The end removed the app's file whatever happened, and copied out what
    // the app wrote before a failure.
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
