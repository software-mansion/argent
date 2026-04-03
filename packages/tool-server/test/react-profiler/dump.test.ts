import { describe, it, expect, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDebugDir,
  writeDump,
  writeDumpCompact,
  readCpuProfile,
  readCommitTree,
} from "../../src/utils/react-profiler/debug/dump";

const DEBUG_DIR = join(tmpdir(), "argent-profiler-cwd");

afterEach(async () => {
  // Clean up any files written during tests, but leave the directory itself
  // (it may already exist on the system — don't remove it wholesale).
  vi.restoreAllMocks();
});

// ── getDebugDir ────────────────────────────────────────────────────────

describe("getDebugDir", () => {
  it("takes no arguments", async () => {
    // TypeScript would fail to compile if the signature required args,
    // but verify at runtime too.
    const dir = await getDebugDir();
    expect(typeof dir).toBe("string");
  });

  it("returns a path inside os.tmpdir()", async () => {
    const dir = await getDebugDir();
    expect(dir).toBe(join(tmpdir(), "argent-profiler-cwd"));
  });

  it("creates the directory on disk", async () => {
    const dir = await getDebugDir();
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("is idempotent — succeeds even if directory already exists", async () => {
    await getDebugDir();
    // Second call must not throw.
    await expect(getDebugDir()).resolves.toBe(DEBUG_DIR);
  });

  it("never writes inside the current working directory", async () => {
    const dir = await getDebugDir();
    expect(dir.startsWith(process.cwd())).toBe(false);
  });
});

// ── writeDump ─────────────────────────────────────────────────────────

describe("writeDump", () => {
  it("writes pretty-printed JSON and returns the file path", async () => {
    const dir = await getDebugDir();
    const data = { hello: "world", n: 42 };
    const filePath = await writeDump(dir, "test-dump.json", data);

    expect(filePath).toBe(join(dir, "test-dump.json"));
    const raw = await fs.readFile(filePath!, "utf8");
    expect(JSON.parse(raw)).toEqual(data);
    // Pretty-printed: should contain newlines and indentation.
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");

    await fs.unlink(filePath!);
  });

  it("serialises Map values as plain objects", async () => {
    const dir = await getDebugDir();
    const data = { m: new Map([["a", 1], ["b", 2]]) };
    const filePath = await writeDump(dir, "test-map.json", data);

    const raw = await fs.readFile(filePath!, "utf8");
    expect(JSON.parse(raw)).toEqual({ m: { a: 1, b: 2 } });

    await fs.unlink(filePath!);
  });

  it("returns null and does not throw when the directory does not exist", async () => {
    const result = await writeDump("/nonexistent/path", "out.json", {});
    expect(result).toBeNull();
  });
});

// ── writeDumpCompact ──────────────────────────────────────────────────

describe("writeDumpCompact", () => {
  it("writes compact JSON (no indentation) and returns the file path", async () => {
    const dir = await getDebugDir();
    const data = { hello: "world", n: 42 };
    const filePath = await writeDumpCompact(dir, "test-compact.json", data);

    expect(filePath).toBe(join(dir, "test-compact.json"));
    const raw = await fs.readFile(filePath!, "utf8");
    expect(JSON.parse(raw)).toEqual(data);
    // Compact: single line, no indentation.
    expect(raw.trim().split("\n")).toHaveLength(1);

    await fs.unlink(filePath!);
  });

  it("compact output is smaller than pretty-printed for the same data", async () => {
    const dir = await getDebugDir();
    const data = { key: "value", nested: { a: 1, b: 2, c: [1, 2, 3] } };

    const prettyPath = await writeDump(dir, "cmp-pretty.json", data);
    const compactPath = await writeDumpCompact(dir, "cmp-compact.json", data);

    const prettySize = (await fs.stat(prettyPath!)).size;
    const compactSize = (await fs.stat(compactPath!)).size;
    expect(compactSize).toBeLessThan(prettySize);

    await fs.unlink(prettyPath!);
    await fs.unlink(compactPath!);
  });

  it("serialises Map values as plain objects", async () => {
    const dir = await getDebugDir();
    const data = { m: new Map([["x", 10]]) };
    const filePath = await writeDumpCompact(dir, "test-map-compact.json", data);

    const raw = await fs.readFile(filePath!, "utf8");
    expect(JSON.parse(raw)).toEqual({ m: { x: 10 } });

    await fs.unlink(filePath!);
  });

  it("returns null and does not throw when the directory does not exist", async () => {
    const result = await writeDumpCompact("/nonexistent/path", "out.json", {});
    expect(result).toBeNull();
  });
});

// ── readCpuProfile ────────────────────────────────────────────────────

describe("readCpuProfile", () => {
  it("reads and parses a CPU profile written by writeDumpCompact", async () => {
    const dir = await getDebugDir();
    const profile = {
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "foo",
            scriptId: "1",
            url: "index.js",
            lineNumber: 1,
            columnNumber: 0,
          },
          hitCount: 5,
        },
      ],
      startTime: 1000,
      endTime: 2000,
      samples: [1],
      timeDeltas: [1000],
    };

    const filePath = await writeDumpCompact(dir, "cpu-profile.json", profile);
    const read = await readCpuProfile(filePath!);

    expect(read.startTime).toBe(1000);
    expect(read.endTime).toBe(2000);
    expect(read.nodes[0]?.callFrame.functionName).toBe("foo");
    expect(read.samples).toEqual([1]);

    await fs.unlink(filePath!);
  });

  it("throws when the file does not exist", async () => {
    await expect(
      readCpuProfile("/nonexistent/cpu.json"),
    ).rejects.toThrow();
  });
});

// ── readCommitTree ────────────────────────────────────────────────────

describe("readCommitTree", () => {
  it("reads and parses a commit tree written by writeDumpCompact", async () => {
    const dir = await getDebugDir();
    const tree = {
      commits: [
        {
          commitIndex: 0,
          timestamp: 100,
          componentName: "App",
          actualDuration: 5,
          selfDuration: 2,
          commitDuration: 5,
          didRender: true,
          changeDescription: null,
        },
      ],
      meta: {
        detectedArchitecture: "bridgeless" as const,
        anyCompilerOptimized: false,
        hotCommitIndices: [0],
        totalReactCommits: 1,
      },
    };

    const filePath = await writeDumpCompact(dir, "commit-tree.json", tree);
    const read = await readCommitTree(filePath!);

    expect(read.commits).toHaveLength(1);
    expect(read.commits[0]?.componentName).toBe("App");
    expect(read.meta?.detectedArchitecture).toBe("bridgeless");
    expect(read.meta?.hotCommitIndices).toEqual([0]);

    await fs.unlink(filePath!);
  });

  it("handles a commit tree without meta", async () => {
    const dir = await getDebugDir();
    const tree = { commits: [] };
    const filePath = await writeDumpCompact(dir, "commit-tree-bare.json", tree);
    const read = await readCommitTree(filePath!);

    expect(read.commits).toEqual([]);
    expect(read.meta).toBeUndefined();

    await fs.unlink(filePath!);
  });

  it("throws when the file does not exist", async () => {
    await expect(
      readCommitTree("/nonexistent/commits.json"),
    ).rejects.toThrow();
  });
});
