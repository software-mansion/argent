import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LogFileWriter,
  TAIL_MAX,
  TAIL_MESSAGE_CHARS,
  type RichLogEntry,
} from "../../src/utils/debugger/log-file-writer";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-log-writer-home-");

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
    expect(filePath).toMatch(/\.argent\/tmp\/argent-logs-9999-\d+-p\d+\.log$/);
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

  it("merges two messages sharing their first 80 chars, keeping the first arrival's text", () => {
    const shared = "P".repeat(80);
    writer.write(makeEntry(0, { message: `${shared}ALPHA` }));
    writer.write(makeEntry(1, { message: `${shared}BETA` }));

    const clusters = writer.getClusters();
    expect(clusters).toHaveLength(1);
    expect(clusters[0].message).toBe(`${shared}ALPHA`);
    expect(clusters[0].count).toBe(2);
  });

  it("truncates the cluster message to 200 chars, still verbatim in the flat line", () => {
    const long = "L".repeat(311);
    writer.write(makeEntry(0, { message: long }));

    const clusters = writer.getClusters();
    expect(clusters[0].message).toBe(long.slice(0, 200));

    const content = fs.readFileSync(writer.getFilePath(), "utf-8");
    expect(content).toContain(clusters[0].message);
  });

  it("keeps in the cluster message the newlines the flat line collapses", () => {
    writer.write(makeEntry(0, { message: "first line\nsecond line" }));

    const clusters = writer.getClusters();
    expect(clusters[0].message).toBe("first line\nsecond line");

    const content = fs.readFileSync(writer.getFilePath(), "utf-8");
    expect(content).not.toContain(clusters[0].message);
    expect(content).toContain("first line second line");
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

  it("tail() keeps the newest entries of the given levels, oldest first", () => {
    for (let i = 0; i < 10; i++) {
      writer.write(makeEntry(i, { level: i % 2 === 0 ? "error" : "log" }));
    }

    expect(writer.tail({ levels: ["error"], limit: 2 }).map((e) => e.id)).toEqual([6, 8]);
    expect(writer.tail({ limit: 3 }).map((e) => e.id)).toEqual([7, 8, 9]);
  });

  it("tail() still finds an error buried under more than TAIL_MAX logs", () => {
    writer.write(makeEntry(0, { level: "error" }));
    for (let i = 1; i <= TAIL_MAX + 5; i++) writer.write(makeEntry(i));

    expect(writer.tail({ levels: ["error"], limit: 5 }).map((e) => e.id)).toEqual([0]);
    expect(writer.tail({ limit: TAIL_MAX })).toHaveLength(TAIL_MAX);
  });

  it("tail() keeps the newest entries after the file stops at 50,000", () => {
    for (let i = 0; i < 50_003; i++) writer.write(makeEntry(i, { message: "m" }));

    expect(writer.getStats().totalEntries).toBe(50_000);
    expect(writer.getStats().droppedEntries).toBe(3);
    expect(writer.tail({ limit: 3 }).map((e) => e.id)).toEqual([50_000, 50_001, 50_002]);
  });

  it("getStats() leaves droppedEntries out while the file still takes entries", () => {
    writer.write(makeEntry(0));
    expect(writer.getStats()).not.toHaveProperty("droppedEntries");
  });

  it("tail() reads a level listed twice once", () => {
    for (let i = 0; i < 6; i++) writer.write(makeEntry(i, { level: i % 2 ? "error" : "log" }));

    expect(writer.tail({ levels: ["error", "error"], limit: 10 }).map((e) => e.id)).toEqual([
      1, 3, 5,
    ]);
    expect(writer.tail({ levels: ["error", "log", "error"], limit: 4 }).map((e) => e.id)).toEqual([
      2, 3, 4, 5,
    ]);
  });

  it("tail() keeps exactly the newest TAIL_MAX entries of one level", () => {
    for (let i = 0; i < TAIL_MAX + 7; i++) writer.write(makeEntry(i, { level: "error" }));

    const ids = writer.tail({ limit: TAIL_MAX + 7 }).map((e) => e.id);
    expect(ids).toHaveLength(TAIL_MAX);
    expect(ids[0]).toBe(7);
    expect(ids.at(-1)).toBe(TAIL_MAX + 6);
  });

  it("caps tail at 100 entries and 300 chars, the numbers the skills promise", () => {
    expect(TAIL_MAX).toBe(100);
    expect(TAIL_MESSAGE_CHARS).toBe(300);
  });

  it("tail() cuts long messages without splitting a surrogate pair", () => {
    const pad = "x".repeat(TAIL_MESSAGE_CHARS - 1);
    writer.write(makeEntry(0, { message: `${pad}\u{1F600}tail` }));
    writer.write(makeEntry(1, { message: "y".repeat(TAIL_MESSAGE_CHARS + 50) }));

    const [emoji, long] = writer.tail({ limit: 2 }).map((e) => e.message);
    expect(emoji).toBe(`${pad}…`);
    expect(emoji.isWellFormed()).toBe(true);
    expect(long).toBe(`${"y".repeat(TAIL_MESSAGE_CHARS)}…`);
  });

  it("close() deletes the file", () => {
    const filePath = writer.getFilePath();
    expect(fs.existsSync(filePath)).toBe(true);

    writer.close();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  const dayAgo = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
  const twoDaysAgo = (Date.now() - 48 * 60 * 60 * 1000) / 1000;

  it("a new writer deletes a dead process's argent-logs files idle for over 24h, keeping fresher ones", () => {
    const dir = path.dirname(writer.getFilePath());
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const stale = path.join(dir, `argent-logs-1-1-p${deadPid}.log`);
    const fresh = path.join(dir, `argent-logs-2-2-p${deadPid}.log`);
    fs.writeFileSync(stale, "");
    fs.writeFileSync(fresh, "");
    fs.utimesSync(stale, dayAgo - 60, dayAgo - 60);
    fs.utimesSync(fresh, dayAgo + 60, dayAgo + 60);

    new LogFileWriter(9998).close();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("a new writer's sweep spares a live writer's file however long it has been quiet", () => {
    const filePath = writer.getFilePath();
    fs.utimesSync(filePath, twoDaysAgo, twoDaysAgo);

    new LogFileWriter(9998).close();

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("a new writer's sweep spares quiet files of other live processes, signalable or not", () => {
    const dir = path.dirname(writer.getFilePath());
    // pid 1 refuses a non-root signal with EPERM.
    const others = [process.ppid, 1].map((pid) => path.join(dir, `argent-logs-1-1-p${pid}.log`));
    for (const other of others) {
      fs.writeFileSync(other, "");
      fs.utimesSync(other, twoDaysAgo, twoDaysAgo);
    }

    new LogFileWriter(9998).close();

    expect(others.map((other) => fs.existsSync(other))).toEqual([true, true]);
  });

  it("a kept file outlives the sweep for 24h from the close, then is swept", () => {
    const filePath = writer.getFilePath();
    fs.utimesSync(filePath, twoDaysAgo, twoDaysAgo);
    writer.close({ keepFile: true });

    new LogFileWriter(9998).close();
    expect(fs.existsSync(filePath)).toBe(true);

    fs.utimesSync(filePath, twoDaysAgo, twoDaysAgo);
    new LogFileWriter(9998).close();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("constructs when the log directory cannot be listed", () => {
    const dir = path.dirname(writer.getFilePath());
    fs.chmodSync(dir, 0o300);
    try {
      expect(() => new LogFileWriter(9998).close()).not.toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
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

// Mode bits do not bite on Windows, nor for uid 0.
const CAN_MAKE_UNWRITABLE = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!CAN_MAKE_UNWRITABLE)("LogFileWriter whose log file cannot be created", () => {
  let dir: string;
  let unwritableWriter: LogFileWriter;

  beforeEach(() => {
    dir = path.join(os.homedir(), ".argent", "tmp");
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o555);
    unwritableWriter = new LogFileWriter(9998);
  });

  afterEach(() => {
    fs.chmodSync(dir, 0o755);
    unwritableWriter.close();
  });

  it("keeps no copy of a line it could not write", () => {
    unwritableWriter.write(makeEntry(0, { message: "unreadable line" }));

    expect(fs.existsSync(unwritableWriter.getFilePath())).toBe(false);
    expect(unwritableWriter.readAll()).toEqual([]);

    const retainedLines = Object.values(unwritableWriter as unknown as Record<string, unknown>)
      .filter((value): value is unknown[] => Array.isArray(value))
      .flat();
    expect(retainedLines).toEqual([]);

    // The entry itself is still accounted for, through the counts and clusters.
    expect(unwritableWriter.getStats().totalEntries).toBe(1);
    expect(unwritableWriter.getClusters()[0].message).toBe("unreadable line");
  });

  it("still serves the entry through tail()", () => {
    unwritableWriter.write(makeEntry(0, { level: "error", message: "unreadable line" }));

    expect(unwritableWriter.tail({ levels: ["error"], limit: 5 })).toEqual([
      expect.objectContaining({ id: 0, message: "unreadable line" }),
    ]);
  });
});
