import { describe, expect, it } from "vitest";
import { __testables } from "../../src/tools/profiler/query/profiler-commit-query";
import type { DevToolsFiberCommit } from "../../src/utils/react-profiler/types/input";

const { renderByIndex, renderCascadeTree } = __testables;

const base = {
  commitIndex: 0,
  timestamp: 100,
  componentName: "View",
  actualDuration: 20,
  selfDuration: 1,
  commitDuration: 20,
  didRender: true,
  changeDescription: null,
} as DevToolsFiberCommit;

/**
 * by_index and cascade_tree read the same session dumps as the grouped views:
 * a non-finite duration becomes JSON null on disk and an absent key stays
 * absent, so both modes must print 0 rather than "NaN" or a TypeError.
 */
describe("by_index / cascade_tree treat dump-read nulled or dropped durations as zero", () => {
  it("renderByIndex prints zeros for a nulled duration instead of throwing", () => {
    const nulled = {
      ...base,
      actualDuration: null,
      selfDuration: null,
    } as unknown as DevToolsFiberCommit;
    const md = renderByIndex([nulled], 0, 10);
    expect(md).toContain("| `View` | 0.0 | 0.0 |");
    expect(md).not.toContain("NaN");
  });

  it("renderCascadeTree sums an absent duration as zero", () => {
    const dropped = { ...base };
    delete (dropped as Partial<DevToolsFiberCommit>).selfDuration;
    const md = renderCascadeTree([dropped], 0);
    expect(md).toContain("self=0.0ms");
    expect(md).not.toContain("NaN");
  });

  it("renderByIndex sorts nulled durations last without crashing", () => {
    const healthy: DevToolsFiberCommit = { ...base, componentName: "Text", actualDuration: 5 };
    const nulled = {
      ...base,
      componentName: "Header",
      actualDuration: null,
    } as unknown as DevToolsFiberCommit;
    const md = renderByIndex([nulled, healthy], 0);
    expect(md.indexOf("`Text`")).toBeLessThan(md.indexOf("`Header`"));
    expect(md).toContain("0.0");
  });
});
