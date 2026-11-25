import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
} from "../../src/blueprints/react-profiler-session";
import { buildHotCommitSummaries } from "../../src/utils/react-profiler/pipeline/00-hot-commits";
import {
  getTopComponents,
  profilerCommitQueryTool,
  renderByComponent,
} from "../../src/tools/profiler/query/profiler-commit-query";
import type { DevToolsFiberCommit } from "../../src/utils/react-profiler/types/input";

function fiber(overrides: Partial<DevToolsFiberCommit>): DevToolsFiberCommit {
  return {
    commitIndex: 0,
    timestamp: 100,
    componentName: "View",
    actualDuration: 1,
    selfDuration: 1,
    commitDuration: 25,
    didRender: true,
    changeDescription: null,
    ...overrides,
  };
}

// A 20ms View containing a 15ms View containing a 10ms View, 1ms self each.
// Summing their inclusive durations gives 45ms, more than the 25ms commit.
const nestedViews = [
  fiber({ actualDuration: 20, selfDuration: 1 }),
  fiber({ actualDuration: 15, selfDuration: 1 }),
  fiber({ actualDuration: 10, selfDuration: 1 }),
];

// The same three Views as DevTools records an update commit: post-order, so the
// innermost (smallest) instance comes first.
const parentRerender = {
  props: null,
  state: null,
  hooks: null,
  context: null,
  didHooksChange: false,
  isFirstMount: false,
};
const postOrderViews = [10, 15, 20].map((actualDuration) =>
  fiber({ actualDuration, selfDuration: 1, changeDescription: parentRerender })
);

describe("buildHotCommitSummaries — nested same-name instances", () => {
  it("reports the largest instance's inclusive duration and the summed self", () => {
    const [summary] = buildHotCommitSummaries(nestedViews, [0]);
    const view = summary!.components.find((c) => c.name === "View")!;

    expect(view.count).toBe(3);
    expect(view.actualDurationMs).toBe(20);
    expect(view.selfDurationMs).toBe(3);
  });

  it("reports the largest instance when DevTools lists the smallest first", () => {
    const [summary] = buildHotCommitSummaries(postOrderViews, [0]);
    const view = summary!.components.find((c) => c.name === "View")!;

    expect(view.count).toBe(3);
    expect(view.actualDurationMs).toBe(20);
  });
});

describe("getTopComponents (profiler-commit-query by_time_range)", () => {
  it("reports the largest instance's subtree and the summed self", () => {
    const [view] = getTopComponents(nestedViews, 10);

    expect(view!.count).toBe(3);
    expect(view!.maxSubtree).toBe(20);
    expect(view!.totalSelf).toBe(3);
  });

  it("reports the largest subtree when DevTools lists the smallest instance first", () => {
    const [view] = getTopComponents(postOrderViews, 10);

    expect(view!.count).toBe(3);
    expect(view!.maxSubtree).toBe(20);
  });

  it("ranks components by self time when truncating", () => {
    const entries = [
      fiber({ componentName: "Wrapper", actualDuration: 50, selfDuration: 0.5 }),
      fiber({ componentName: "Leaf", actualDuration: 10, selfDuration: 10 }),
    ];

    expect(getTopComponents(entries, 1).map((c) => c.name)).toEqual(["Leaf"]);
  });
});

describe("renderByComponent (profiler-commit-query by_component)", () => {
  it("prints the summed self and the largest subtree", () => {
    const markdown = renderByComponent(nestedViews, "View", 10);

    expect(markdown).toContain(
      "| Commit | Instances | Self (ms) | Largest subtree (ms) | Commit Total (ms) |"
    );
    expect(markdown).toContain("| #0 | 3 | 3.0 | 20.0 | 25.0 |");
  });

  it("prints the largest subtree when DevTools lists the smallest instance first", () => {
    const markdown = renderByComponent(postOrderViews, "View", 10);

    expect(markdown).toContain("| #0 | 3 | 3.0 | 20.0 | 25.0 |");
  });

  it("ranks commits by self time when truncating", () => {
    const commitA = fiber({ commitIndex: 0, actualDuration: 50, selfDuration: 0.5 });
    const commitB = [
      fiber({ commitIndex: 1, actualDuration: 12, selfDuration: 10 }),
      fiber({ commitIndex: 1, actualDuration: 12, selfDuration: 6 }),
      fiber({ commitIndex: 1, actualDuration: 12, selfDuration: 4 }),
    ];
    const markdown = renderByComponent([commitA, ...commitB], "View", 1);

    expect(markdown).toContain("| #1 |");
    expect(markdown).not.toContain("| #0 |");
  });
});

describe("profiler-commit-query by_time_range", () => {
  const PORT = 8081;
  const DEVICE = "by-time-range-test";
  const tempDirs: string[] = [];

  afterEach(async () => {
    clearCachedProfilerPaths(PORT, DEVICE);
    for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  it("prints the summed self and the largest subtree on each component line", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "commit-query-time-range-"));
    tempDirs.push(dir);
    const commitsPath = path.join(dir, "commits.json");
    await fs.writeFile(commitsPath, JSON.stringify({ commits: postOrderViews, meta: {} }));
    cacheProfilerPaths(
      PORT,
      {
        sessionId: "s",
        debugDir: dir,
        cpuProfilePath: null,
        commitsPath,
        cpuSampleIndexPath: null,
        detectedArchitecture: null,
        anyCompilerOptimized: null,
        hotCommitIndices: [0],
        totalReactCommits: 1,
      },
      DEVICE
    );

    const markdown = await profilerCommitQueryTool.execute({}, {
      port: PORT,
      device_id: DEVICE,
      mode: "by_time_range",
      time_range_ms: { start: 0, end: 200 },
    } as never);

    expect(markdown.split("\n")).toContain(
      "- `View` ×3 self 3.0ms, largest subtree 20.0ms — parent"
    );
  });
});
