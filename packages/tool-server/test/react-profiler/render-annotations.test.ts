import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderProfilingReport } from "../../src/utils/react-profiler/pipeline/05-render";
import type { HotCommitSummary } from "../../src/utils/react-profiler/types/output";
import type { SessionContext } from "../../src/utils/react-profiler/types/pipeline";

// User-reported scenario (profiler-react19-investigation.md):
// commit #50 happens 216ms after the "tap post" annotation, but the legacy
// renderer subtracted `minTs` (the first hot commit's offset) from each
// commit's timestamp — shifting the commit side out of the annotation's
// reference frame and matching commit #50 to "scroll feed" 19s earlier.
//
// `BackendCommitData.timestamp` is already "ms since startProfiling"
// (set by React DevTools as `performance.now() - profilingStartTime`),
// and `annotation.offsetMs` is `tapTimestampMs - startedAtEpochMs`. Both
// share the "ms since profile-start" frame, so the correct relativeMs is
// just `summary.timestampMs` — no anchor needed.

const COMMIT_0_OFFSET = 17_587;
const COMMIT_50_OFFSET = 192_287;

const SUMMARIES: HotCommitSummary[] = [
  {
    commitIndex: 0,
    timestampMs: COMMIT_0_OFFSET,
    totalRenderMs: 100,
    isMargin: false,
    tier: "hot",
    components: [],
    totalComponentCount: 0,
  },
  {
    commitIndex: 50,
    timestampMs: COMMIT_50_OFFSET,
    totalRenderMs: 100,
    isMargin: false,
    tier: "hot",
    components: [],
    totalComponentCount: 0,
  },
];

const ANNOTATIONS = [
  { offsetMs: 173_110, label: "scroll feed" },
  { offsetMs: 192_071, label: "tap post" },
];

const SESSION_CONTEXT: SessionContext = {
  reactCompilerEnabled: false,
  strictModeEnabled: false,
  buildMode: "dev",
  rnArchitecture: "bridgeless",
  projectRoot: "/tmp/fake-project",
  platform: "ios",
};

async function makeDebugDir(): Promise<string> {
  const dir = join(tmpdir(), `argent-render-annotations-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("renderProfilingReport — annotation reference frame", () => {
  it("matches the annotation immediately preceding a commit (regression for the user's scenario)", async () => {
    const debugDir = await makeDebugDir();
    const { report } = await renderProfilingReport({
      hotCommitSummaries: SUMMARIES,
      componentFindings: [],
      sessionContext: SESSION_CONTEXT,
      recordingMs: 200_000,
      anyRuntimeCompilerDetected: false,
      reactCommits: 51,
      annotations: ANNOTATIONS,
      debugDir,
    });

    // commit #50 occurred 216ms after "tap post" — must surface as the prior annotation.
    const commit50Idx = report.indexOf("### Commit #50");
    expect(commit50Idx).toBeGreaterThanOrEqual(0);
    const after50 = report.slice(commit50Idx, commit50Idx + 200);
    expect(after50).toMatch(/> After: "tap post" \(0\.2s prior\)/);
    // Sanity: not the buggy assignment.
    expect(after50).not.toContain('"scroll feed"');

    // commit #0 (t=17.6s, before any annotation) gets no `> After:` line at all.
    const commit0Idx = report.indexOf("### Commit #0");
    expect(commit0Idx).toBeGreaterThanOrEqual(0);
    const between = report.slice(commit0Idx, commit50Idx);
    expect(between).not.toMatch(/> After:/);

    // Smoking-gun headers: both commits show their actual "ms since profile-start"
    // value, not the legacy minTs-shifted value (which would put commit #0 at t=0.0s).
    expect(between).toContain("(t=17.6s)");
    expect(after50).toContain("(t=192.3s)");

    await fs.rm(debugDir, { recursive: true, force: true });
  });

  it("renders without annotations when none are provided", async () => {
    const debugDir = await makeDebugDir();
    const { report } = await renderProfilingReport({
      hotCommitSummaries: SUMMARIES,
      componentFindings: [],
      sessionContext: SESSION_CONTEXT,
      recordingMs: 200_000,
      anyRuntimeCompilerDetected: false,
      reactCommits: 51,
      debugDir,
    });

    expect(report).toContain("### Commit #50");
    expect(report).toContain("### Commit #0");
    expect(report).not.toMatch(/> After:/);

    await fs.rm(debugDir, { recursive: true, force: true });
  });
});
