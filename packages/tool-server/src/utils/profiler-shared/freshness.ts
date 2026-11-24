/**
 * Trace-freshness signal for native-profiler-analyze.
 *
 * The native profiler session lives for the whole tool-server process, so the
 * analyze and query tools operate on whatever trace was last recorded or
 * loaded — possibly one captured in an earlier working session.
 */

// Recordings are capped at 10 min (RECORDING_CAP_MS) and analysis follows stop
// closely, so a just-recorded session is well under this.
const STALE_AFTER_MS = 30 * 60 * 1000;

function formatAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Markdown warning line when the recording is stale; null when fresh or the
 * capture time is unknown. `nowMs` is injected for testing.
 */
export function formatTraceFreshness(
  capturedAtEpochMs: number | null | undefined,
  nowMs: number
): string | null {
  if (
    !capturedAtEpochMs ||
    !Number.isFinite(capturedAtEpochMs) ||
    Math.abs(capturedAtEpochMs) > 8.64e15
  )
    return null;
  const ageMs = nowMs - capturedAtEpochMs;
  if (ageMs < STALE_AFTER_MS) return null;
  const captured = new Date(capturedAtEpochMs).toISOString();
  return (
    `> ⚠️ **Stale trace:** this recording was captured ${formatAge(ageMs)} ago (${captured}), ` +
    `not in a capture you just made. The profiler session persists for the whole tool-server ` +
    `run, so analyze/query tools reuse the last recording. Re-run ` +
    "`native-profiler-start` → `native-profiler-stop` for current behavior, or ignore this if you " +
    "loaded the trace deliberately."
  );
}
