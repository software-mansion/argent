import { describe, expect, it } from "vitest";
import { renderComponentCpu } from "../../src/tools/profiler/query/profiler-cpu-query";
import type { CpuSampleIndex } from "../../src/utils/react-profiler/pipeline/00-cpu-correlate";
import type { HermesProfileNode } from "../../src/utils/react-profiler/types/input";

function frame(functionName: string): HermesProfileNode["callFrame"] {
  return { functionName, url: "", scriptId: "0", lineNumber: -1, columnNumber: -1 };
}

/** Recursive `walk`: outer frame 2ms self, inner frame 5ms self. */
function nestedIndex(): CpuSampleIndex {
  const nodeMap = new Map<number, HermesProfileNode>();
  const mk = (id: number, name: string, children: number[]): HermesProfileNode => ({
    id,
    hitCount: 0,
    callFrame: frame(name),
    children,
  });
  nodeMap.set(1, mk(1, "(root)", [2]));
  nodeMap.set(2, mk(2, "walk", [3]));
  nodeMap.set(3, mk(3, "walk", []));
  const n = 7;
  return {
    timestampsMs: Float64Array.from({ length: n }, (_, i) => i + 1),
    intervalStartsMs: Float64Array.from({ length: n }, (_, i) => i),
    sampleNodeIds: Array.from({ length: n }, (_, i) => (i < 2 ? 2 : 3)),
    nodeMap,
    durationMs: n,
  };
}

/**
 * `root → wrapA → walk → walk` (recursion) plus `root → wrapB → walk` (a
 * disjoint call site). Self weights set the arrival order: `queryCpuWindow`
 * sorts by self DESC.
 */
function mixedIndex(disjointSelf: number, innerSelf: number, outerSelf: number): CpuSampleIndex {
  const nodeMap = new Map<number, HermesProfileNode>();
  const mk = (id: number, name: string, children: number[]): HermesProfileNode => ({
    id,
    hitCount: 0,
    callFrame: frame(name),
    children,
  });
  nodeMap.set(1, mk(1, "(root)", [2, 5]));
  nodeMap.set(2, mk(2, "wrapA", [3]));
  nodeMap.set(3, mk(3, "walk", [4]));
  nodeMap.set(4, mk(4, "walk", []));
  nodeMap.set(5, mk(5, "wrapB", [6]));
  nodeMap.set(6, mk(6, "walk", []));
  const n = disjointSelf + innerSelf + outerSelf;
  const sampleNodeIds: number[] = [];
  for (let i = 0; i < disjointSelf; i++) sampleNodeIds.push(6);
  for (let i = 0; i < innerSelf; i++) sampleNodeIds.push(4);
  for (let i = 0; i < outerSelf; i++) sampleNodeIds.push(3);
  return {
    timestampsMs: Float64Array.from({ length: n }, (_, i) => i + 1),
    intervalStartsMs: Float64Array.from({ length: n }, (_, i) => i),
    sampleNodeIds,
    nodeMap,
    durationMs: n,
  };
}

const oneCommit = {
  commits: [{ commitIndex: 0, timestamp: 0, commitDuration: 10, componentName: "Login" }],
};

function readRow(markdown: string, name: string): { self: number; total: number } {
  const row = markdown.split("\n").find((line) => line.startsWith(`| \`${name}\``));
  if (row === undefined) throw new Error(`no row for ${name} in:\n${markdown}`);
  const cells = row.split("|").map((c) => c.trim());
  return { self: Number(cells[2]), total: Number(cells[3]) };
}

describe("renderComponentCpu — one function as several call-tree nodes", () => {
  it("keeps the larger inclusive time for nested same-name frames", () => {
    const nested = {
      commits: [{ commitIndex: 0, timestamp: 0, commitDuration: 7, componentName: "Login" }],
    };
    const md = renderComponentCpu(nestedIndex(), nested, "Login", 10);
    const { self, total } = readRow(md, "walk");
    // Inclusive is the outer frame's 7ms, not 7 + 5.
    expect(self).toBeCloseTo(7, 5);
    expect(total).toBeCloseTo(7, 5);
  });

  it("unions nesting AND disjointness in one window (disjoint site arrives first)", () => {
    // Rows arrive by self DESC: disjoint 6, inner 3, outer 1. Inclusive is
    // outer subtree (1+3) + disjoint (6) = 10; summing all three reads 13.
    const md = renderComponentCpu(mixedIndex(6, 3, 1), oneCommit, "Login", 10);
    const { self, total } = readRow(md, "walk");
    expect(self).toBeCloseTo(10, 5);
    expect(total).toBeCloseTo(10, 5);
  });

  it("unions nesting AND disjointness when the recursive ancestor arrives first", () => {
    // Rows arrive outer 4, inner 2, disjoint 1. Inclusive: (4+2) + 1 = 7.
    const md = renderComponentCpu(mixedIndex(1, 2, 4), oneCommit, "Login", 10);
    const { self, total } = readRow(md, "walk");
    expect(self).toBeCloseTo(7, 5);
    expect(total).toBeCloseTo(7, 5);
  });
});
