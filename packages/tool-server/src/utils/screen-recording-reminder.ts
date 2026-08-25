// Module-global (like utils/update-checker) so http.ts can read in-flight
// recordings synchronously on every tool call, without resolving the per-device
// ScreenRecordingSession service. Keyed by device: at most one recording each.

export type ScreenRecordingStatus = "recording" | "finalized";

export interface ActiveScreenRecording {
  deviceId: string;
  startedAtMs: number;
  timeLimitSeconds: number;
  /**
   * "finalized" = the capture ended on its own (time limit, crash) but
   * `screen-recording-stop` has not retrieved the video yet. Both states keep
   * the reminder alive: the agent still owes a stop call.
   */
  status: ScreenRecordingStatus;
  /** Why the capture ended; interpolated mid-sentence, so a readable clause. */
  finalizedReason?: string;
}

const activeRecordings = new Map<string, ActiveScreenRecording>();

export function registerActiveScreenRecording(
  deviceId: string,
  startedAtMs: number,
  timeLimitSeconds: number
): void {
  activeRecordings.set(deviceId, {
    deviceId,
    startedAtMs,
    timeLimitSeconds,
    status: "recording",
  });
}

/**
 * The capture ended without a stop call (cap fired, process died); the entry —
 * and its per-call reminder — stays until `screen-recording-stop` retrieves the
 * file.
 */
export function markScreenRecordingFinalized(deviceId: string, reason: string): void {
  const entry = activeRecordings.get(deviceId);
  if (!entry) return;
  entry.status = "finalized";
  entry.finalizedReason = reason;
}

export function clearActiveScreenRecording(deviceId: string): void {
  activeRecordings.delete(deviceId);
}

export function getActiveScreenRecordings(): ActiveScreenRecording[] {
  return [...activeRecordings.values()];
}

/** Test-only: keeps entries from leaking reminders across cases. */
export function __resetActiveScreenRecordingsForTesting(): void {
  activeRecordings.clear();
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Attached to every tool result while a recording is live (http.ts). Unlike the
 * update note it is never suppressed: a forgotten recording costs disk and a
 * video truncated at the cap, so it repeats until `screen-recording-stop`
 * clears the entry.
 */
export function buildScreenRecordingNote(
  recordings: ActiveScreenRecording[],
  nowMs: number
): string {
  const lines = recordings.map((r) => {
    const stopCall = `call \`screen-recording-stop\` with { "udid": "${r.deviceId}" }`;
    if (r.status === "finalized") {
      return `NOTE: The screen recording on device ${r.deviceId} already ended (${
        r.finalizedReason ?? "the capture stopped on its own"
      }) but its video has not been retrieved yet — ${stopCall} to get the file.`;
    }
    return (
      `NOTE: A screen recording is still running on device ${r.deviceId} ` +
      `(started ${formatElapsed(nowMs - r.startedAtMs)} ago, auto-stops after ${r.timeLimitSeconds}s). ` +
      `Once you have captured what you need, ${stopCall} to finalize and retrieve the video.`
    );
  });
  // The tool-server is shared, so this note also reaches agents that did not
  // start the capture.
  lines.push(
    "(If a recording was started by another agent sharing this tool-server, leave it to them.)"
  );
  return lines.join("\n");
}
