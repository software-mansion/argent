/**
 * Convert a CDP `Runtime.consoleAPICalled` timestamp to an ISO-8601 string for
 * the flat log file, shared by the React Native and Chromium debugger blueprints
 * so their log files cannot diverge.
 *
 * CDP's `Runtime.Timestamp` is "number of milliseconds since epoch" on BOTH
 * Chrome and Hermes/React Native: RN's jsinspector-modern stamps every console
 * message with `getTimestampMs()` (`std::chrono::duration<double, std::milli>`,
 * ReactCommon/jsinspector-modern/RuntimeTargetConsole.cpp) and forwards it onto
 * the CDP `timestamp` field unchanged. It is therefore passed to `new Date`
 * UNMULTIPLIED — an earlier `* 1000` on the RN path assumed seconds and stamped
 * every log line with a year-58473 date.
 *
 * A value `new Date(...).toISOString()` cannot represent is coerced to now so the
 * helper never throws: that call throws RangeError both for a non-finite value
 * and for a finite one outside Date's ±8.64e15 ms range (a CDP-server bug or a
 * future protocol revision could hand us either), and it runs inside a
 * typed-emitter listener that try/catches its listeners, so an uncaught throw
 * would silently drop the log entry.
 */
const MAX_TIMESTAMP_MS = 8.64e15; // Date's representable range is ±8.64e15 ms from the epoch.

export function consoleTimestampToIso(rawTimestampMs: number): string {
  const usable = Number.isFinite(rawTimestampMs) && Math.abs(rawTimestampMs) <= MAX_TIMESTAMP_MS;
  return new Date(usable ? rawTimestampMs : Date.now()).toISOString();
}
