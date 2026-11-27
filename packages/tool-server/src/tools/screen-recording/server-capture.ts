import { promises as fs } from "fs";
import { FAILURE_CODES, FailureError, getFailureSignal, wrapFailure } from "@argent/registry";
import {
  DISPOSE_SERVER_STOP_MS,
  type ScreenRecordingSessionApi,
} from "../../blueprints/screen-recording-session";
import type { ServerRecordingResult } from "../../utils/simulator-client";
import {
  clearActiveScreenRecording,
  markScreenRecordingFinalized,
  registerActiveScreenRecording,
} from "../../utils/screen-recording-reminder";
import { takeReapedSession } from "../../utils/reaped-sessions";
import {
  assertNotDisposed,
  statNonEmptyOutput,
  type StartRecordingResult,
  type StopRecordingFile,
} from "./session-guards";
import { disablePointer, type PointerControl } from "./pointer-control";

/**
 * Recording done by simulator-server itself: it reuses the frames it already
 * encodes for the live stream, so there is no host `ffmpeg` and one encode
 * instead of two. The host keeps only the session bookkeeping.
 */

/** simulator-server's recording endpoints, bound by the start tool. */
export interface ServerRecordingControl {
  /** Resolves the finalizer for this recording. */
  start(opts: {
    watermark: boolean;
    trimStatic: boolean;
    timeLimitSeconds: number;
  }): Promise<ServerRecordingStop>;
}

/** Finalizes one server-side recording and hands back the muxed video. */
type ServerRecordingStop = () => Promise<ServerRecordingResult>;

/** Called by {@link startCapture} after its admission guards. */
export async function startServerCapture(
  api: ScreenRecordingSessionApi,
  params: {
    server: ServerRecordingControl;
    outputFile: string;
    timeLimitSeconds: number;
    watermark: boolean;
    trimStatic: boolean;
    pointer?: PointerControl;
  }
): Promise<StartRecordingResult> {
  assertNotDisposed(api, "screen_recording_start");
  const stop = await params.server.start({
    watermark: params.watermark,
    trimStatic: params.trimStatic,
    timeLimitSeconds: params.timeLimitSeconds,
  });

  // A dispose during the request could not see this recording; end it here.
  if (api.disposed) {
    await Promise.race([
      stop().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_SERVER_STOP_MS)),
    ]);
    assertNotDisposed(api, "screen_recording_start");
  }

  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.pendingRetrieval = false;
  api.pointerFailed = false;
  api.lastExitInfo = null;
  api.lastFrameStreamError = null;
  api.outputFile = params.outputFile;
  api.serverStop = stop;
  api.serverCapture = true;
  api.trimStatic = params.trimStatic;
  api.recordingActive = true;
  api.wallClockStartMs = Date.now();
  api.wallClockEndMs = null;
  api.timeLimitSeconds = params.timeLimitSeconds;
  registerActiveScreenRecording(api.deviceId, api.wallClockStartMs, params.timeLimitSeconds, true);
  takeReapedSession("screen-recording", api.deviceId);

  if (params.pointer) {
    api.pointerDisable = params.pointer.disable;
    api.pointerFailed = !(await params.pointer.enable());
    assertNotDisposed(api, "screen_recording_start");
  }

  // Mirrors the cap simulator-server enforces; the video stays there for stop.
  api.recordingTimeout = setTimeout(() => {
    api.recordingTimeout = null;
    if (api.serverStop !== stop) return;
    api.recordingTimedOut = true;
    api.recordingActive = false;
    api.wallClockEndMs = Date.now();
    api.pendingRetrieval = true;
    markScreenRecordingFinalized(api.deviceId, `it hit its ${params.timeLimitSeconds}s time limit`);
    void disablePointer(api);
  }, params.timeLimitSeconds * 1_000);

  return {
    status: "recording",
    timeLimitSeconds: params.timeLimitSeconds,
    outputFile: params.outputFile,
  };
}

/**
 * Fetch the muxed video out of simulator-server's session directory, which is
 * wiped when that server exits. Called by {@link stopCapture}.
 */
export async function stopServerCapture(
  api: ScreenRecordingSessionApi
): Promise<StopRecordingFile> {
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }

  const outputFile = api.outputFile!;
  const stop = api.serverStop!;
  const pointerFailed = api.pointerFailed;
  // Taken before the await so a dispose cannot issue a second stop.
  api.serverStop = null;

  try {
    if (api.recordingActive) {
      api.recordingActive = false;
      api.wallClockEndMs = Date.now();
    }
    let result: ServerRecordingResult;
    try {
      result = await stop();
    } catch (err) {
      throw recordingLost(err);
    }
    try {
      await fs.copyFile(result.path, outputFile);
    } catch (err) {
      // A full disk can leave a truncated copy; only this copy writes the path.
      await fs.rm(outputFile, { force: true }).catch(() => {});
      const detail = err instanceof Error ? err.message : String(err);
      throw new FailureError(
        `The recording finished but could not be copied out of simulator-server: ${detail}. ` +
          `Until this simulator-server exits, the video is still at ${result.path}.`,
        {
          error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
          failure_stage: "screen_recording_stop",
          failure_area: "tool_server",
          error_kind: "not_found",
          failure_command: "simulator_server",
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    await fs.rm(result.path, { force: true }).catch(() => {});

    const warnings: string[] = [];
    // The server reports its own time limit, so it is not repeated here.
    if (result.warning) warnings.push(result.warning);
    if (pointerFailed) {
      warnings.push(
        "The touch visualizer could not be enabled on simulator-server, so touches are not shown in this video."
      );
    }
    const warning = warnings.join(" ");

    const size = await statNonEmptyOutput(outputFile, "screen_recording_stop");
    return {
      outputFile,
      sizeBytes: size,
      durationMs: result.durationMs,
      ...(result.trimmedMs !== null && result.trimmedMs > 0
        ? { wallClockMs: result.wallClockMs, trimmedMs: result.trimmedMs }
        : {}),
      ...(warning ? { warning } : {}),
    };
  } catch (err) {
    const empty = await fs
      .stat(outputFile)
      .then((s) => s.size === 0)
      .catch(() => false);
    if (empty) await fs.rm(outputFile, { force: true }).catch(() => {});
    throw err;
  } finally {
    await disablePointer(api);
    api.recordingActive = false;
    api.stopPending = false;
    api.pendingRetrieval = false;
    api.serverStop = null;
    api.serverCapture = false;
    api.outputFile = null;
    api.pointerFailed = false;
    api.wallClockStartMs = null;
    api.wallClockEndMs = null;
    api.timeLimitSeconds = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    clearActiveScreenRecording(api.deviceId);
  }
}

/**
 * A failed stop cannot be retried: simulator-server drops a recording once a
 * stop reaches it, and a server that exits takes its videos with it.
 */
function recordingLost(err: unknown): FailureError {
  const failure = getFailureSignal(err)?.network_failure;
  const message =
    failure === "timeout"
      ? "screen-recording-stop failed: simulator-server did not answer in time, and the recording is lost. Start a new one."
      : failure === "connection_refused" || failure === "connection_reset" || failure === "other"
        ? "screen-recording-stop failed: simulator-server could not be reached, and the recording is lost with it. " +
          "If the simulator is booted, call stop-simulator-server for that UDID before starting a new one."
        : `${err instanceof Error ? err.message : String(err)} The recording is lost; start a new one.`;
  return wrapFailure(
    err,
    {
      error_code: FAILURE_CODES.SCREEN_RECORDING_PROCESS_ERROR,
      failure_stage: "screen_recording_server_stop",
      failure_area: "tool_server",
      error_kind: "unknown",
      failure_command: "simulator_server",
    },
    message
  );
}
