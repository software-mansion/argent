import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LogFileWriter } from "../../src/utils/debugger/log-file-writer";

/**
 * Tests for the debugger-log-registry tool behavior.
 * Since the tool is a thin wrapper over LogFileWriter.getStats() + getClusters(),
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
    // No grepPattern field — use grep -F '<message>' directly
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
