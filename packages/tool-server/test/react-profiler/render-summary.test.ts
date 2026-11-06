import { describe, it, expect } from "vitest";
import {
  RENDER_SUMMARY_VERSION,
  formatPeakCommit,
  formatRenderSummaryReason,
  formatRenderTime,
  formatShare,
  hasUnnamedSlowCommit,
  parseRenderSummary,
  peakRenderShare,
  renderTimeShare,
  selectFrequentRerenders,
  summarizeRenders,
  type RenderSummary,
  type RenderSummaryComponent,
} from "../../src/utils/react-profiler/render-summary";
import { createComponentOriginClassifier } from "../../src/utils/react-profiler/component-origin";
import { reduce } from "../../src/utils/react-profiler/pipeline/01-reduce";
import { enrich } from "../../src/utils/react-profiler/pipeline/02-enrich";
import type { SessionContext } from "../../src/utils/react-profiler/types/pipeline";
import type {
  DevToolsChangeDescription,
  DevToolsFiberCommit,
} from "../../src/utils/react-profiler/types/input";

const RERENDER: DevToolsChangeDescription = {
  props: [],
  state: null,
  hooks: [],
  context: false,
  didHooksChange: false,
  isFirstMount: false,
};

/** Commit timings for these durations, `gapMs` apart. */
function timings(durations: number[], gapMs = 100) {
  return durations.map((durationMs, i) => ({ timestamp: i * gapMs, durationMs }));
}

function fiber(
  componentName: string,
  commitIndex: number,
  selfDuration: number,
  cd: DevToolsChangeDescription | null = RERENDER,
  extra: Partial<DevToolsFiberCommit> = {}
): DevToolsFiberCommit {
  return {
    commitIndex,
    timestamp: commitIndex * 16,
    componentName,
    actualDuration: selfDuration + 0.01,
    selfDuration,
    commitDuration: 5,
    didRender: true,
    changeDescription: cd,
    ...extra,
  };
}

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
    reason: rerenders > 0 ? "parent" : null,
    ...extra,
  };
}

function summary(
  components: RenderSummaryComponent[],
  totals: Partial<RenderSummary> = {}
): RenderSummary {
  return {
    version: RENDER_SUMMARY_VERSION,
    recordingMs: 10_000,
    totalCommits: 468,
    totalRenderMs: 3365.6,
    peakSecondRenderMs: 399,
    maxCommitMs: 14.3,
    fiberRenders: components.reduce((s, c) => s + c.rerenders + c.mounts, 0),
    rerenders: components.reduce((s, c) => s + c.rerenders, 0),
    mounts: components.reduce((s, c) => s + c.mounts, 0),
    untrackedRenders: 0,
    components,
    ...totals,
  };
}

describe("summarizeRenders", () => {
  it("counts re-renders and mounts over every commit it is given", () => {
    const commits = [
      fiber("App", 0, 2, null),
      fiber("Row", 0, 1, { ...RERENDER, isFirstMount: true }),
      fiber("Row", 1, 0.5, { ...RERENDER, props: ["now"] }),
      fiber("Row", 1, 0.25, { ...RERENDER, props: ["now"] }),
      fiber("Row", 2, 0.75, { ...RERENDER, props: ["now", "index"] }),
      // didRender false entries are bail-outs, not renders.
      fiber("Row", 2, 0, RERENDER, { didRender: false, actualDuration: 0 }),
    ];
    const s = summarizeRenders(commits, timings([4, 3, 2]), 1000);
    const row = s.components.find((c) => c.name === "Row")!;
    expect(row).toMatchObject({
      rerenders: 3,
      rerenderCommits: 2,
      rerenderSelfMs: 1.5,
      maxRerenderSelfMs: 0.75,
      mounts: 1,
      mountSelfMs: 1,
      reason: "props",
      topProps: ["now", "index"],
    });
    // DevTools records no change data for context fibers, on any render.
    expect(s.components.find((c) => c.name === "App")).toMatchObject({
      rerenders: 0,
      mounts: 0,
      untrackedRenders: 1,
      reason: null,
    });
    expect(s).toMatchObject({ fiberRenders: 5, rerenders: 3, mounts: 1, untrackedRenders: 1 });
  });

  it("does not call a context fiber's renders mounts", () => {
    const provider = (i: number) => fiber("ListContext.Provider", i, 0.1, null);
    const s = summarizeRenders([provider(0), provider(1), provider(2)], timings([1, 1, 1]), 1000);
    const row = s.components[0]!;
    expect(row).toMatchObject({ mounts: 0, untrackedRenders: 3 });
    expect(formatRenderSummaryReason(row)).toBe("no change data");
  });

  it("rounds the slowest commit down, so 15.996 ms has not reached the 16 ms floor", () => {
    const s = summarizeRenders([], timings([15.996]), 1000);
    expect(s.maxCommitMs).toBe(15.99);
    expect(hasUnnamedSlowCommit(s)).toBe(false);
    expect(hasUnnamedSlowCommit(summarizeRenders([], timings([16]), 1000))).toBe(true);
  });

  it("takes commit totals from the durations, so commits without named fibers still count", () => {
    // Commit 1 lost every fiber's display name at stop; its time is still React's.
    const s = summarizeRenders(
      [fiber("A", 0, 1), fiber("A", 2, 1)],
      timings([10, 20.5, 6]),
      10_000
    );
    expect(s.totalCommits).toBe(3);
    expect(s.totalRenderMs).toBe(36.5);
    expect(s.maxCommitMs).toBe(20.5);
    expect(s.recordingMs).toBe(10_000);
  });

  it("names the changed hooks from the fiber's hook types", () => {
    const s = summarizeRenders(
      [
        fiber(
          "Clock",
          0,
          1,
          { ...RERENDER, hooks: [1], didHooksChange: true },
          {
            hookTypes: ["useEffect", "useState"],
          }
        ),
      ],
      timings([1]),
      100
    );
    expect(s.components[0]).toMatchObject({ reason: "state", topHooks: ["useState"] });
  });

  it("sorts components by re-render self time", () => {
    const s = summarizeRenders(
      [fiber("Cheap", 0, 0.1), fiber("Cheap", 1, 0.1), fiber("Costly", 0, 5)],
      timings([1, 1]),
      100
    );
    expect(s.components.map((c) => c.name)).toEqual(["Costly", "Cheap"]);
  });

  it("returns an empty summary for a session with no commits", () => {
    const s = summarizeRenders([], [], 10_000);
    expect(s).toMatchObject({
      totalCommits: 0,
      totalRenderMs: 0,
      peakSecondRenderMs: 0,
      maxCommitMs: 0,
      components: [],
    });
    expect(formatRenderTime(s)).toBe("0.0 ms of 10.0 s (0%), 0 commits");
  });
});

describe("parseRenderSummary", () => {
  it("accepts what summarizeRenders writes, through a JSON round trip", () => {
    const s = summarizeRenders([fiber("A", 0, 1)], timings([3]), 1000);
    expect(parseRenderSummary(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("rejects a damaged row that would throw while printing", () => {
    const s = summarizeRenders([fiber("A", 0, 1)], timings([3]), 1000);
    const row = s.components[0]!;
    expect(parseRenderSummary({ ...s, components: [{ ...row, topProps: "now" }] })).toBeNull();
    expect(parseRenderSummary({ ...s, components: [{ ...row, reason: 3 }] })).toBeNull();
  });

  it("treats a session saved before the field existed as having no summary", () => {
    expect(parseRenderSummary(undefined)).toBeNull();
    expect(parseRenderSummary(null)).toBeNull();
  });

  it.each([
    "rerenders",
    "untrackedRenders",
    "rerenderCommits",
    "rerenderSelfMs",
    "maxRerenderSelfMs",
    "mounts",
    "mountSelfMs",
  ])("rejects a row that lost %s, which render_counts would print", (key) => {
    const s = summarizeRenders([fiber("A", 0, 1)], timings([3]), 1000);
    const row: Record<string, unknown> = { ...s.components[0]! };
    delete row[key];
    expect(parseRenderSummary({ ...s, components: [row] })).toBeNull();
  });

  it("rejects components that are not a list", () => {
    const s = summarizeRenders([fiber("A", 0, 1)], timings([3]), 1000);
    for (const components of [undefined, null, 3, "A", {}]) {
      expect(parseRenderSummary({ ...s, components })).toBeNull();
    }
  });

  it("rejects another version or a damaged value instead of throwing later", () => {
    const s = summarizeRenders([fiber("A", 0, 1)], timings([3]), 1000);
    expect(parseRenderSummary({ ...s, version: 2 })).toBeNull();
    expect(parseRenderSummary({ ...s, totalRenderMs: "3" })).toBeNull();
    expect(parseRenderSummary({ ...s, components: [{ name: "A" }] })).toBeNull();
    expect(parseRenderSummary("summary")).toBeNull();
  });
});

describe("render time line", () => {
  it("prints the clock fixture as the study measured it", () => {
    const s = summary([], { totalRenderMs: 3365.6, recordingMs: 10_074, totalCommits: 468 });
    expect(formatRenderTime(s)).toBe("3,366 ms of 10.1 s (33%), peak 40% in 1 s, 468 commits");
  });

  it("keeps one decimal below 10%", () => {
    expect(formatShare(0.029)).toBe("2.9%");
    expect(formatShare(0.02886)).toBe("2.9%");
    expect(formatShare(0.0991)).toBe("9.9%");
    expect(formatShare(0.0996)).toBe("10%");
    expect(formatShare(0.0004)).toBe("<0.1%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.334)).toBe("33%");
  });

  it("says commit, not commits, for one", () => {
    expect(formatRenderTime(summary([], { totalCommits: 1, totalRenderMs: 5 }))).toContain(
      ", 1 commit"
    );
  });

  it("never prints a peak under 16 ms as 16.0ms", () => {
    expect(formatPeakCommit(15.97)).toBe("15.9ms");
    expect(formatPeakCommit(14.34)).toBe("14.3ms");
    expect(formatPeakCommit(40)).toBe("40.0ms");
  });

  it("gives a share of 0 for an empty recording", () => {
    const s = summary([], { recordingMs: 0, totalRenderMs: 0, peakSecondRenderMs: 0 });
    expect(renderTimeShare(s)).toBe(0);
    expect(peakRenderShare(s)).toBe(0);
  });
});

describe("busiest second", () => {
  // A 2 s burst of 10 ms commits, 20 ms apart: 50% while it lasts.
  const burst = new Array(100).fill(10);

  it("finds the most render time in any one second", () => {
    const s = summarizeRenders([], timings(burst, 20), 2000);
    expect(s.peakSecondRenderMs).toBe(500);
    expect(peakRenderShare(s)).toBe(0.5);
  });

  it("is not lowered by idle time, unlike the share of the recording", () => {
    const short = summarizeRenders([], timings(burst, 20), 2000);
    const long = summarizeRenders([], timings(burst, 20), 70_000);
    expect(renderTimeShare(long)).toBeCloseTo(renderTimeShare(short) / 35);
    expect(peakRenderShare(long)).toBe(peakRenderShare(short));
  });

  it("sorts commits first: roots arrive one after the other, not in time order", () => {
    const mixed = [
      { timestamp: 900, durationMs: 5 },
      { timestamp: 100, durationMs: 5 },
      { timestamp: 5000, durationMs: 7 },
      { timestamp: 500, durationMs: 5 },
    ];
    expect(summarizeRenders([], mixed, 10_000).peakSecondRenderMs).toBe(15);
  });

  it("does not count a commit exactly one second older in the same window", () => {
    const edge = [
      { timestamp: 0, durationMs: 5 },
      { timestamp: 1000, durationMs: 5 },
    ];
    expect(summarizeRenders([], edge, 10_000).peakSecondRenderMs).toBe(5);
  });

  it("measures a recording shorter than a second against its own length", () => {
    const s = summarizeRenders([], timings([100, 100], 100), 400);
    expect(peakRenderShare(s)).toBe(0.5);
    expect(renderTimeShare(s)).toBe(0.5);
  });

  it("caps the peak at 100%, since a commit's duration lands on one timestamp", () => {
    const s = summarizeRenders([], timings([700, 700], 100), 10_000);
    expect(s.peakSecondRenderMs).toBe(1400);
    expect(peakRenderShare(s)).toBe(1);
  });

  it("leaves a commit without a usable timestamp out of the peak, not the total", () => {
    const s = summarizeRenders([], [{ timestamp: Number.NaN, durationMs: 9 }], 10_000);
    expect(s.totalRenderMs).toBe(9);
    expect(s.peakSecondRenderMs).toBe(0);
  });
});

describe("component origin", () => {
  const index = new Map([
    ["ClockRow", { file: "/app/src/Clock.tsx", line: 25 }],
    ["Text", { file: "/app/src/Typography.tsx", line: 3 }],
    ["SearchScreenShell", { file: "/app/src/Search.tsx", line: 9 }],
  ]);
  const classify = createComponentOriginClassifier(index);

  it("treats React Native primitives and list internals as library", () => {
    for (const name of [
      "View",
      "Text",
      "ScrollView",
      "Memo(View)",
      "VirtualizedList",
      "VirtualizedListCellContextProvider",
      "CellRenderer",
      "FlatList",
    ]) {
      expect(classify(name).origin, name).toBe("library");
    }
  });

  it("treats list internals as library with no source index to fall back on", () => {
    const nameOnly = createComponentOriginClassifier(null);
    for (const name of [
      "FlatList",
      "SectionList",
      "VirtualizedList",
      "CellRenderer",
      "FlashList",
      "AutoLayoutView",
    ]) {
      expect(nameOnly(name).origin, name).toBe("library");
    }
  });

  it("leaves unresolved names out, under a compiler wrapper too", () => {
    for (const name of [
      "Anonymous",
      "Memo(Anonymous)",
      "Forget(Anonymous)",
      "Forget(Memo(Anonymous))",
      "Forget(ForwardRef(Anonymous))",
    ]) {
      expect(classify(name).origin, name).toBe("library");
      expect(createComponentOriginClassifier(null)(name).origin, name).toBe("library");
    }
  });

  it("treats a React Compiler fiber with a React Native name as the app's own", () => {
    // Bluesky defines its own Text; the compiler only compiles app code.
    expect(classify("Forget(Text)")).toEqual({
      origin: "app",
      file: "/app/src/Typography.tsx",
      line: 3,
    });
  });

  it("drops animation wrappers, providers, contexts and dev-only views whoever defines them", () => {
    for (const name of [
      "AnimatedComponent(View)",
      "Animated(View)",
      "ThemeProvider",
      "Forget(MainScrollProvider)",
      "ScrollViewContext.Provider",
      "SafeAreaInsetsContext.Consumer",
      "PressabilityDebugView",
      "LogBoxInspectorContainer",
    ]) {
      expect(classify(name).origin, name).toBe("library");
    }
  });

  it("uses the source index for other names", () => {
    expect(classify("ClockRow")).toEqual({ origin: "app", file: "/app/src/Clock.tsx", line: 25 });
    expect(classify("Forget(SearchScreenShell)").origin).toBe("app");
    // Not defined in the project: a library's.
    expect(classify("GestureDetector").origin).toBe("library");
    expect(classify("Forget(t29)").origin).toBe("app");
  });

  it("keeps names it cannot place when no index is available", () => {
    const nameOnly = createComponentOriginClassifier(null);
    expect(nameOnly("ClockRow").origin).toBe("unknown");
    expect(nameOnly("View").origin).toBe("library");
    // An empty index means the project root held no source, not that all is library.
    expect(createComponentOriginClassifier(new Map())("ClockRow").origin).toBe("unknown");
  });
});

describe("selectFrequentRerenders", () => {
  const classify = createComponentOriginClassifier(
    new Map([
      ["ClockRow", { file: "/app/App.js", line: 25 }],
      ["ClockScreen", { file: "/app/App.js", line: 40 }],
      ["ClockHeader", { file: "/app/App.js", line: 35 }],
      ["Rare", { file: "/app/App.js", line: 50 }],
      ["Free", { file: "/app/App.js", line: 60 }],
    ])
  );

  it("counts commits, not fibers: 100 rows re-rendering once is one event", () => {
    const rows = selectFrequentRerenders(
      summary([component("ClockRow", 100, 50, { rerenderCommits: 1 })], { recordingMs: 10_000 }),
      classify
    );
    expect(rows).toEqual([]);
  });

  it("does not raise the bar with idle time: a burst keeps its row in a long recording", () => {
    const burst = component("ClockRow", 5100, 600, { rerenderCommits: 170 });
    const rows = selectFrequentRerenders(summary([burst], { recordingMs: 300_000 }), classify);
    expect(rows.map((r) => r.component.name)).toEqual(["ClockRow"]);
  });

  it("lists app components by self time per second and leaves library rows out", () => {
    const rows = selectFrequentRerenders(
      summary([
        component("Text", 28548, 1082),
        component("ClockRow", 14040, 1007.8, { reason: "props", topProps: ["now"] }),
        component("View", 14508, 482),
        component("ClockScreen", 468, 295.6),
        component("ClockHeader", 468, 14.7),
      ]),
      classify
    );
    expect(rows.map((r) => r.component.name)).toEqual(["ClockRow", "ClockScreen", "ClockHeader"]);
    expect(rows[0]!.perSecond).toBeCloseTo(1404, 0);
    expect(rows[0]!.selfMsPerSecond).toBeCloseTo(100.78, 1);
    expect(rows[0]!.origin.file).toBe("/app/App.js");
  });

  it("needs re-renders in at least 10 commits and a measurable cost", () => {
    const rows = selectFrequentRerenders(
      summary([component("Rare", 9, 500), component("Free", 5000, 5)]),
      classify
    );
    // Rare re-rendered in 9 commits; Free's 5 ms over 10 s is under 1 ms/s.
    expect(rows).toEqual([]);
  });

  it("lists a component at exactly the 10-commit cutoff, and not one below it", () => {
    const at = component("Forget(AtCutoff)", 100, 500, { rerenderCommits: 10 });
    const below = component("Forget(BelowCutoff)", 100, 500, { rerenderCommits: 9 });
    const rows = selectFrequentRerenders(summary([at, below]), classify);
    expect(rows.map((r) => r.component.name)).toEqual(["Forget(AtCutoff)"]);
  });

  it("shows at most five rows", () => {
    const many = Array.from({ length: 8 }, (_, i) => component(`Forget(Row${i})`, 100, 100 - i));
    expect(selectFrequentRerenders(summary(many), classify)).toHaveLength(5);
  });
});

describe("the dominant reason on a tie", () => {
  const STATE = { ...RERENDER, hooks: [0] };
  const PROPS = { ...RERENDER, props: ["x"] };
  const useState = { hookTypes: ["useState"] };

  /** The reason the report's Top Components table gives for the same fibers. */
  function reportReason(fibers: DevToolsFiberCommit[], name: string) {
    const reduced = reduce({ commits: fibers, hookNames: new Map() }, {} as SessionContext, 1000);
    return enrich(reduced).components.get(name)!.dominantReason;
  }

  it("is the same in the summary and in the report, whichever came first", () => {
    // The order is the report's: parent, props, hooks, context, state.
    for (const [order, expected] of [
      [[STATE, STATE, PROPS, PROPS], "props"],
      [[PROPS, PROPS, STATE, STATE], "props"],
      [[STATE, PROPS, RERENDER, STATE, PROPS, RERENDER], "parent"],
    ] as const) {
      const fibers = order.map((cd, i) => fiber("Row", i, 1, cd, useState));
      const summary = summarizeRenders(fibers, timings(order.map(() => 5)), 1000);
      expect(summary.components[0]!.reason).toBe(expected);
      expect(reportReason(fibers, "Row")).toBe(expected);
    }
  });

  it("still follows the count when there is no tie", () => {
    const order = [PROPS, STATE, STATE];
    const fibers = order.map((cd, i) => fiber("Row", i, 1, cd, useState));
    expect(summarizeRenders(fibers, timings([5, 5, 5]), 1000).components[0]!.reason).toBe("state");
  });
});
