import { describe, expect, it } from "vitest";
import { buildHotCommitSummaries } from "../../src/utils/react-profiler/pipeline/00-hot-commits";
import type { DevToolsFiberCommit } from "../../src/utils/react-profiler/types/input";

/**
 * Same-named fibers in one commit are routinely NESTED — a `View` rendered
 * inside another `View`. React's `actualDuration` is inclusive (self + subtree),
 * so an ancestor's figure already contains its descendants'. Adding those up
 * across the group double-counts the same work and produced grouped rows whose
 * "w/children" exceeded the duration of the commit containing them.
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

describe("buildHotCommitSummaries — grouped component durations", () => {
  // Outer View (20ms inclusive) contains the middle one (15ms), which contains
  // the inner one (10ms). Each contributes 1ms of its own work.
  const nestedViews = [
    fiber({ actualDuration: 20, selfDuration: 1 }),
    fiber({ actualDuration: 15, selfDuration: 1 }),
    fiber({ actualDuration: 10, selfDuration: 1 }),
  ];

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
