import { describe, it, expect, afterEach } from "vitest";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";
import { readLogFile } from "../helpers/read-log-file";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-log-level-home-");

/**
 * CDP emits console levels longer than 5 chars ("warning" from console.warn,
 * "assert" from console.assert). Truncated to 5 they read "WARNI"/"ASSER", and
 * a grep of the log file for the full level finds nothing.
 */
let w: LogFileWriter;
afterEach(() => {
  if (w) w.close();
});

function writeLevel(port: number, level: string) {
  w = new LogFileWriter(port);
  w.write({ id: 0, timestamp: new Date(1710000000000).toISOString(), level, message: "x" });
}

describe("LogFileWriter writes levels of any length in full", () => {
  it("writes 'warning' as WARNING", () => {
    writeLevel(59231, "warning");
    expect(readLogFile(w).map((l) => l.level)).toEqual(["WARNING"]);
  });

  it("writes 'assert' as ASSERT", () => {
    writeLevel(59232, "assert");
    expect(readLogFile(w).map((l) => l.level)).toEqual(["ASSERT"]);
  });

  it("writes a 5-char level as is", () => {
    writeLevel(59233, "trace");
    expect(readLogFile(w).map((l) => l.level)).toEqual(["TRACE"]);
  });
});
