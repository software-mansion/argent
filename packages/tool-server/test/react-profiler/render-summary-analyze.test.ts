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
  const renderSummary = summarizeRenders(fibers, timings, 2000);
  const commitsPath = join(scratch, "commits.json");
  await fs.writeFile(
    commitsPath,
    JSON.stringify({ commits: [], meta: { hotCommitIndices: [], renderSummary } })
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
      hotCommitIndices: [],
      totalReactCommits: 100,
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
});
