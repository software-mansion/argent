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

export function assertNoActiveRecording(api: ScreenRecordingSessionApi, stage: string): void {
  if (api.recordingActive) {
    throw new FailureError(
      `A screen recording is already running on device ${api.deviceId} ` +
        `(started ${api.wallClockStartMs ? Math.round((Date.now() - api.wallClockStartMs) / 1000) : "?"}s ago). ` +
        `Call \`screen-recording-stop\` first.`,
      {
        error_code: FAILURE_CODES.SCREEN_RECORDING_ALREADY_ACTIVE,
        failure_stage: stage,
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
}

/**
 * Stop is valid while the capture runs, and also after it ended on its own
 * (time limit, crash) with a file still to hand over — the "finalized,
 * awaiting retrieval" recovery the reminder note keeps pointing at.
 */
export function assertStoppableSession(api: ScreenRecordingSessionApi, stage: string): void {
  const recoverable =
    (api.recordingTimedOut || api.recordingExitedUnexpectedly) && api.outputFile !== null;
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
