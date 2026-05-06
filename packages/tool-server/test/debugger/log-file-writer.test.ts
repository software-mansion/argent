import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { LogFileWriter, type RichLogEntry } from "../../src/utils/debugger/log-file-writer";

let writer: LogFileWriter;

function makeEntry(id: number, overrides: Partial<Omit<RichLogEntry, "marker">> = {}) {
  return {
    id,
    timestamp: new Date(1710000000000 + id * 1000).toISOString(),
    level: overrides.level ?? "log",
    message: overrides.message ?? `Log message ${id}`,
    stackTrace: overrides.stackTrace,
  };
}

describe("LogFileWriter", () => {
  beforeEach(() => {
    writer = new LogFileWriter(9999);
  });

  afterEach(() => {
    writer.close();
  });

  it("creates a flat log file in ~/.argent/tmp", () => {
    const filePath = writer.getFilePath();
    // path separator is platform-dependent (`/` on POSIX, `\` on Windows);
    // a regex character class accepts either so the test stays portable.
    expect(filePath).toMatch(/\.argent[\\/]tmp[\\/]argent-logs-9999-\d+\.log$/);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("writes entries as flat text lines", () => {
    writer.write(makeEntry(0));
    writer.write(makeEntry(1));

    const content = fs.readFileSync(writer.getFilePath(), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);

    expect(lines[0]).toMatch(/^\[L:0\] .+ LOG\s+- \| Log message 0$/);
    expect(lines[1]).toMatch(/^\[L:1\] .+ LOG\s+- \| Log message 1$/);
  });

  it("returns RichLogEntry with marker from write()", () => {
    const result = writer.write(makeEntry(0));
    expect(result.marker).toBe("[L:0]");

    const result2 = writer.write(makeEntry(1));
    expect(result2.marker).toBe("[L:1]");
  });

  it("tracks stats correctly", () => {
    writer.write(makeEntry(0, { level: "log" }));
    writer.write(makeEntry(1, { level: "warn" }));
    writer.write(makeEntry(2, { level: "error" }));
    writer.write(makeEntry(3, { level: "log" }));

    const stats = writer.getStats();
    expect(stats.totalEntries).toBe(4);
    expect(stats.byLevel).toEqual({ log: 2, warn: 1, error: 1 });
    expect(stats.fileSizeBytes).toBeGreaterThan(0);
    expect(stats.file).toBe(writer.getFilePath());
  });

  it("clusters messages by first 80 chars", () => {
    for (let i = 0; i < 10; i++) {
      writer.write(makeEntry(i, { message: "Repeated message" }));
    }
    writer.write(makeEntry(10, { message: "Unique message" }));

    const clusters = writer.getClusters();
    expect(clusters).toHaveLength(2);
    expect(clusters[0].message).toBe("Repeated message");
    expect(clusters[0].count).toBe(10);
    expect(clusters[0].firstId).toBe(0);
    expect(clusters[0].lastId).toBe(9);
    expect(clusters[1].message).toBe("Unique message");
    expect(clusters[1].count).toBe(1);
  });

  it("limits clusters to requested count", () => {
    for (let i = 0; i < 30; i++) {
      writer.write(makeEntry(i, { message: `msg-${i}` }));
    }
    const clusters = writer.getClusters(5);
    expect(clusters).toHaveLength(5);
  });

  it("includes source info in clusters from stack trace", () => {
    writer.write(
      makeEntry(0, {
        message: "From source",
        stackTrace: {
          callFrames: [
            {
              functionName: "fetchUser",
              scriptId: "1",
              url: "http://localhost:8081/src/api/user.ts?platform=ios",
              lineNumber: 42,
              columnNumber: 10,
            },
          ],
        },
      })
    );

    const clusters = writer.getClusters();
    expect(clusters[0].sourceFile).toBe("src/api/user.ts");
    expect(clusters[0].sourceLine).toBe(42);
  });

  it("readAll() returns all written entries", () => {
    writer.write(makeEntry(0));
    writer.write(makeEntry(1));
    writer.write(makeEntry(2));

    const entries = writer.readAll();
    expect(entries).toHaveLength(3);
    expect(entries[0].id).toBe(0);
    expect(entries[2].id).toBe(2);
  });

  it("readFiltered() filters by level", () => {
    writer.write(makeEntry(0, { level: "log" }));
    writer.write(makeEntry(1, { level: "error" }));
    writer.write(makeEntry(2, { level: "log" }));
    writer.write(makeEntry(3, { level: "error" }));

    const { entries, total } = writer.readFiltered({ level: "error" });
    expect(total).toBe(2);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.level === "error")).toBe(true);
  });

  it("readFiltered() limits results to last N", () => {
    for (let i = 0; i < 10; i++) {
      writer.write(makeEntry(i));
    }

    const { entries, total } = writer.readFiltered({ limit: 3 });
    expect(total).toBe(10);
    expect(entries).toHaveLength(3);
    expect(entries[0].id).toBe(7);
    expect(entries[2].id).toBe(9);
  });

  it("readFiltered() combines level and limit", () => {
    for (let i = 0; i < 10; i++) {
      writer.write(makeEntry(i, { level: i % 2 === 0 ? "error" : "log" }));
    }

    const { entries, total } = writer.readFiltered({ level: "error", limit: 2 });
    expect(total).toBe(5);
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.level === "error")).toBe(true);
  });

  it("close() deletes the file", () => {
    const filePath = writer.getFilePath();
    expect(fs.existsSync(filePath)).toBe(true);

    writer.close();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("close() is idempotent", () => {
    writer.close();
    expect(() => writer.close()).not.toThrow();
  });

  it("write() throws after close", () => {
    writer.close();
    expect(() => writer.write(makeEntry(0))).toThrow("LogFileWriter is closed");
  });

  it("readAll() returns empty after close", () => {
    writer.write(makeEntry(0));
    writer.close();
    expect(writer.readAll()).toEqual([]);
  });

  it("stackTrace is NOT persisted to flat file but sourceFile IS in cluster", () => {
    const stackTrace = {
      callFrames: [
        {
          functionName: "render",
          scriptId: "5",
          url: "http://localhost:8081/src/App.tsx",
          lineNumber: 10,
          columnNumber: 5,
        },
      ],
    };
    writer.write(makeEntry(0, { stackTrace }));

    // readAll() reconstructs from flat file — no stackTrace
    const entries = writer.readAll();
    expect(entries[0].stackTrace).toBeUndefined();

    // But source attribution is still available via in-memory clusters
    const clusters = writer.getClusters();
    expect(clusters[0].sourceFile).toBe("src/App.tsx");
    expect(clusters[0].sourceLine).toBe(10);
  });

  it("collapses newlines in message to spaces in flat file", () => {
    writer.write(makeEntry(0, { message: "Error:\nstacktrace here" }));

    const content = fs.readFileSync(writer.getFilePath(), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Error: stacktrace here");
  });

  it("bundle URL as sourceFile → cluster.sourceFile is undefined", () => {
    writer.write(
      makeEntry(0, {
        message: "Bundle source",
        stackTrace: {
          callFrames: [
            {
              functionName: "",
              scriptId: "1",
              url: "http://localhost:8081/index.bundle?platform=ios&dev=true",
              lineNumber: 1,
              columnNumber: 0,
            },
          ],
        },
      })
    );

    const clusters = writer.getClusters();
    expect(clusters[0].sourceFile).toBeUndefined();
  });

  it("valid source URL → cluster.sourceFile is clean relative path (no port, no query)", () => {
    writer.write(
      makeEntry(0, {
        message: "API call",
        stackTrace: {
          callFrames: [
            {
              functionName: "fetchUser",
              scriptId: "1",
              url: "http://localhost:8081/src/api/user.ts?platform=ios",
              lineNumber: 42,
              columnNumber: 10,
            },
          ],
        },
      })
    );

    const clusters = writer.getClusters();
    expect(clusters[0].sourceFile).toBe("src/api/user.ts");
  });
});
