import { describe, expect, it } from "vitest";
import { buildHotCommitSummaries } from "../../src/utils/react-profiler/pipeline/00-hot-commits";
import {
  getTopComponents,
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
    commitDuration: 20,
    didRender: true,
    changeDescription: null,
    ...overrides,
  };
}

// A 20ms View containing a 15ms View containing a 10ms View, 1ms self each.
// Summing their inclusive durations gives 45ms, more than the 20ms commit.
const nestedViews = [
  fiber({ actualDuration: 20, selfDuration: 1 }),
  fiber({ actualDuration: 15, selfDuration: 1 }),
  fiber({ actualDuration: 10, selfDuration: 1 }),
];

describe("buildHotCommitSummaries — nested same-name instances", () => {
  it("reports the largest instance's inclusive duration and the summed self", () => {
    const [summary] = buildHotCommitSummaries(nestedViews, [0]);
    const view = summary!.components.find((c) => c.name === "View")!;

    expect(view.count).toBe(3);
    expect(view.actualDurationMs).toBe(20);
    expect(view.selfDurationMs).toBe(3);
  });
});

describe("getTopComponents (profiler-commit-query by_time_range)", () => {
  it("reports the largest instance's subtree and the summed self", () => {
    const [view] = getTopComponents(nestedViews, 10);

    expect(view!.count).toBe(3);
    expect(view!.maxSubtree).toBe(20);
    expect(view!.totalSelf).toBe(3);
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

    expect(markdown).toContain("| #0 | 3 | 3.0 | 20.0 | 20.0 |");
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
