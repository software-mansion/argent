import { describe, expect, it } from "vitest";
import { buildHotCommitSummaries } from "../../src/utils/react-profiler/pipeline/00-hot-commits";
import { __testables } from "../../src/tools/profiler/query/profiler-commit-query";
import type { DevToolsFiberCommit } from "../../src/utils/react-profiler/types/input";

/**
 * Same-named fibers in one commit are routinely NESTED — a `View` rendered
 * inside another `View`. React's `actualDuration` is inclusive (self + subtree),
 * so an ancestor's figure already contains its descendants'. Adding those up
 * across the group double-counts the same work and produces grouped rows whose
 * "w/children" exceed the duration of the commit containing them.
 */
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

// Outer View (20ms inclusive) contains the middle one (15ms), which contains
// the inner one (10ms). Each contributes 1ms of its own work.
const nestedViews = [
  fiber({ actualDuration: 20, selfDuration: 1 }),
  fiber({ actualDuration: 15, selfDuration: 1 }),
  fiber({ actualDuration: 10, selfDuration: 1 }),
];

describe("buildHotCommitSummaries — grouped component durations", () => {
  it("reports the largest instance's subtree, not the sum, for w/children", () => {
    const [summary] = buildHotCommitSummaries(nestedViews, [0]);
    const view = summary.components.find((c) => c.name === "View");

    expect(view).toBeDefined();
    expect(view!.count).toBe(3);
    // Inclusive durations are not additive across instances: 20+15+10 = 45 is
    // the double-counted figure this guards against.
    expect(view!.actualDurationMs).toBe(20);
  });

  it("keeps summing self-duration, which is exclusive and therefore additive", () => {
    const [summary] = buildHotCommitSummaries(nestedViews, [0]);
    const view = summary.components.find((c) => c.name === "View")!;

    expect(view.selfDurationMs).toBe(3);
  });

  it("never reports a grouped subtree longer than the commit that contains it", () => {
    const [summary] = buildHotCommitSummaries(nestedViews, [0]);

    for (const component of summary.components) {
      expect(component.actualDurationMs).toBeLessThanOrEqual(summary.totalRenderMs);
    }
  });
});

/**
 * The same double-count applies wherever durations are grouped by component or
 * function name; `buildHotCommitSummaries` is one of the grouping sites.
 */
describe("getTopComponents (profiler-commit-query by_time_range)", () => {
  it("reports the largest instance's subtree and the summed self time", () => {
    const [view] = __testables.getTopComponents(nestedViews, 10);

    expect(view!.count).toBe(3);
    // 20 + 15 + 10 = 45 is the double-counted figure, larger than the 20ms commit.
    expect(view!.maxSubtree).toBe(20);
    expect(view!.totalSelf).toBe(3);
  });
});

/**
 * `by_component` ranks and truncates commits by summed SELF time — the
 * additive column. Ranking by the max-instance order statistic instead would
 * drop, at the truncation cut, a commit where the component did more total
 * work than one with a single expensive instance.
 */
describe("renderByComponent (profiler-commit-query by_component) ranking", () => {
  it("keeps the commit with the most self work when truncating to one row", () => {
    const commitA = fiber({ commitIndex: 0, actualDuration: 50, selfDuration: 0.5 });
    const commitB = [
      fiber({ commitIndex: 1, actualDuration: 12, selfDuration: 10 }),
      fiber({ commitIndex: 1, actualDuration: 12, selfDuration: 6 }),
      fiber({ commitIndex: 1, actualDuration: 12, selfDuration: 4 }),
    ];
    const markdown = __testables.renderByComponent([commitA, ...commitB], "View", 1);

    expect(markdown).toContain("| #1 |");
    expect(markdown).not.toContain("| #0 |");
  });

  it("treats durations nulled or dropped by JSON round-trip as zero instead of NaN or a crash", () => {
    const nulled = fiber({ actualDuration: null as unknown as number });
    const dropped = fiber({});
    delete (dropped as Partial<DevToolsFiberCommit>).actualDuration;

    // getTopComponents feeds by_time_range, which calls .toFixed on this
    // figure; a bare null throws there.
    const [view] = __testables.getTopComponents([nulled], 10);
    expect(view!.maxSubtree).toBe(0);

    // An absent duration makes Math.max(0, undefined) NaN without the guard.
    const markdown = __testables.renderByComponent([dropped], "View", 10);
    expect(markdown).toContain("0.0");
    expect(markdown).not.toContain("NaN");
    expect(() => __testables.renderByComponent([nulled], "View", 10)).not.toThrow();
  });
});
