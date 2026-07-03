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
 * A non-finite value (a CDP-server bug or a future protocol revision could hand
 * us one) is coerced to now: `new Date(NaN).toISOString()` throws RangeError, and
 * this runs inside a typed-emitter listener that try/catches its listeners, so an
 * uncaught throw would silently drop the log entry.
 */
export function consoleTimestampToIso(rawTimestampMs: number): string {
  const ms = Number.isFinite(rawTimestampMs) ? rawTimestampMs : Date.now();
  return new Date(ms).toISOString();
}
