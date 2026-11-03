import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";
import { profilerCpuQueryTool } from "../../src/tools/profiler/query/profiler-cpu-query";
import { reactProfilerCpuSummaryTool } from "../../src/tools/profiler/react/react-profiler-cpu-summary";

/**
 * profiler-cpu-query took over react-profiler-cpu-summary's `react_only` filter
 * and Self % column when cpu-summary was hidden from MCP.
 */

const PORT = 18_081;
const DEVICE = "cpu-query-react-only";

const NODES = [
  { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2, 3, 4, 5] },
  { id: 2, callFrame: { functionName: "(idle)", url: "", lineNumber: -1 }, children: [] },
  { id: 3, callFrame: { functionName: "formatDate", url: "/app/utils.js", lineNumber: 4 } },
  { id: 4, callFrame: { functionName: "FeedRow", url: "/app/FeedRow.js", lineNumber: 12 } },
  { id: 5, callFrame: { functionName: "App", url: "/app/App.js", lineNumber: 1 } },
];

/**
 * 100 one-millisecond samples after a zero-length first one: 50 idle,
 * 30 formatDate, 15 FeedRow, 5 App. So 100ms covered, of which 50ms idle.
 */
function profile(nodeIds: number[]) {
  return {
    nodes: NODES,
    samples: [2, ...nodeIds],
    timeDeltas: [0, ...nodeIds.map(() => 1000)],
    startTime: 1_000_000,
    endTime: 1_000_000 + nodeIds.length * 1000,
  };
}

const MIXED = [
  ...new Array(50).fill(2),
  ...new Array(30).fill(3),
  ...new Array(15).fill(4),
  ...new Array(5).fill(5),
];

let dir: string;

async function store(nodeIds: number[]): Promise<void> {
  const cpuProfilePath = path.join(dir, "cpu.json");
  await fs.writeFile(cpuProfilePath, JSON.stringify(profile(nodeIds)));
  cacheProfilerPaths(
    PORT,
    {
      sessionId: "s",
      debugDir: dir,
      cpuProfilePath,
      commitsPath: null,
      cpuSampleIndexPath: null,
      detectedArchitecture: null,
      anyCompilerOptimized: null,
      hotCommitIndices: null,
      totalReactCommits: null,
    },
    DEVICE
  );
}

type Params = Parameters<typeof profilerCpuQueryTool.execute>[1];

/** Parsed like an HTTP call, so the schema defaults (top_n, react_only) apply. */
async function query(args: Record<string, unknown>): Promise<string> {
  const params = profilerCpuQueryTool.zodSchema!.parse({
    port: PORT,
    device_id: DEVICE,
    ...args,
  }) as Params;
  return (await profilerCpuQueryTool.execute({}, params)) as string;
}

const rowOf = (out: string, name: string) =>
  out.split("\n").find((line) => line.startsWith(`| \`${name}\``));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cpu-query-react-only-"));
});

afterEach(async () => {
  clearCachedProfilerPaths(PORT, DEVICE);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("profiler-cpu-query react_only and Self %", () => {
  it("replaces react-profiler-cpu-summary, which is hidden from MCP", () => {
    expect(reactProfilerCpuSummaryTool.hideFromMcp).toBe(true);
    expect(profilerCpuQueryTool.hideFromMcp).toBeUndefined();
  });

  it("lists every function by default, with Self % as a share of the covered time", async () => {
    await store(MIXED);
    const out = await query({ mode: "top_functions" });

    expect(out).toContain("| Function | Self (ms) | Self % | Total (ms) | Location |");
    expect(rowOf(out, "formatDate")).toBe("| `formatDate` | 30 | 30.0% | 30 | app/utils.js:4 |");
    expect(rowOf(out, "FeedRow")).toBe("| `FeedRow` | 15 | 15.0% | 15 | app/FeedRow.js:12 |");
    expect(out).not.toContain("**Filter:**");
    // Idle time is measured, never ranked.
    expect(rowOf(out, "(idle)")).toBeUndefined();
  });

  it("keeps only PascalCase names and applies top_n after the filter", async () => {
    await store(MIXED);
    // formatDate is the top function; a cut before the filter would leave nothing.
    const out = await query({ mode: "top_functions", react_only: true, top_n: 1 });

    expect(out).toContain("**Filter:** React components only (PascalCase function names)");
    expect(rowOf(out, "FeedRow")).toBe("| `FeedRow` | 15 | 15.0% | 15 | app/FeedRow.js:12 |");
    expect(rowOf(out, "formatDate")).toBeUndefined();
    expect(rowOf(out, "App")).toBeUndefined();
  });

  it("applies to time_window too", async () => {
    await store(MIXED);
    // Samples 81-100 cover 80-100ms: 15 FeedRow, 5 App.
    const out = await query({
      mode: "time_window",
      time_window_ms: { start: 80, end: 100 },
      react_only: true,
    });

    expect(rowOf(out, "FeedRow")).toBe("| `FeedRow` | 15 | 75.0% | 15 | app/FeedRow.js:12 |");
    expect(rowOf(out, "App")).toBe("| `App` | 5 | 25.0% | 5 | app/App.js:1 |");
  });

  it("says so when JS ran but no function has a component name", async () => {
    await store([...new Array(10).fill(2), ...new Array(10).fill(3)]);
    const out = await query({ mode: "top_functions", react_only: true });

    expect(out).toContain("has a PascalCase (React component) name");
    expect(out).toContain("without react_only");
    // Not the idle-window explanation: JS did run.
    expect(out).not.toContain("all of them were idle");
  });
});
