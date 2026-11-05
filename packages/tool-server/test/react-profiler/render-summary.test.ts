import { describe, it, expect } from "vitest";
import {
  COMMIT_TIME_SHARE_FLOOR,
  RENDER_SUMMARY_VERSION,
  commitTimeShare,
  formatCommitTime,
  formatShare,
  isCommitTimeAboveFloor,
  parseRenderSummary,
  selectFrequentRerenders,
  summarizeRenders,
  type RenderSummary,
  type RenderSummaryComponent,
} from "../../src/utils/react-profiler/render-summary";
import { createComponentOriginClassifier } from "../../src/utils/react-profiler/component-origin";
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
    totalCommitMs: 3365.6,
    maxCommitMs: 14.3,
    fiberRenders: components.reduce((s, c) => s + c.rerenders + c.mounts, 0),
    rerenders: components.reduce((s, c) => s + c.rerenders, 0),
    mounts: components.reduce((s, c) => s + c.mounts, 0),
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
    const s = summarizeRenders(commits, [4, 3, 2], 1000);
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
    // A null change description is a mount, as in the analyze pipeline.
    expect(s.components.find((c) => c.name === "App")).toMatchObject({
      rerenders: 0,
      mounts: 1,
      reason: null,
    });
    expect(s).toMatchObject({ fiberRenders: 5, rerenders: 3, mounts: 2 });
  });

  it("takes commit totals from the durations, so commits without named fibers still count", () => {
    // Commit 1 lost every fiber's display name at stop; its time is still React's.
    const s = summarizeRenders([fiber("A", 0, 1), fiber("A", 2, 1)], [10, 20.5, 6], 10_000);
    expect(s.totalCommits).toBe(3);
    expect(s.totalCommitMs).toBe(36.5);
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
      [1],
      100
    );
    expect(s.components[0]).toMatchObject({ reason: "state", topHooks: ["useState"] });
  });

  it("sorts components by re-render self time", () => {
    const s = summarizeRenders(
      [fiber("Cheap", 0, 0.1), fiber("Cheap", 1, 0.1), fiber("Costly", 0, 5)],
      [1, 1],
      100
    );
    expect(s.components.map((c) => c.name)).toEqual(["Costly", "Cheap"]);
  });

  it("returns an empty summary for a session with no commits", () => {
    const s = summarizeRenders([], [], 10_000);
    expect(s).toMatchObject({ totalCommits: 0, totalCommitMs: 0, maxCommitMs: 0, components: [] });
    expect(formatCommitTime(s)).toBe("0.0 ms of 10.0 s (0%), 0 commits");
  });
});

describe("parseRenderSummary", () => {
  it("accepts what summarizeRenders writes, through a JSON round trip", () => {
    const s = summarizeRenders([fiber("A", 0, 1)], [3], 1000);
    expect(parseRenderSummary(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it("treats a session saved before the field existed as having no summary", () => {
    expect(parseRenderSummary(undefined)).toBeNull();
    expect(parseRenderSummary(null)).toBeNull();
  });

  it("rejects another version or a damaged value instead of throwing later", () => {
    const s = summarizeRenders([fiber("A", 0, 1)], [3], 1000);
    expect(parseRenderSummary({ ...s, version: 2 })).toBeNull();
    expect(parseRenderSummary({ ...s, totalCommitMs: "3" })).toBeNull();
    expect(parseRenderSummary({ ...s, components: [{ name: "A" }] })).toBeNull();
    expect(parseRenderSummary("summary")).toBeNull();
  });
});

describe("commit time share line", () => {
  it("prints the clock fixture as the study measured it", () => {
    const s = summary([], { totalCommitMs: 3365.6, recordingMs: 10_074, totalCommits: 468 });
    expect(formatCommitTime(s)).toBe("3,366 ms of 10.1 s (33%), 468 commits");
  });

  it("keeps one decimal below 10% and never rounds up to the floor", () => {
    expect(formatShare(0.029)).toBe("2.9%");
    expect(formatShare(0.02886)).toBe("2.9%");
    expect(formatShare(0.0996)).toBe("9.9%");
    expect(formatShare(0.0004)).toBe("<0.1%");
    expect(formatShare(0)).toBe("0%");
    expect(formatShare(0.334)).toBe("33%");
  });

  it("says commit, not commits, for one", () => {
    expect(formatCommitTime(summary([], { totalCommits: 1, totalCommitMs: 5 }))).toContain(
      ", 1 commit"
    );
  });
});

describe("all-clear gate", () => {
  it("starts at 10%", () => {
    expect(COMMIT_TIME_SHARE_FLOOR).toBe(0.1);
  });

  it("is inclusive at the floor and off below it", () => {
    const at = summary([], { recordingMs: 10_000, totalCommitMs: 1000 });
    const below = summary([], { recordingMs: 10_000, totalCommitMs: 999 });
    expect(commitTimeShare(at)).toBe(0.1);
    expect(isCommitTimeAboveFloor(at)).toBe(true);
    expect(isCommitTimeAboveFloor(below)).toBe(false);
  });

  it("stays off for an empty recording", () => {
    expect(isCommitTimeAboveFloor(summary([], { recordingMs: 0, totalCommitMs: 0 }))).toBe(false);
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

  it("needs at least one re-render per second and a measurable cost", () => {
    const rows = selectFrequentRerenders(
      summary([component("Rare", 9, 500), component("Free", 5000, 5)]),
      classify
    );
    // 9 re-renders in 10 s is below once per second; 5 ms over 10 s is under 1 ms/s.
    expect(rows).toEqual([]);
  });

  it("shows at most five rows", () => {
    const many = Array.from({ length: 8 }, (_, i) => component(`Forget(Row${i})`, 100, 100 - i));
    expect(selectFrequentRerenders(summary(many), classify)).toHaveLength(5);
  });
});
