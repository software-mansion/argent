import { describe, it, expect } from "vitest";
import { consoleTimestampToIso } from "../../src/utils/debugger/console-timestamp";

/**
 * Regression for the RN log timestamp corruption: CDP `consoleAPICalled.timestamp`
 * is milliseconds-since-epoch on Hermes/React Native (jsinspector-modern's
 * getTimestampMs is std::chrono::duration<double, std::milli>), exactly as on
 * Chrome. The RN blueprint used to do `new Date(entry.timestamp * 1000)`, which
 * assumed seconds and stamped every flat-log line with a year-58473 date. Both
 * blueprints now share this helper so their log files agree and cannot re-diverge.
 */
describe("consoleTimestampToIso", () => {
  it("treats the CDP timestamp as milliseconds and preserves the instant", () => {
    // A realistic Hermes/Chrome value: system_clock::now() in ms, i.e. Date.now().
    const ms = 1_783_000_000_000; // 2026-07-01T...Z
    const iso = consoleTimestampToIso(ms);
    expect(iso).toBe(new Date(ms).toISOString());
    // Round-trips to the exact same instant — no scaling.
    expect(new Date(iso).getTime()).toBe(ms);
    // The current-millennium year, NOT the year-58473 corruption.
    expect(new Date(iso).getUTCFullYear()).toBe(2026);
  });

  it("does NOT reintroduce the * 1000 corruption (far-future year)", () => {
    // Guards the exact bug: the pre-fix `new Date(ms * 1000)` interpreted a real
    // ms timestamp as seconds, landing ~56000 years in the future (the reviewer
    // observed year 58473 on-device). Prove that (a) the helper keeps it in the
    // current millennium, and (b) the buggy multiply would have blown it up.
    const ms = 1_783_000_000_000;
    expect(new Date(consoleTimestampToIso(ms)).getUTCFullYear()).toBeLessThan(3000);
    expect(new Date(ms * 1000).getUTCFullYear()).toBeGreaterThan(50000); // the corruption, for reference
  });

  it("round-trips a live Date.now() to the current year", () => {
    const now = Date.now();
    const iso = consoleTimestampToIso(now);
    expect(new Date(iso).getTime()).toBe(now);
    expect(new Date(iso).getUTCFullYear()).toBe(new Date(now).getUTCFullYear());
  });

  it("coerces a non-finite timestamp to a valid ISO string instead of throwing", () => {
    // new Date(NaN).toISOString() throws RangeError; inside the typed-emitter
    // listener that would silently drop the log entry. The helper must never throw.
    for (const bad of [NaN, Infinity, -Infinity]) {
      const before = Date.now();
      const iso = consoleTimestampToIso(bad);
      const after = Date.now();
      const t = new Date(iso).getTime();
      expect(Number.isNaN(t)).toBe(false);
      // Fell back to "now".
      expect(t).toBeGreaterThanOrEqual(before);
      expect(t).toBeLessThanOrEqual(after);
    }
  });
});
