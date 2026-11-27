import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as v8 from "node:v8";
import * as vm from "node:vm";
import { Registry } from "@argent/registry";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-log-registry-home-");

let writer: LogFileWriter;

function writeLog(id: number, opts: { level?: string; message?: string } = {}) {
  return writer.write({
    id,
    timestamp: new Date(1710000000000 + id * 1000).toISOString(),
    level: opts.level ?? "log",
    message: opts.message ?? `Message ${id}`,
  });
}

describe("Log Registry recent entries", () => {
  beforeEach(() => {
    writer = new LogFileWriter(8082);
  });

  afterEach(() => {
    writer.close();
  });

  it("returns the newest entries, oldest first", () => {
    for (let i = 0; i < 30; i++) writeLog(i, { level: i % 2 ? "error" : "log" });

    const recent = writer.getRecent(20);
    expect(recent.map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 10));
    expect(recent[19]).toEqual({
      id: 29,
      timestamp: new Date(1710000000000 + 29 * 1000).toISOString(),
      level: "error",
      message: "Message 29",
    });
  });

  it("filters by level and keeps a warning buried under many logs", () => {
    writeLog(0, { level: "error" });
    for (let i = 1; i <= 150; i++) writeLog(i);
    writeLog(151, { level: "warning" });

    expect(writer.getRecent(5, ["warning", "error"]).map((e) => e.id)).toEqual([0, 151]);
    expect(writer.getRecent(5, ["error", "error"]).map((e) => e.id)).toEqual([0]);
    expect(writer.getRecent(1000, ["log"])).toHaveLength(100);
  });

  it("orders entries of different levels by id when timestamps tie", () => {
    const timestamp = new Date(1710000000000).toISOString();
    writer.write({ id: 0, timestamp, level: "log", message: "first" });
    writer.write({ id: 1, timestamp, level: "error", message: "second" });
    writer.write({ id: 2, timestamp, level: "log", message: "third" });

    expect(writer.getRecent(3).map((e) => e.message)).toEqual(["first", "second", "third"]);
  });

  it("cuts long messages without splitting a surrogate pair", () => {
    writeLog(0, { message: "a".repeat(300) });
    writeLog(1, { message: "b".repeat(301) });
    writeLog(2, { message: "x".repeat(298) + "😀tail" });

    const [exact, cut, cutBeforeEmoji] = writer.getRecent(3);
    expect(exact.message).toBe("a".repeat(300));
    expect(cut.message).toBe("b".repeat(299) + "…");
    expect(cutBeforeEmoji.message).toBe("x".repeat(298) + "…");
  });

  it("keeps the line breaks of a multi-line message", () => {
    writeLog(0, { message: "first line\nsecond line" });

    expect(writer.getRecent(1)[0].message).toBe("first line\nsecond line");
  });

  it("stops recording entries at the 50,000-entry cap, with the stats", () => {
    for (let i = 0; i <= 50_000; i++) writeLog(i);

    expect(writer.getStats().totalEntries).toBe(50_000);
    expect(writer.getRecent(1)[0].id).toBe(49_999);
  });

  it("does not keep the full long messages alive", () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const heapAfterGc = () => {
      gc();
      return process.memoryUsage().heapUsed;
    };
    const prefix = "p".repeat(80);
    const before = heapAfterGc();
    for (let i = 0; i < 50; i++) {
      writeLog(i, { message: `${prefix}${String(i).padEnd(1_000_000, "x")}` });
    }

    expect(heapAfterGc() - before).toBeLessThan(10_000_000);
  });

  it("validates tail and levels", () => {
    const tool = createDebuggerLogRegistryTool(new Registry());
    const parse = (extra: object) => tool.zodSchema!.safeParse({ device_id: "d", ...extra });

    expect(parse({ tail: "5" }).data?.tail).toBe(5);
    expect(parse({ tail: 0 }).success).toBe(false);
    expect(parse({ tail: 101 }).success).toBe(false);
    expect(parse({ levels: ["warning"] }).success).toBe(true);
    expect(parse({ levels: ["warn"] }).success).toBe(false);
    expect(parse({ levels: [] }).success).toBe(false);
  });
});
