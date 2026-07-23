import { promises as fs } from "fs";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../blueprints/screen-recording-session";

export interface StartRecordingResult {
  status: "recording";
  /** Auto-stop cap applied to this capture. */
  timeLimitSeconds: number;
  /** Host path the finished video will land at once stop is called. */
  outputFile: string;
}

export interface StopRecordingFile {
  /** Host path of the finalized video (registered as an artifact by the tool). */
  outputFile: string;
  sizeBytes: number;
  /**
   * Length of the returned video. With static-frame trimming on this is the
   * frame-derived length (always present) and shorter than the wall clock — it
   * counts only the frames that survived. Null only when trimming is off and the
   * session lost its start stamp.
   */
  durationMs: number | null;
  /** Real elapsed recording time. Present only when trimming actually applied. */
  wallClockMs?: number;
  /** How much wall-clock time trimming removed. Present only when trimming applied. */
  trimmedMs?: number;
  warning?: string;
}

/** Cap what device/subprocess output gets interpolated into failure messages. */
export function clip(s: string, max = 300): string {
  const t = s.trim();
  if (!t) return "<empty>";
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/**
 * Reject a start while a capture is live, while another start/stop is mid-flight
 * on the same session, OR while a finalized-but-unretrieved capture is still
 * waiting to be handed over (the `pendingRetrieval` state a cap or crash leaves
 * behind). The pending flags are set synchronously before the first await of
 * start/stop, closing the check-then-stamp gap that would otherwise let two
 * overlapping calls both pass this guard and cross-corrupt the shared session
 * state. Guarding `pendingRetrieval` too stops a start-after-cap from
 * overwriting the earlier recording's `outputFile`/`logoFile` and orphaning its
 * video on disk (stop still recovers it — the guard points the caller there).
 */
export function assertNoActiveRecording(api: ScreenRecordingSessionApi, stage: string): void {
  const awaitingRetrieval = api.pendingRetrieval && api.outputFile !== null;
  if (api.recordingActive || api.startPending || api.stopPending || awaitingRetrieval) {
    const detail = api.recordingActive
      ? `A screen recording is already running on device ${api.deviceId} ` +
        `(started ${api.wallClockStartMs ? Math.round((Date.now() - api.wallClockStartMs) / 1000) : "?"}s ago). ` +
        `Call \`screen-recording-stop\` first.`
      : api.stopPending
        ? `A screen-recording-stop is still finalizing on device ${api.deviceId}. ` +
          `Wait for it to return before starting a new recording.`
        : api.startPending
          ? `Another screen-recording-start is already in flight on device ${api.deviceId}.`
          : `A previous screen recording on device ${api.deviceId} already ended (time limit or ` +
            `unexpected exit) and its video has not been retrieved yet. Call ` +
            `\`screen-recording-stop\` to hand it over before starting a new recording.`;
    throw new FailureError(detail, {
      error_code: FAILURE_CODES.SCREEN_RECORDING_ALREADY_ACTIVE,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
}

/**
 * Stop is valid while the capture runs, and also after it ended on its own
 * (time limit, crash, earlier failed pull) with a file still to hand over —
 * the "finalized, awaiting retrieval" recovery the reminder note keeps
 * pointing at. A second stop overlapping a running one is rejected: two
 * concurrent finalize sequences would race into the same host file.
 */
export function assertStoppableSession(api: ScreenRecordingSessionApi, stage: string): void {
  if (api.startPending) {
    // A start is mid-readiness: a stop admitted now (e.g. against a previous
    // finalized capture) would wipe the superseding capture's session the
    // moment it stamps, leaving that recording unmanageable forever.
    throw new FailureError(
      `A screen-recording-start is currently in flight on device ${api.deviceId}; ` +
        `wait for it to return, then stop that recording.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_ALREADY_ACTIVE,
        failure_stage: stage,
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  if (api.stopPending) {
    throw new FailureError(
      `A screen-recording-stop is already in progress on device ${api.deviceId}; wait for it to return.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_STOP_IN_PROGRESS,
        failure_stage: stage,
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  const recoverable = api.pendingRetrieval && api.outputFile !== null;
  if (!api.recordingActive && !recoverable) {
    throw new FailureError(
      `No active screen recording on device ${api.deviceId}. Call \`screen-recording-start\` first.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_NO_ACTIVE_SESSION,
        failure_stage: stage,
        failure_area: "tool_server",
        // Session-state, not caller input — matches the profiler family's
        // "no active session" kind.
        error_kind: "not_found",
      }
    );
  }
}

/**
 * Reject a start whose readiness resumed after the session was disposed
 * (process shutdown). Call synchronously right before spawn, with no await
 * between this check and the spawn/pendingChild stamp, so no capture is
 * launched that dispose's teardown can no longer see and reap.
 */
export function assertNotDisposed(api: ScreenRecordingSessionApi, stage: string): void {
  if (api.disposed) {
    throw new FailureError(
      `The tool-server is shutting down; screen recording was not started on device ${api.deviceId}.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_SERVER_SHUTTING_DOWN,
        failure_stage: stage,
        failure_area: "tool_server",
        error_kind: "unknown",
      }
    );
  }
}

/** Stat the finished video and reject an empty/missing container loudly. */
export async function statNonEmptyOutput(outputFile: string, stage: string): Promise<number> {
  let size: number;
  try {
    size = (await fs.stat(outputFile)).size;
  } catch (err) {
    throw new FailureError(
      `The recording ended but no video file exists at ${outputFile}.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
        failure_stage: stage,
        failure_area: "tool_server",
        error_kind: "not_found",
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  if (size === 0) {
    throw new FailureError(`The recording ended but the video file at ${outputFile} is empty.`, {
      error_code: FAILURE_CODES.SCREEN_RECORDING_OUTPUT_MISSING,
      failure_stage: stage,
      failure_area: "tool_server",
      error_kind: "not_found",
    });
  }
  return size;
}
