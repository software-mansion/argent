// Process-global view of in-flight screen recordings, read by the HTTP result
// layer on every tool call so the agent is reminded to stop what it started.
// Module-global on purpose (same pattern as utils/update-checker): the state
// must be readable synchronously from http.ts without resolving the per-device
// ScreenRecordingSession service, and a tool-server process owns at most one
// recording per device.

export type ScreenRecordingStatus = "recording" | "finalized";

export interface ActiveScreenRecording {
  deviceId: string;
  startedAtMs: number;
  /** Cap in effect for this capture (already clamped per platform). */
  timeLimitSeconds: number;
  /**
   * "recording" while frames are being captured; "finalized" once the capture
   * ended on its own (time limit, crash) but `screen-recording-stop` has not
   * yet been called to retrieve the video. Either way the agent owes a stop
   * call, so both states keep the reminder alive.
   */
  status: ScreenRecordingStatus;
  /** Why the capture ended, for "finalized" entries (already a readable clause). */
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
 * The capture ended without a stop call (cap fired, process died). Keeps the
 * entry — and therefore the per-call reminder — alive until the agent calls
 * `screen-recording-stop` to retrieve the file. No-op for unknown devices.
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

/** Test-only: drop all entries so cases don't leak reminders across tests. */
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
 * Build the reminder attached to every tool result while a recording is live
 * (see http.ts). Unlike the update note this is NOT rate-limited: forgetting a
 * running recording costs the user disk and a truncated video, so the reminder
 * repeats until `screen-recording-stop` clears the entry.
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
  // The tool-server is shared: every connected client sees this note, not just
  // the one that started the capture. Keep a foreign agent from "helpfully"
  // killing someone else's recording.
  lines.push(
    "(If a recording was started by another agent sharing this tool-server, leave it to them.)"
  );
  return lines.join("\n");
}
