import { describe, expect, it } from "vitest";
import { __testables } from "../../src/tools/profiler/query/profiler-commit-query";
import type { DevToolsFiberCommit } from "../../src/utils/react-profiler/types/input";

const { renderCascadeTree } = __testables;

const base = {
  commitIndex: 0,
  timestamp: 100,
  actualDuration: 10,
  selfDuration: 1,
  commitDuration: 20,
  didRender: true,
  changeDescription: null,
} as DevToolsFiberCommit;

/**
 * Mutually recursive components (A renders B renders A) put a cycle in the
 * name→parentName edges. The cascade walk dedupes on `name:depth`, which a
 * cycle never repeats — without a path guard it descends until the stack
 * overflows and the tool call fails.
 */
describe("renderCascadeTree survives a cycle in parent-name edges", () => {
  it("renders a mutually recursive A→B→A pair once per side instead of overflowing", () => {
    const commits: DevToolsFiberCommit[] = [
      { ...base, componentName: "A", parentName: null },
      { ...base, componentName: "B", parentName: "A" },
      { ...base, componentName: "A", parentName: "B" },
    ];
    const md = renderCascadeTree(commits, 0);
    expect(md).toContain("`A`");
    expect(md).toContain("`B`");
  });

  it("still renders a deep non-cyclic chain in full", () => {
    const commits: DevToolsFiberCommit[] = [
      { ...base, componentName: "Root", parentName: null },
      { ...base, componentName: "Mid", parentName: "Root" },
      { ...base, componentName: "Leaf", parentName: "Mid" },
    ];
    const md = renderCascadeTree(commits, 0);
    expect(md).toContain("  - `Mid`");
    expect(md).toContain("    - `Leaf`");
  });
});
