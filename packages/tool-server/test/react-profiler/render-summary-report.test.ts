import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderProfilingReport } from "../../src/utils/react-profiler/pipeline/05-render";
import {
  RENDER_SUMMARY_VERSION,
  type RenderSummary,
  type RenderSummaryComponent,
} from "../../src/utils/react-profiler/render-summary";
import { createComponentOriginClassifier } from "../../src/utils/react-profiler/component-origin";
import type {
  ComponentFinding,
  HotCommitSummary,
} from "../../src/utils/react-profiler/types/output";
import type { SessionContext } from "../../src/utils/react-profiler/types/pipeline";

const SESSION_CONTEXT: SessionContext = {
  reactCompilerEnabled: false,
  strictModeEnabled: false,
  buildMode: "dev",
  rnArchitecture: "bridgeless",
  projectRoot: "/tmp/fake-project",
  platform: "ios",
};

function component(
  name: string,
  rerenders: number,
  rerenderSelfMs: number,
  extra: Partial<RenderSummaryComponent> = {}
): RenderSummaryComponent {
  return {
    name,
    rerenders,
    untrackedRenders: 0,
    rerenderCommits: rerenders,
    rerenderSelfMs,
    maxRerenderSelfMs: rerenders > 0 ? rerenderSelfMs / rerenders : 0,
    mounts: 0,
    mountSelfMs: 0,
    reason: "parent",
    ...extra,
  };
}

/** The fixture's 60 Hz clock: 468 commits, none ≥16 ms, 33% of 10.1 s. */
const CLOCK: RenderSummary = {
  version: RENDER_SUMMARY_VERSION,
  recordingMs: 10_074,
  totalCommits: 468,
  totalRenderMs: 3365.6,
  peakSecondRenderMs: 399,
  maxCommitMs: 14.3,
  fiberRenders: 58_032,
  rerenders: 58_032,
  mounts: 0,
  untrackedRenders: 0,
  components: [
    component("Text", 28_548, 1082.01),
    component("ClockRow", 14_040, 1007.84, { reason: "props", topProps: ["now"] }),
    component("View", 14_508, 482.04),
    component("ClockScreen", 468, 295.55, { reason: "state", topHooks: ["useState"] }),
    component("ClockHeader", 468, 14.65, { reason: "props", topProps: ["now"] }),
  ],
};

/** Bluesky fast scroll: 102 commits, 0.8% of the session. */
const SCROLL: RenderSummary = {
  version: RENDER_SUMMARY_VERSION,
  recordingMs: 6903,
  totalCommits: 102,
  totalRenderMs: 56.1,
  peakSecondRenderMs: 24,
  maxCommitMs: 7.5,
  fiberRenders: 460,
  rerenders: 394,
  mounts: 66,
  untrackedRenders: 0,
  components: [component("Forget(Outlet)", 204, 1.22), component("View", 58, 3)],
};

const FIXTURE_INDEX = new Map([
  ["ClockRow", { file: "/fixture/App.js", line: 25 }],
  ["ClockScreen", { file: "/fixture/App.js", line: 40 }],
  ["ClockHeader", { file: "/fixture/App.js", line: 35 }],
]);

const debugDirs: string[] = [];

afterEach(async () => {
  for (const dir of debugDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function render(
  overrides: Partial<Parameters<typeof renderProfilingReport>[0]> = {}
): Promise<string> {
  const debugDir = await fs.mkdtemp(join(tmpdir(), "argent-render-summary-report-"));
  debugDirs.push(debugDir);
  const { report } = await renderProfilingReport({
    hotCommitSummaries: [],
    componentFindings: [],
    sessionContext: SESSION_CONTEXT,
    recordingMs: 10_074,
    anyRuntimeCompilerDetected: false,
    reactCommits: 468,
    debugDir,
    noHotCommits: true,
    ...overrides,
  });
  return report;
}

const VERDICTS = /All clear|No performance|hotspots|React was busy|smooth|worth chasing/;

describe("report with no hot commit", () => {
  it("states what was measured and lists what re-rendered most, with no verdict", async () => {
    const report = await render({
      renderSummary: CLOCK,
      maxCommitMs: CLOCK.maxCommitMs,
      componentOrigin: createComponentOriginClassifier(FIXTURE_INDEX),
    });
    expect(report).toContain(
      "**React render time (dev build):** 3,366 ms of 10.1 s (33%), peak 40% in 1 s, 468 commits"
    );
    expect(report).toContain("No commit reached 16ms (peak commit: 14.3ms).");
    expect(report).not.toMatch(VERDICTS);
    expect(report).not.toContain("⚠️");
    expect(report).toContain("## Most Frequent Re-renders");
    expect(report).toContain("in at least 10 of the 468 commits");
    expect(report).toContain("not that it is a problem");

    const rows = report.split("\n").filter((l) => l.startsWith("| `"));
    expect(rows.map((r) => r.split("`")[1])).toEqual(["ClockRow", "ClockScreen", "ClockHeader"]);
    expect(rows[0]).toContain("| 14,040 |");
    expect(rows[0]).toContain("props: now");
    expect(rows[0]).toContain("`fixture/App.js:25`");
    // React Native's Text and View rank above ClockRow by count and are left out.
    expect(report).not.toMatch(/\| `(Text|View)`/);
    expect(report).toContain("Ask the user which path to take");
    expect(report).toContain("**Cut re-renders**");
  });

  it("lists a burst that idle time pushes down to a low share of the recording", async () => {
    // 3 s of the clock in a 70 s recording: 1.6% of it, no share floor to pass.
    const report = await render({
      renderSummary: {
        ...CLOCK,
        recordingMs: 70_200,
        totalCommits: 170,
        totalRenderMs: 1130,
        components: [component("ClockRow", 5100, 370, { reason: "props", topProps: ["now"] })],
      },
      recordingMs: 70_200,
      reactCommits: 170,
      componentOrigin: createComponentOriginClassifier(FIXTURE_INDEX),
    });
    expect(report).toContain("1,130 ms of 70.2 s (1.6%), peak 40% in 1 s, 170 commits");
    expect(report).toContain("## Most Frequent Re-renders");
    expect(report).toContain("| `ClockRow` |");
  });

  it("prints no table when no component passes, and still no verdict", async () => {
    const report = await render({
      renderSummary: SCROLL,
      maxCommitMs: SCROLL.maxCommitMs,
      recordingMs: 6903,
      reactCommits: 102,
    });
    expect(report).toContain("56 ms of 6.9 s (0.8%), peak 2.4% in 1 s, 102 commits");
    expect(report).toContain("No commit reached 16ms (peak commit: 7.5ms).");
    expect(report).not.toMatch(VERDICTS);
    expect(report).not.toContain("Frequent Re-renders");
    expect(report).not.toContain("| `");
    expect(report).not.toContain("Ask the user which path");
    expect(report).toContain("mode=`render_counts`");
    expect(report).toContain("mode=`top_functions`");
  });

  it("says nothing was measured when nothing rendered", async () => {
    const report = await render({
      renderSummary: { ...CLOCK, totalCommits: 0, totalRenderMs: 0, peakSecondRenderMs: 0 },
      reactCommits: 0,
    });
    expect(report).toContain("No React commits were recorded");
    expect(report).toContain("Interact with the app");
    expect(report).not.toMatch(VERDICTS);
    expect(report).not.toContain("No commit reached 16ms");
    expect(report).not.toContain("Next Steps");
  });

  it("says no commits were recorded for an older session too, without the 16ms claim", async () => {
    const report = await render({ renderSummary: null, noReactCommits: true, reactCommits: 0 });
    expect(report).toContain("No React commits were recorded");
    expect(report).not.toContain("No commit reached 16ms");
    expect(report).not.toContain("has no render summary");
  });

  it("claims nothing about commits when no commit data could be read", async () => {
    const report = await render({ noHotCommits: false, renderSummary: null, reactCommits: 0 });
    expect(report).toContain("No React commit data could be read");
    expect(report).not.toContain("No commit reached 16ms");
    expect(report).not.toContain("has no render summary");
    expect(report).not.toMatch(VERDICTS);
  });

  it("uses the summary when a hot commit could not be shown", async () => {
    // Stop marked a commit hot, but its only named fiber did no work.
    const report = await render({
      noHotCommits: false,
      renderSummary: { ...CLOCK, maxCommitMs: 40, components: [] },
      maxCommitMs: 40,
    });
    expect(report).toContain("the slowest commit took 40.0ms");
    expect(report).not.toContain("No React commit data could be read");
  });

  it("does not print a commit just under 16ms as 16.0ms", async () => {
    const report = await render({ renderSummary: SCROLL, maxCommitMs: 15.97 });
    expect(report).toContain("No commit reached 16ms (peak commit: 15.9ms).");
  });

  it("marks only a dev build as one", async () => {
    const report = await render({
      renderSummary: SCROLL,
      sessionContext: { ...SESSION_CONTEXT, buildMode: "prod" },
    });
    expect(report).toContain("**React render time:** 56 ms");
    expect(report).not.toContain("dev build");
  });

  it("points at neither react-profiler-renders nor react-profiler-component-source", async () => {
    for (const renderSummary of [CLOCK, SCROLL, null]) {
      const report = await render({ renderSummary });
      expect(report).not.toContain("react-profiler-renders");
      expect(report).not.toContain("react-profiler-component-source");
      expect(report).not.toMatch(/React\.memo/);
    }
  });

  it("prints no table when every frequent re-render is in library code", async () => {
    const report = await render({
      renderSummary: { ...CLOCK, components: [component("Text", 28_548, 1082.01)] },
      componentOrigin: createComponentOriginClassifier(FIXTURE_INDEX),
    });
    expect(report).not.toContain("Frequent Re-renders");
    expect(report).toContain("mode=`render_counts`");
  });
});

describe("slow commit with no named components", () => {
  it("does not say no commit reached 16ms, whatever the share", async () => {
    const summary: RenderSummary = {
      ...CLOCK,
      totalCommits: 3,
      totalRenderMs: 50,
      peakSecondRenderMs: 50,
      maxCommitMs: 40,
      recordingMs: 10_000,
      components: [],
    };
    const report = await render({ renderSummary: summary, maxCommitMs: 40 });
    expect(report).toContain("Slow commit with no component names");
    expect(report).toContain("the slowest commit took 40.0ms");
    expect(report).not.toContain("No commit reached 16ms");
    expect(report).not.toMatch(VERDICTS);
    expect(report).not.toContain("## Most Frequent Re-renders");
    expect(report).not.toContain("Cut re-renders");
  });

  it("says so when no component in the session has a name", async () => {
    const summary: RenderSummary = { ...CLOCK, maxCommitMs: 200, components: [] };
    const report = await render({ renderSummary: summary, maxCommitMs: 200 });
    expect(report).toContain("Slow commit with no component names");
    expect(report).toContain("No component in this session could be named");
  });

  it("still lists the components it can name", async () => {
    const report = await render({
      renderSummary: { ...CLOCK, maxCommitMs: 40 },
      maxCommitMs: 40,
      componentOrigin: createComponentOriginClassifier(FIXTURE_INDEX),
    });
    expect(report).toContain("Slow commit with no component names");
    expect(report).toContain("## Most Frequent Re-renders");
  });
});

describe("report for a session with no render summary", () => {
  it("gives no verdict and no share line, and says what it could not measure", async () => {
    const report = await render({ renderSummary: null });
    expect(report).toContain("No commit reached 16ms.");
    expect(report).not.toMatch(VERDICTS);
    expect(report).not.toContain("React render time");
    expect(report).toContain("has no render summary");
    expect(report).not.toContain("render_counts");
  });
});

const HOT: HotCommitSummary = {
  commitIndex: 1,
  timestampMs: 193,
  totalRenderMs: 26.9,
  isMargin: false,
  tier: "warm",
  components: [],
  totalComponentCount: 0,
};

const SEARCH_SHELL: ComponentFinding = {
  component: "Forget(SearchScreenShell)",
  renders: 6,
  totalMs: 9.6,
  avgMs: 1.6,
  maxMs: 3.2,
  dominantReason: "props",
  topChangedProps: ["query"],
  topChangedHookNames: [],
};

/** Bluesky typing: 51 commits, 2 hot, 2.9% of 11.2 s. */
const TYPING: RenderSummary = {
  version: RENDER_SUMMARY_VERSION,
  recordingMs: 11_241.6,
  totalCommits: 51,
  totalRenderMs: 324.4,
  peakSecondRenderMs: 71,
  maxCommitMs: 33.9,
  fiberRenders: 3169,
  rerenders: 2156,
  mounts: 1013,
  untrackedRenders: 0,
  components: [component("Forget(SearchScreenShell)", 50, 59.6)],
};

describe("hot-commit report", () => {
  it("prints the share line and slow / all renders", async () => {
    const report = await render({
      noHotCommits: false,
      hotCommitSummaries: [HOT],
      componentFindings: [SEARCH_SHELL],
      renderSummary: TYPING,
      recordingMs: 11_241.6,
      reactCommits: 51,
    });
    expect(report).toContain(
      "**React render time (dev build):** 324 ms of 11.2 s (2.9%), peak 7.1% in 1 s, 51 commits"
    );
    expect(report).toContain("re-renders in the stored commits");
    expect(report).toContain("re-renders in all 51 commits");
    const row = report.split("\n").find((l) => l.startsWith("| `SearchScreenShell`"));
    expect(row).toContain("| 6 / 50 |");
    // A hot report gets the column fix only, never a second count table.
    expect(report).not.toContain("Frequent Re-renders");
  });

  it("falls back to the stored count for a session without a summary", async () => {
    const report = await render({
      noHotCommits: false,
      hotCommitSummaries: [HOT],
      componentFindings: [SEARCH_SHELL],
      renderSummary: null,
      reactCommits: 51,
    });
    expect(report).not.toContain("React render time");
    expect(report).not.toContain("re-renders in all");
    const row = report.split("\n").find((l) => l.startsWith("| `SearchScreenShell`"));
    expect(row).toContain("| 6 | 9.6ms |");
  });
});
