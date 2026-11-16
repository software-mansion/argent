/**
 * Every react-profiler-analyze wrote the same `react-profiler-report.md`, so two
 * agents that profiled at the same time overwrote each other's report. Each
 * session now gets its own file, named after its session id.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";
import { summarizeRenders } from "../../src/utils/react-profiler/render-summary";
import type { DevToolsFiberCommit } from "../../src/utils/react-profiler/types/input";
import { reactProfilerAnalyzeTool } from "../../src/tools/profiler/react/react-profiler-analyze";
import { redirectTmpdir } from "../helpers/tmpdir-env";

vi.mock("../../src/utils/react-profiler/pipeline/06-resolve/ast-index", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildAstIndexWithDiagnostics: vi.fn(async () => ({
    index: new Map(),
    treeSitterAvailable: true,
  })),
}));

const PORT = 8081;
const SESSIONS = [
  { device: "device-a", sessionId: "20261113-135245", component: "AlphaRow" },
  { device: "device-b", sessionId: "20261113-135246", component: "BetaRow" },
];

let scratch = "";
let restoreTmpdir: () => void = () => {};

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), "argent-report-file-per-session-"));
  restoreTmpdir = redirectTmpdir(scratch);
});

afterEach(async () => {
  restoreTmpdir();
  for (const s of SESSIONS) clearCachedProfilerPaths(PORT, s.device);
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Stores a session where `component` re-rendered 100 times in 2 s, and analyzes it. */
async function analyzeSession(s: (typeof SESSIONS)[number]): Promise<void> {
  const fibers = Array.from(
    { length: 100 },
    (_, i) =>
      ({
        commitIndex: i,
        timestamp: i * 20,
        componentName: s.component,
        actualDuration: 1,
        selfDuration: 1,
        commitDuration: 5,
        didRender: true,
        changeDescription: {
          props: ["now"],
          state: null,
          hooks: [],
          context: false,
          didHooksChange: false,
          isFirstMount: false,
        },
        hookTypes: null,
        parentName: null,
        isCompilerOptimized: false,
      }) as DevToolsFiberCommit
  );
  const timings = fibers.map((f) => ({ timestamp: f.timestamp, durationMs: 5 }));
  const commitsPath = join(scratch, `react-profiler-${s.sessionId}_commits.json`);
  await fs.writeFile(
    commitsPath,
    JSON.stringify({
      commits: [],
      meta: { hotCommitIndices: [], renderSummary: summarizeRenders(fibers, timings, 2000) },
    })
  );
  cacheProfilerPaths(
    PORT,
    {
      sessionId: s.sessionId,
      debugDir: scratch,
      cpuProfilePath: null,
      commitsPath,
      cpuSampleIndexPath: null,
      detectedArchitecture: null,
      anyCompilerOptimized: null,
      hotCommitIndices: [],
      totalReactCommits: 100,
    },
    s.device
  );
  await reactProfilerAnalyzeTool.execute!(
    {},
    {
      port: PORT,
      device_id: s.device,
      project_root: scratch,
      platform: "ios",
      rn_version: "0.86.0",
    },
    { artifacts: { register: async () => ({ id: "artifact", kind: "file" }) } } as never
  );
}

describe("react-profiler-analyze report file", () => {
  it("is one file per session, so a second session does not overwrite the first's report", async () => {
    for (const s of SESSIONS) await analyzeSession(s);

    const reports = (await fs.readdir(scratch)).filter((f) => f.endsWith(".md")).sort();
    expect(reports).toEqual(SESSIONS.map((s) => `react-profiler-${s.sessionId}_report.md`));
    for (const s of SESSIONS) {
      const text = await fs.readFile(
        join(scratch, `react-profiler-${s.sessionId}_report.md`),
        "utf8"
      );
      expect(text).toContain(s.component);
    }
  });
});
