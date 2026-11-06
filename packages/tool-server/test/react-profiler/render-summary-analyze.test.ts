import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";
import { summarizeRenders } from "../../src/utils/react-profiler/render-summary";
import type {
  DevToolsChangeDescription,
  DevToolsFiberCommit,
} from "../../src/utils/react-profiler/types/input";
import { reactProfilerAnalyzeTool } from "../../src/tools/profiler/react/react-profiler-analyze";
import { redirectTmpdir } from "../helpers/tmpdir-env";

const buildIndex = vi.hoisted(() => vi.fn());

vi.mock("../../src/utils/react-profiler/pipeline/06-resolve/ast-index", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildAstIndexWithDiagnostics: buildIndex,
}));

const PORT = 8081;
const DEVICE = "index-device";

const RERENDER: DevToolsChangeDescription = {
  props: ["now"],
  state: null,
  hooks: [],
  context: false,
  didHooksChange: false,
  isFirstMount: false,
};

function rerender(componentName: string, commitIndex: number, selfDuration: number) {
  return {
    commitIndex,
    timestamp: commitIndex * 20,
    componentName,
    actualDuration: selfDuration,
    selfDuration,
    commitDuration: 5,
    didRender: true,
    changeDescription: RERENDER,
    hookTypes: null,
    parentName: null,
    isCompilerOptimized: false,
  } as DevToolsFiberCommit;
}

let scratch = "";
let restoreTmpdir: () => void = () => {};

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), "argent-render-summary-analyze-"));
  restoreTmpdir = redirectTmpdir(scratch);
  buildIndex.mockReset();
  buildIndex.mockResolvedValue({ index: new Map(), treeSitterAvailable: true });
});

afterEach(async () => {
  restoreTmpdir();
  clearCachedProfilerPaths(PORT, DEVICE);
  await fs.rm(scratch, { recursive: true, force: true });
});

/** A stored session with no hot commit, where `name` re-rendered 100 times in 2 s. */
async function analyze(name: string, selfMs: number): Promise<string> {
  const fibers = Array.from({ length: 100 }, (_, i) => rerender(name, i, selfMs));
  const timings = fibers.map((f) => ({ timestamp: f.timestamp, durationMs: 5 }));
  return runAnalyze({
    meta: { hotCommitIndices: [], renderSummary: summarizeRenders(fibers, timings, 2000) },
    hotCommitIndices: [],
    totalReactCommits: 100,
  });
}

/** Stores a session with no kept commits and runs the real tool on it. */
async function runAnalyze(session: {
  commits?: DevToolsFiberCommit[];
  meta: Record<string, unknown>;
  hotCommitIndices: number[] | null;
  totalReactCommits: number | null;
}): Promise<string> {
  const commitsPath = join(scratch, "commits.json");
  await fs.writeFile(
    commitsPath,
    JSON.stringify({ commits: session.commits ?? [], meta: session.meta })
  );
  cacheProfilerPaths(
    PORT,
    {
      sessionId: DEVICE,
      debugDir: scratch,
      cpuProfilePath: null,
      commitsPath,
      cpuSampleIndexPath: null,
      detectedArchitecture: null,
      anyCompilerOptimized: null,
      hotCommitIndices: session.hotCommitIndices,
      totalReactCommits: session.totalReactCommits,
    },
    DEVICE
  );
  const result = await reactProfilerAnalyzeTool.execute!(
    {},
    { port: PORT, device_id: DEVICE, project_root: scratch, platform: "ios", rn_version: "0.86.0" },
    { artifacts: { register: async () => ({ id: "artifact", kind: "file" }) } } as never
  );
  return (result as { report: string }).report;
}

describe("source index on a session with no hot commit", () => {
  it("is skipped when no component could get a row, so quiet sessions stay fast", async () => {
    // 100 × 0.01 ms in 2 s: 0.5 self ms per second, under the row limit.
    expect(await analyze("Outlet", 0.01)).not.toContain("Frequent Re-renders");
    expect(buildIndex).not.toHaveBeenCalled();
  });

  it("is skipped when names alone rule every row out", async () => {
    expect(await analyze("Text", 1)).not.toContain("Frequent Re-renders");
    expect(buildIndex).not.toHaveBeenCalled();
  });

  it("is built when a row needs it to tell app code from library code", async () => {
    await analyze("ClockRow", 1);
    expect(buildIndex).toHaveBeenCalledOnce();
  });

  it("reaches the classifier: a name the index knows gets a row with its file", async () => {
    buildIndex.mockResolvedValue({
      index: new Map([["ClockRow", { file: "/app/src/Clock.tsx", line: 25 }]]),
      treeSitterAvailable: true,
    });
    const report = await analyze("ClockRow", 1);
    expect(report).toContain("| `ClockRow` |");
    expect(report).toContain("Clock.tsx:25");
  });

  it("keeps the row without a file when tree-sitter is not available", async () => {
    buildIndex.mockResolvedValue({ index: new Map(), treeSitterAvailable: false });
    const report = await analyze("ClockRow", 1);
    expect(report).toContain("| `ClockRow` |");
  });

  it("reaches the classifier: a name the index does not know counts as library", async () => {
    buildIndex.mockResolvedValue({
      index: new Map([["Other", { file: "/app/src/Other.tsx", line: 1 }]]),
      treeSitterAvailable: true,
    });
    expect(await analyze("SomeLibraryRow", 1)).not.toContain("Frequent Re-renders");
  });
});

describe("source index on a hot session", () => {
  it("is built for the File column of the findings", async () => {
    buildIndex.mockResolvedValue({
      index: new Map([["ClockRow", { file: "/app/src/Clock.tsx", line: 25, col: 0 }]]),
      treeSitterAvailable: true,
    });
    const commits = [0, 1, 2, 3].map((i) => ({
      ...rerender("ClockRow", i, 20),
      commitDuration: 30,
    }));
    const report = await runAnalyze({
      commits,
      meta: { hotCommitIndices: [0, 1, 2, 3] },
      hotCommitIndices: [0, 1, 2, 3],
      totalReactCommits: 4,
    });
    expect(buildIndex).toHaveBeenCalledOnce();
    expect(report).toContain("Clock.tsx:25");
  });
});

describe("source index on a hot session with a frequent component outside its findings", () => {
  /** One stored 30 ms commit of `Slow`, and `ClockRow` in 100 commits that were not stored. */
  async function analyzeHot(slowRenders: number): Promise<string> {
    const cheap = Array.from({ length: 100 }, (_, i) => rerender("ClockRow", i, 1));
    const slow = Array.from({ length: slowRenders }, () => ({
      ...rerender("Slow", 100, 20),
      commitDuration: 30,
    }));
    const timings = [...cheap.map(() => 5), 30].map((durationMs, i) => ({
      timestamp: i * 20,
      durationMs,
    }));
    return runAnalyze({
      commits: slow,
      meta: {
        hotCommitIndices: [100],
        renderSummary: summarizeRenders([...cheap, ...slow], timings, 2020),
      },
      hotCommitIndices: [100],
      totalReactCommits: 101,
    });
  }

  it("is built when the hot commit gave no finding, so the row is placed", async () => {
    buildIndex.mockResolvedValue({
      index: new Map([["ClockRow", { file: "/app/src/Clock.tsx", line: 25 }]]),
      treeSitterAvailable: true,
    });
    // One render of `Slow` is under the three a finding needs.
    const report = await analyzeHot(1);
    expect(report).toContain("**Hot commits:** 1 of 101");
    expect(report).not.toContain("## Top Components");
    expect(buildIndex).toHaveBeenCalledOnce();
    expect(report).toContain("App components that re-rendered in at least 10 of the 101 commits");
    expect(report).toContain(
      "| `ClockRow` | 100 | 49.5 | 49.5 | 100.0ms | props: now | `src/Clock.tsx:25` |"
    );
  });

  it("drops a library component from that list, as on a session with no hot commit", async () => {
    buildIndex.mockResolvedValue({
      index: new Map([["Slow", { file: "/app/src/Slow.tsx", line: 1, col: 0 }]]),
      treeSitterAvailable: true,
    });
    const report = await analyzeHot(3);
    expect(report).toContain("## Top Components");
    expect(report).not.toContain("Frequent Re-renders");
  });

  it("is built for a stored session whose hot commit cannot be shown", async () => {
    // Saved when stop still called a commit hot whose named fiber did no work.
    buildIndex.mockResolvedValue({
      index: new Map([["ClockRow", { file: "/app/src/Clock.tsx", line: 25 }]]),
      treeSitterAvailable: true,
    });
    const report = await analyzeHot(0);
    expect(report).toContain("**Hot commits:** 0 of 101");
    expect(buildIndex).toHaveBeenCalledOnce();
    expect(report).toContain("`src/Clock.tsx:25`");
  });
});

describe("sessions with little or no commit data", () => {
  it("says nothing was measured for an older session that recorded no commits", async () => {
    const report = await runAnalyze({
      meta: { hotCommitIndices: [] },
      hotCommitIndices: [],
      totalReactCommits: 0,
    });
    expect(report).toContain("No React commits were recorded");
    expect(report).not.toContain("No commit reached 16ms");
  });

  it("makes no claim about commits when the session has no commit data", async () => {
    const report = await runAnalyze({ meta: {}, hotCommitIndices: null, totalReactCommits: null });
    expect(report).toContain("No React commit data could be read");
    expect(report).not.toContain("No commit reached 16ms");
  });

  it("does not take an unknown commit count for zero", async () => {
    const report = await runAnalyze({
      meta: { hotCommitIndices: [] },
      hotCommitIndices: [],
      totalReactCommits: null,
    });
    expect(report).toContain("No commit reached 16ms.");
    expect(report).not.toContain("No React commits were recorded");
  });
});
