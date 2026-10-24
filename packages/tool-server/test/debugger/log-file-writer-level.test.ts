import { describe, it, expect, afterEach } from "vitest";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-log-level-home-");

/**
 * The log file stores the level uppercased and padded to 5 chars. readAll() and
 * readFiltered() must still return the exact CDP level: longer ones such as
 * "warning" (console.warn) and "assert" are never truncated, and camelCase ones
 * such as "startGroup" keep their casing.
 */
let w: LogFileWriter;
afterEach(() => {
  if (w) w.close();
});

describe("LogFileWriter round-trips levels of any length and casing", () => {
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

  it("preserves short levels padded to 5 chars", () => {
    w = new LogFileWriter(59233);
    w.write({
      id: 0,
      timestamp: new Date(1710000000000).toISOString(),
      level: "trace",
      message: "z",
    });
    expect(w.readAll()[0]!.level).toBe("trace");
  });

  it("preserves camelCase CDP levels through readAll() and readFiltered()", () => {
    const levels = ["startGroup", "startGroupCollapsed", "endGroup", "profileEnd", "timeEnd"];
    w = new LogFileWriter(59235);
    levels.forEach((level, id) =>
      w.write({ id, timestamp: new Date(1710000000000).toISOString(), level, message: "c" })
    );
    expect(w.readAll().map((e) => e.level)).toEqual(levels);
    for (const level of levels) {
      expect(w.readFiltered({ level }).total).toBe(1);
    }
  });
});
