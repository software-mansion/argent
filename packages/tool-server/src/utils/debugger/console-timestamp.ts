/**
 * CDP `Runtime.consoleAPICalled` timestamp -> ISO-8601 for the log file, shared by the
 * React Native and Chromium debugger blueprints so their logs cannot diverge.
 *
 * The timestamp is milliseconds since epoch on Hermes/React Native as on Chrome, so it
 * goes to `new Date` unmultiplied; an earlier `* 1000` on the RN path assumed seconds
 * and dated every log line to year 58473.
 *
 * Values `toISOString()` cannot represent — non-finite, or finite but out of Date's
 * range — fall back to now: this runs inside a typed-emitter listener that swallows
 * listener throws, so a RangeError would drop the log entry.
 */
const MAX_TIMESTAMP_MS = 8.64e15; // Date's representable range from the epoch.

export function consoleTimestampToIso(rawTimestampMs: number): string {
  const usable = Number.isFinite(rawTimestampMs) && Math.abs(rawTimestampMs) <= MAX_TIMESTAMP_MS;
  return new Date(usable ? rawTimestampMs : Date.now()).toISOString();
}
