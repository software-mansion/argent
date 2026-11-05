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
  totalCommitMs: 3365.6,
  maxCommitMs: 14.3,
  fiberRenders: 58_032,
  rerenders: 58_032,
  mounts: 0,
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
  totalCommitMs: 56.1,
  maxCommitMs: 7.5,
  fiberRenders: 460,
  rerenders: 394,
  mounts: 66,
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
    allClear: true,
    ...overrides,
  });
  return report;
}

describe("all-clear report with a render summary", () => {
  it("is no longer all clear when cheap commits take a third of the session", async () => {
    const report = await render({
      renderSummary: CLOCK,
      maxCommitMs: CLOCK.maxCommitMs,
      componentOrigin: createComponentOriginClassifier(FIXTURE_INDEX),
    });
    expect(report).toContain("**React commit time:** 3,366 ms of 10.1 s (33%), 468 commits");
    expect(report).not.toContain("All clear");
    expect(report).not.toContain("No performance issues");
    expect(report).toContain("No slow commit, but React was busy");
    expect(report).toContain("(peak commit: 14.3ms)");
    expect(report).toContain("## Frequent Re-renders");

    const rows = report.split("\n").filter((l) => l.startsWith("| `"));
    expect(rows.map((r) => r.split("`")[1])).toEqual(["ClockRow", "ClockScreen", "ClockHeader"]);
    expect(rows[0]).toContain("| 14,040 |");
    expect(rows[0]).toContain("props: now");
    expect(rows[0]).toContain("`fixture/App.js:25`");
    // React Native's Text and View rank above ClockRow by count and are left out.
    expect(report).not.toMatch(/\| `(Text|View)`/);
  });

  it("stays all clear below the floor and prints no count table", async () => {
    const report = await render({
      renderSummary: SCROLL,
      maxCommitMs: SCROLL.maxCommitMs,
      recordingMs: 6903,
      reactCommits: 102,
    });
    expect(report).toContain("**React commit time:** 56 ms of 6.9 s (0.8%), 102 commits");
    expect(report).toContain(
      "✅ **All clear** — all React commits were below 16ms (peak commit: 7.5ms)."
    );
    expect(report).toContain("No performance issues detected");
    expect(report).not.toContain("Frequent Re-renders");
    expect(report).not.toContain("| `");
    expect(report).toContain("mode=`render_counts`");
  });

  it("points at neither react-profiler-renders nor react-profiler-component-source", async () => {
    for (const renderSummary of [CLOCK, SCROLL, null]) {
      const report = await render({ renderSummary });
      expect(report).not.toContain("react-profiler-renders");
      expect(report).not.toContain("react-profiler-component-source");
      expect(report).not.toMatch(/React\.memo/);
    }
  });

  it("says when every frequent re-render is in library code", async () => {
    const report = await render({
      renderSummary: { ...CLOCK, components: [component("Text", 28_548, 1082.01)] },
      componentOrigin: createComponentOriginClassifier(FIXTURE_INDEX),
    });
    expect(report).toContain("No app component re-rendered at least once per second");
  });
});

describe("slow commit with no named components", () => {
  it("does not say every commit was under 16ms, even below the share floor", async () => {
    const summary: RenderSummary = {
      ...CLOCK,
      totalCommits: 3,
      totalCommitMs: 50,
      maxCommitMs: 40,
      recordingMs: 10_000,
      components: [],
    };
    const report = await render({ renderSummary: summary, maxCommitMs: 40 });
    expect(report).toContain("Slow commit with no component names");
    expect(report).toContain("the slowest commit took 40.0ms");
    expect(report).not.toContain("All clear");
    expect(report).not.toContain("below 16ms");
    expect(report).not.toContain("## Frequent Re-renders");
    expect(report).not.toContain("Implement fixes");
  });

  it("says so when no component in the session has a name", async () => {
    const summary: RenderSummary = { ...CLOCK, maxCommitMs: 200, components: [] };
    const report = await render({ renderSummary: summary, maxCommitMs: 200 });
    expect(report).toContain("Slow commit with no component names");
    expect(report).toContain("No component in this session could be named");
    expect(report).not.toContain("library components");
  });
});

describe("all-clear report for a session saved without a render summary", () => {
  it("keeps the old verdict, prints no share line, and says what it could not measure", async () => {
    const report = await render({ renderSummary: null });
    expect(report).toContain("✅ **All clear** — all React commits were below 16ms.");
    expect(report).not.toContain("React commit time");
    expect(report).toContain("saved without a render summary");
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
  totalCommitMs: 324.4,
  maxCommitMs: 33.9,
  fiberRenders: 3169,
  rerenders: 2156,
  mounts: 1013,
  components: [component("Forget(SearchScreenShell)", 50, 59.6)],
};

describe("hot-commit report", () => {
  it("prints the share line and slow / all renders", async () => {
    const report = await render({
      allClear: false,
      hotCommitSummaries: [HOT],
      componentFindings: [SEARCH_SHELL],
      renderSummary: TYPING,
      recordingMs: 11_241.6,
      reactCommits: 51,
    });
    expect(report).toContain("**React commit time:** 324 ms of 11.2 s (2.9%), 51 commits");
    expect(report).toContain("re-renders in all 51 commits");
    const row = report.split("\n").find((l) => l.startsWith("| `SearchScreenShell`"));
    expect(row).toContain("| 6 / 50 |");
    // A hot report gets the column fix only, never a second count table.
    expect(report).not.toContain("Frequent Re-renders");
  });

  it("falls back to the stored count for a session without a summary", async () => {
    const report = await render({
      allClear: false,
      hotCommitSummaries: [HOT],
      componentFindings: [SEARCH_SHELL],
      renderSummary: null,
      reactCommits: 51,
    });
    expect(report).not.toContain("React commit time");
    expect(report).not.toContain("re-renders in all");
    const row = report.split("\n").find((l) => l.startsWith("| `SearchScreenShell`"));
    expect(row).toContain("| 6 | 9.6ms |");
  });
});
