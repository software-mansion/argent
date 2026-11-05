import { describe, expect, it } from "vitest";
import { renderComponentCpu } from "../../src/tools/profiler/query/profiler-cpu-query";
import {
  queryCpuWindow,
  type CpuSampleIndex,
} from "../../src/utils/react-profiler/pipeline/00-cpu-correlate";
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

describe("renderComponentCpu — a window with more call-tree nodes than one hotspot page", () => {
  it("still sees the outer frame of a recursion that ranks below 50 other nodes", () => {
    // root → walk (1 sample) → walk (3 samples), beside 50 busier siblings (2 samples
    // each), so the outer walk ranks 52nd by self time.
    const nodeMap = new Map<number, HermesProfileNode>();
    const mk = (id: number, name: string, children: number[]): HermesProfileNode => ({
      id,
      hitCount: 0,
      callFrame: frame(name),
      children,
    });
    const siblings = Array.from({ length: 50 }, (_, i) => 10 + i);
    nodeMap.set(1, mk(1, "(root)", [2, ...siblings]));
    nodeMap.set(2, mk(2, "walk", [3]));
    nodeMap.set(3, mk(3, "walk", []));
    for (const id of siblings) nodeMap.set(id, mk(id, `f${id}`, []));
    const sampleNodeIds = [2, 3, 3, 3, ...siblings.flatMap((id) => [id, id])];
    const n = sampleNodeIds.length;
    const index: CpuSampleIndex = {
      timestampsMs: Float64Array.from({ length: n }, (_, i) => i + 1),
      intervalStartsMs: Float64Array.from({ length: n }, (_, i) => i),
      sampleNodeIds,
      nodeMap,
      durationMs: n,
    };
    const commit = {
      commits: [{ commitIndex: 0, timestamp: 0, commitDuration: n, componentName: "Login" }],
    };
    const { self, total } = readRow(renderComponentCpu(index, commit, "Login", 10), "walk");
    // The outer frame's 1 + the inner frame's 3, not the inner frame alone.
    expect(self).toBeCloseTo(4, 5);
    expect(total).toBeCloseTo(4, 5);
  });
});

describe("renderComponentCpu — frames without self samples", () => {
  const mk = (id: number, name: string, children: number[]): HermesProfileNode => ({
    id,
    hitCount: 0,
    callFrame: frame(name),
    children,
  });
  const indexOf = (nodeMap: Map<number, HermesProfileNode>, sampleNodeIds: number[]) => {
    const n = sampleNodeIds.length;
    return {
      timestampsMs: Float64Array.from({ length: n }, (_, i) => i + 1),
      intervalStartsMs: Float64Array.from({ length: n }, (_, i) => i),
      sampleNodeIds,
      nodeMap,
      durationMs: n,
    } satisfies CpuSampleIndex;
  };

  it("counts the inclusive time of a recursion's outer frame that took no self sample", () => {
    // root → wrap (0 samples) → walk (0 samples) → [walk (1 sample), leaf (3 samples)].
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, mk(1, "(root)", [5]));
    nodeMap.set(5, mk(5, "wrap", [2]));
    nodeMap.set(2, mk(2, "walk", [3, 4]));
    nodeMap.set(3, mk(3, "walk", []));
    nodeMap.set(4, mk(4, "leaf", []));
    const commit = {
      commits: [{ commitIndex: 0, timestamp: 0, commitDuration: 4, componentName: "Login" }],
    };
    const md = renderComponentCpu(indexOf(nodeMap, [3, 4, 4, 4]), commit, "Login", 10);
    expect(readRow(md, "walk")).toEqual({ self: 1, total: 4 });
    expect(readRow(md, "leaf")).toEqual({ self: 3, total: 3 });
    // A frame with no self time stays out of the table.
    expect(md).not.toContain("`wrap`");
  });

  it("lists the callers of the sampled frames only when asked to", () => {
    // root → wrap (0 samples) → leaf (2 samples).
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, mk(1, "(root)", [2]));
    nodeMap.set(2, mk(2, "wrap", [3]));
    nodeMap.set(3, mk(3, "leaf", []));
    const index = indexOf(nodeMap, [3, 3]);
    const names = (r: ReturnType<typeof queryCpuWindow>) => r.hotspots.map((h) => h.name);
    expect(names(queryCpuWindow(index, 0, 2))).toEqual(["leaf"]);
    const all = queryCpuWindow(index, 0, 2, Infinity, { withCallers: true });
    expect(all.hotspots.find((h) => h.name === "wrap")).toMatchObject({ selfMs: 0, totalMs: 2 });
  });

  it("adds a function's self and inclusive time across the component's commits", () => {
    // Commit 0 spends 2 samples in walk → leaf, commit 1 spends 3 in walk alone.
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, mk(1, "(root)", [2]));
    nodeMap.set(2, mk(2, "walk", [3]));
    nodeMap.set(3, mk(3, "leaf", []));
    const commits = {
      commits: [
        { commitIndex: 0, timestamp: 0, commitDuration: 2, componentName: "Login" },
        { commitIndex: 1, timestamp: 2, commitDuration: 3, componentName: "Login" },
      ],
    };
    const md = renderComponentCpu(indexOf(nodeMap, [2, 3, 2, 2, 2]), commits, "Login", 10);
    expect(readRow(md, "walk")).toEqual({ self: 4, total: 5 });
  });

  it("ranks rows by self time when truncating to top_n", () => {
    // outer: 1 self, 4 inclusive; inner: 3 self, 3 inclusive.
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, mk(1, "(root)", [2]));
    nodeMap.set(2, mk(2, "outer", [3]));
    nodeMap.set(3, mk(3, "inner", []));
    const commit = {
      commits: [{ commitIndex: 0, timestamp: 0, commitDuration: 4, componentName: "Login" }],
    };
    const md = renderComponentCpu(indexOf(nodeMap, [2, 3, 3, 3]), commit, "Login", 1);
    expect(readRow(md, "inner")).toEqual({ self: 3, total: 3 });
    expect(md).not.toContain("`outer`");
  });
});
