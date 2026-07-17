import { promises as fs } from "fs";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { ScreenRecordingSessionApi } from "../../../blueprints/screen-recording-session";

export interface StartRecordingResult {
  status: "recording";
  /** Cap actually applied (Android clamps to screenrecord's 180s maximum). */
  timeLimitSeconds: number;
  /** Host path the finished video will land at once stop is called. */
  outputFile: string;
}

export interface StopRecordingFile {
  /** Host path of the finalized video (registered as an artifact by the tool). */
  outputFile: string;
  sizeBytes: number;
  /** Wall-clock capture length; null when the session lost its start stamp. */
  durationMs: number | null;
  warning?: string;
}

/** Cap what device/subprocess output gets interpolated into failure messages. */
export function clip(s: string, max = 300): string {
  const t = s.trim();
  if (!t) return "<empty>";
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/**
 * Reject a start while a capture is live OR while another start/stop is
 * mid-flight on the same session. The pending flags are set synchronously
 * before the first await of start/stop, closing the check-then-stamp gap that
 * would otherwise let two overlapping calls both pass this guard and
 * cross-corrupt the shared session state.
 */
export function assertNoActiveRecording(api: ScreenRecordingSessionApi, stage: string): void {
  if (api.recordingActive || api.startPending || api.stopPending) {
    const detail = api.recordingActive
      ? `A screen recording is already running on device ${api.deviceId} ` +
        `(started ${api.wallClockStartMs ? Math.round((Date.now() - api.wallClockStartMs) / 1000) : "?"}s ago). ` +
        `Call \`screen-recording-stop\` first.`
      : api.stopPending
        ? `A screen-recording-stop is still finalizing on device ${api.deviceId}. ` +
          `Wait for it to return before starting a new recording.`
        : `Another screen-recording-start is already in flight on device ${api.deviceId}.`;
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
 * concurrent finalize/pull sequences would race into the same host file.
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
