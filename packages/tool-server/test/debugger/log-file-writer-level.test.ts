import { describe, it, expect, afterEach } from "vitest";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";

/**
 * Regression for level truncation: CDP emits console levels longer than 5 chars
 * ("warning" from console.warn, "assert" from console.assert) that are not in
 * LEVEL_DISPLAY. The old fallback `.padEnd(5).slice(0, 5)` truncated them to
 * "warni"/"asser", so readAll()/readFiltered() returned the wrong level and
 * filtering by the canonical level found nothing. The level must round-trip
 * exactly for levels of any length while short levels keep working as before.
 */
let w: LogFileWriter;
afterEach(() => {
  if (w) w.close();
});

describe("LogFileWriter round-trips levels of any length", () => {
  it("preserves 'warning' through readAll()", () => {
    w = new LogFileWriter(59231);
    w.write({
      id: 0,
      timestamp: new Date(1710000000000).toISOString(),
      level: "warning",
      message: "x",
    });
    expect(w.readAll()[0]!.level).toBe("warning");
  });

  it("filters by the canonical multi-char level 'warning'", () => {
    // The exact behavior this change restores: filtering by the full CDP level.
    // With the old `.slice(0, 5)` the persisted level was "warni", so a filter
    // for "warning" matched nothing (total === 0).
    w = new LogFileWriter(59234);
    w.write({
      id: 0,
      timestamp: new Date(1710000000000).toISOString(),
      level: "warning",
      message: "x",
    });
    const { total, entries } = w.readFiltered({ level: "warning" });
    expect(total).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("warning");
  });

  it("filters by 'assert'", () => {
    w = new LogFileWriter(59232);
    w.write({
      id: 0,
      timestamp: new Date(1710000000000).toISOString(),
      level: "assert",
      message: "y",
    });
    const { total, entries } = w.readFiltered({ level: "assert" });
    expect(total).toBe(1);
    expect(entries).toHaveLength(1);
  });

  it("still preserves short levels that hit the padEnd fallback", () => {
    // "trace" is a real CDP level (console.trace) that is NOT in LEVEL_DISPLAY, so
    // it exercises the changed `.toUpperCase().padEnd(5)` fallback — unlike "warn",
    // which the map short-circuits. A <=5-char level must still round-trip exactly.
    w = new LogFileWriter(59233);
    w.write({
      id: 0,
      timestamp: new Date(1710000000000).toISOString(),
      level: "trace",
      message: "z",
    });
    expect(w.readAll()[0]!.level).toBe("trace");
  });
});
