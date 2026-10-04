import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { __testables } from "../../src/tools/profiler/react/react-profiler-renders";

/**
 * COLLECT_RENDERS_SCRIPT walks the live fiber tree and groups by component
 * name. `actualDuration` is inclusive — self plus the whole subtree the fiber
 * owns — and same-named instances are routinely nested (a View inside a View),
 * so summing it double-counts every nesting level. The script keeps the largest
 * single instance's figure instead; self time is exclusive and keeps summing.
 * This is the live-tree twin of the grouped-row fixes in 00-hot-commits.ts and
 * profiler-commit-query.ts, so it gets the same semantic pinning.
 */
const { COLLECT_RENDERS_SCRIPT } = __testables;

function runScript(rootFiber: unknown): string {
  const hook = {
    _renderers: { 1: {} },
    __argent_roots__: [{ current: rootFiber }],
  };
  return runInNewContext(COLLECT_RENDERS_SCRIPT, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: hook,
    JSON,
    Object,
  }) as string;
}

const view = (actualDuration: number, selfBaseDuration: number, child?: unknown) => ({
  type: "View",
  actualDuration,
  selfBaseDuration,
  child: child ?? null,
});

describe("COLLECT_RENDERS_SCRIPT — nested same-name fibers", () => {
  it("reports the largest instance's subtree for maxActualDuration, not the nested sum", () => {
    // Three nested Views: 20ms outer containing a 15ms inner containing a 10ms leaf.
    const json = runScript(view(20, 1, view(15, 1, view(10, 1))));
    const parsed = JSON.parse(json) as Record<
      string,
      { instanceCount: number; maxActualDuration: number; selfBaseDuration: number }
    >;

    const viewRow = parsed["View"]!;
    expect(viewRow.instanceCount).toBe(3);
    expect(viewRow.maxActualDuration).toBe(20);
    // Self time is exclusive, so it adds across all three instances.
    expect(viewRow.selfBaseDuration).toBe(3);
  });

  it("keeps the larger sibling's subtree when the outer instance arrives first", () => {
    const json = runScript(view(5, 0, undefined));
    const parsed = JSON.parse(json) as Record<string, { maxActualDuration: number }>;
    expect(parsed["View"]!.maxActualDuration).toBe(5);
  });
});
