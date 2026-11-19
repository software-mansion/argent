import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as v8 from "node:v8";
import * as vm from "node:vm";
import { Registry } from "@argent/registry";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-log-registry-home-");

/**
 * Tests for the debugger-log-registry tool behavior.
 * Since the tool is a thin wrapper over LogFileWriter.getStats(), getClusters() and getRecent(),
 * we test the registry response shape through the LogFileWriter directly.
 */

let writer: LogFileWriter;

function writeLog(id: number, opts: { level?: string; message?: string; stackTrace?: any } = {}) {
  return writer.write({
    id,
    timestamp: new Date(1710000000000 + id * 1000).toISOString(),
    level: opts.level ?? "log",
    message: opts.message ?? `Message ${id}`,
    stackTrace: opts.stackTrace,
  });
}

describe("Log Registry (integration)", () => {
  beforeEach(() => {
    writer = new LogFileWriter(8081);
  });

  afterEach(() => {
    writer.close();
  });

  it("produces a complete registry response shape", () => {
    writeLog(0, { level: "log", message: "Hello" });
    writeLog(1, { level: "error", message: "Oops" });
    writeLog(2, { level: "warn", message: "Watch out" });
    writeLog(3, { level: "log", message: "Hello" });

    const stats = writer.getStats();
    const clusters = writer.getClusters(20);

    // Verify stats shape
    expect(stats.file).toMatch(/\.argent\/tmp\/argent-logs-8081.*\.log$/);
    expect(stats.totalEntries).toBe(4);
    expect(stats.byLevel).toEqual({ log: 2, error: 1, warn: 1 });
    expect(stats.fileSizeBytes).toBeGreaterThan(0);

    // Verify clusters shape
    expect(clusters).toHaveLength(3);
    const helloCl = clusters.find((c) => c.message === "Hello");
    expect(helloCl).toBeDefined();
    expect(helloCl!.count).toBe(2);
    expect(helloCl!.firstId).toBe(0);
    expect(helloCl!.lastId).toBe(3);
    expect(helloCl!.level).toBe("log");
    // Clusters carry no grepPattern field
    expect((helloCl as any).grepPattern).toBeUndefined();
  });

  it("clusters are sorted by count descending", () => {
    for (let i = 0; i < 20; i++) writeLog(i, { message: "frequent" });
    for (let i = 20; i < 25; i++) writeLog(i, { message: "medium" });
    writeLog(25, { message: "rare" });

    const clusters = writer.getClusters();
    expect(clusters[0].message).toBe("frequent");
    expect(clusters[0].count).toBe(20);
    expect(clusters[1].message).toBe("medium");
    expect(clusters[1].count).toBe(5);
    expect(clusters[2].message).toBe("rare");
    expect(clusters[2].count).toBe(1);
  });

  it("includes source attribution from stack traces", () => {
    writeLog(0, {
      message: "Component rendered",
      stackTrace: {
        callFrames: [
          {
            functionName: "App",
            scriptId: "1",
            url: "http://localhost:8081/src/screens/Home.tsx?platform=ios",
            lineNumber: 55,
            columnNumber: 3,
          },
        ],
      },
    });

    const clusters = writer.getClusters();
    expect(clusters[0].sourceFile).toContain("screens/Home.tsx");
    expect(clusters[0].sourceLine).toBe(55);
  });

  it("handles empty log state", () => {
    const stats = writer.getStats();
    expect(stats.totalEntries).toBe(0);
    expect(stats.byLevel).toEqual({});
    expect(stats.fileSizeBytes).toBe(0);

    const clusters = writer.getClusters();
    expect(clusters).toEqual([]);
  });

  it("handles high volume without crashing", () => {
    for (let i = 0; i < 5000; i++) {
      writeLog(i, {
        level: i % 3 === 0 ? "error" : "log",
        message: `msg-${i % 100}`,
      });
    }

    const stats = writer.getStats();
    expect(stats.totalEntries).toBe(5000);
    expect(stats.byLevel.error).toBeGreaterThan(0);

    const clusters = writer.getClusters(20);
    expect(clusters).toHaveLength(20);
    // All 100 unique messages, top 20 by count
    expect(clusters[0].count).toBe(50);
  });

  it("file is readable with standard fs after writes", () => {
    writeLog(0);
    writeLog(1);

    const entries = writer.readAll();
    expect(entries).toHaveLength(2);

    // Flat format: each entry has the marker field for grep anchoring
    expect(entries[0].marker).toBe("[L:0]");
    expect(entries[1].marker).toBe("[L:1]");
  });

  it("profiler-style filtered reads work correctly", () => {
    writeLog(0, { level: "log" });
    writeLog(1, { level: "error" });
    writeLog(2, { level: "warn" });
    writeLog(3, { level: "error" });
    writeLog(4, { level: "log" });

    // Simulates profiler-console-logs behavior
    const { entries, total } = writer.readFiltered({
      level: "error",
      limit: 10,
    });
    expect(total).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries[0].level).toBe("error");
    expect(entries[1].level).toBe("error");
  });

  it("WebSocket replay simulation works", () => {
    writeLog(0, { message: "first" });
    writeLog(1, { message: "second" });

    // Simulates what createConsoleLogServer does on connection
    const replay = writer.readAll();
    expect(replay).toHaveLength(2);
    expect(replay[0].message).toBe("first");
    expect(replay[1].message).toBe("second");

    // Verify entries can be JSON.stringify'd (for ws.send)
    for (const entry of replay) {
      expect(() => JSON.stringify(entry)).not.toThrow();
    }
  });
});

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
    writeLog(1, { message: "x".repeat(299) + "😀tail" });

    const [exact, cut] = writer.getRecent(2);
    expect(exact.message).toBe("a".repeat(300));
    expect(cut.message).toBe("x".repeat(299) + "…");
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
