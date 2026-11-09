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

describe("renderComponentCpu — which same-name frames count as outermost", () => {
  const mk = (id: number, name: string, children: number[]): HermesProfileNode => ({
    id,
    hitCount: 0,
    callFrame: frame(name),
    children,
  });
  const run = (nodeMap: Map<number, HermesProfileNode>, sampleNodeIds: number[]) => {
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
    return renderComponentCpu(index, commit, "Login", 10);
  };

  it("nests a frame under a namesake that is not its parent, at any depth", () => {
    // root → walk (1) → step (1) → walk (1) → walk (2): one recursion, 5ms inclusive.
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, mk(1, "(root)", [2]));
    nodeMap.set(2, mk(2, "walk", [3]));
    nodeMap.set(3, mk(3, "step", [4]));
    nodeMap.set(4, mk(4, "walk", [5]));
    nodeMap.set(5, mk(5, "walk", []));
    const md = run(nodeMap, [2, 3, 4, 5, 5]);
    expect(readRow(md, "walk")).toEqual({ self: 4, total: 5 });
    expect(readRow(md, "step")).toEqual({ self: 1, total: 4 });
  });

  it("counts each of two sibling recursions as outermost", () => {
    // root → [a → walk (1) → walk (2), b → walk (3) → walk (1)].
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, mk(1, "(root)", [2, 5]));
    nodeMap.set(2, mk(2, "a", [3]));
    nodeMap.set(3, mk(3, "walk", [4]));
    nodeMap.set(4, mk(4, "walk", []));
    nodeMap.set(5, mk(5, "b", [6]));
    nodeMap.set(6, mk(6, "walk", [7]));
    nodeMap.set(7, mk(7, "walk", []));
    const md = run(nodeMap, [3, 4, 4, 6, 6, 6, 7]);
    expect(readRow(md, "walk")).toEqual({ self: 7, total: 7 });
  });

  it("follows the parent each node's time is attributed to when a profile lists a child twice", () => {
    // walk (5) is listed under both `a` and `b`; its time goes up through `b`,
    // the later parent, so `a`'s walk does not enclose it. 99 is listed but absent.
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, mk(1, "(root)", [2, 3, 99]));
    nodeMap.set(2, mk(2, "walk", [5]));
    nodeMap.set(3, mk(3, "b", [5]));
    nodeMap.set(5, mk(5, "walk", []));
    const md = run(nodeMap, [2, 5, 5]);
    expect(readRow(md, "walk")).toEqual({ self: 3, total: 3 });
  });

  it("looks up each parent link a bounded number of times on a deep recursion", () => {
    // root → walk → walk → … 2000 deep, one sample at the bottom: every frame is a row.
    const depth = 2000;
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(0, mk(0, "(root)", [1]));
    for (let id = 1; id <= depth; id++) {
      nodeMap.set(id, mk(id, "walk", id < depth ? [id + 1] : []));
    }
    class CountingMap extends Map<number, number> {
      lookups = 0;
      override get(key: number) {
        this.lookups++;
        return super.get(key);
      }
      override has(key: number) {
        this.lookups++;
        return super.has(key);
      }
    }
    const childToParent = new CountingMap();
    for (let id = 1; id <= depth; id++) childToParent.set(id, id - 1);
    const index: CpuSampleIndex = {
      timestampsMs: Float64Array.of(1),
      intervalStartsMs: Float64Array.of(0),
      sampleNodeIds: [depth],
      nodeMap,
      durationMs: 1,
      childToParent,
    };
    const commit = {
      commits: [{ commitIndex: 0, timestamp: 0, commitDuration: 1, componentName: "Login" }],
    };
    expect(readRow(renderComponentCpu(index, commit, "Login", 10), "walk")).toEqual({
      self: 1,
      total: 1,
    });
    // Linear in depth; walking to the root once per frame costs depth² / 2.
    expect(childToParent.lookups).toBeLessThan(10 * depth);
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

describe("renderComponentCpu — the Location of a row", () => {
  const at = (id: number, name: string, line: number, children: number[]): HermesProfileNode => ({
    id,
    hitCount: 0,
    callFrame: { ...frame(name), url: `http://x/src/${name}.js`, lineNumber: line },
    children,
  });
  const index = (nodeMap: Map<number, HermesProfileNode>, sampleNodeIds: number[]) => {
    const n = sampleNodeIds.length;
    return {
      timestampsMs: Float64Array.from({ length: n }, (_, i) => i + 1),
      intervalStartsMs: Float64Array.from({ length: n }, (_, i) => i),
      sampleNodeIds,
      nodeMap,
      durationMs: n,
    } satisfies CpuSampleIndex;
  };
  const twoCommits = (firstMs: number, secondMs: number) => ({
    commits: [
      { commitIndex: 0, timestamp: 0, commitDuration: firstMs, componentName: "Login" },
      { commitIndex: 1, timestamp: firstMs, commitDuration: secondMs, componentName: "Login" },
    ],
  });
  const locationOf = (markdown: string, name: string) =>
    markdown
      .split("\n")
      .find((line) => line.startsWith(`| \`${name}\``))
      ?.split("|")[4]
      ?.trim();

  it("is not taken from a node with no self time in an earlier commit", () => {
    // Commit 0: render@10 → leaf (2 samples, all in leaf); commit 1: render@20 (3 samples).
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, { id: 1, hitCount: 0, callFrame: frame("(root)"), children: [2, 4] });
    nodeMap.set(2, at(2, "render", 10, [3]));
    nodeMap.set(3, at(3, "leaf", 5, []));
    nodeMap.set(4, at(4, "render", 20, []));
    const md = renderComponentCpu(index(nodeMap, [3, 3, 4, 4, 4]), twoCommits(2, 3), "Login", 10);
    expect(readRow(md, "render")).toEqual({ self: 3, total: 5 });
    expect(locationOf(md, "render")).toBe("src/render.js:20");
  });

  it("is the line with the most self time, not the most inclusive time", () => {
    // render@10: 1 sample, calling leaf for 4; render@20: 3 samples.
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, { id: 1, hitCount: 0, callFrame: frame("(root)"), children: [2, 4] });
    nodeMap.set(2, at(2, "render", 10, [3]));
    nodeMap.set(3, at(3, "leaf", 5, []));
    nodeMap.set(4, at(4, "render", 20, []));
    const commit = {
      commits: [{ commitIndex: 0, timestamp: 0, commitDuration: 8, componentName: "Login" }],
    };
    const md = renderComponentCpu(index(nodeMap, [2, 3, 3, 3, 3, 4, 4, 4]), commit, "Login", 10);
    expect(readRow(md, "render")).toEqual({ self: 4, total: 8 });
    expect(locationOf(md, "render")).toBe("src/render.js:20");
  });

  it("is the line with the most self time summed over the commits", () => {
    // render@10: 2 samples in each commit; render@20: 3 samples in commit 1 only.
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, { id: 1, hitCount: 0, callFrame: frame("(root)"), children: [2, 3] });
    nodeMap.set(2, at(2, "render", 10, []));
    nodeMap.set(3, at(3, "render", 20, []));
    const md = renderComponentCpu(
      index(nodeMap, [2, 2, 3, 3, 3, 2, 2]),
      twoCommits(2, 5),
      "Login",
      10
    );
    expect(readRow(md, "render").self).toBe(7);
    expect(locationOf(md, "render")).toBe("src/render.js:10");
  });

  it("is the line that overtakes in a later commit the one that led the first", () => {
    // Commit 0: render@10 2 samples, render@20 1; commit 1: render@20 2. Totals 2 vs 3.
    const nodeMap = new Map<number, HermesProfileNode>();
    nodeMap.set(1, { id: 1, hitCount: 0, callFrame: frame("(root)"), children: [2, 3] });
    nodeMap.set(2, at(2, "render", 10, []));
    nodeMap.set(3, at(3, "render", 20, []));
    const md = renderComponentCpu(index(nodeMap, [2, 2, 3, 3, 3]), twoCommits(3, 2), "Login", 10);
    expect(readRow(md, "render").self).toBe(5);
    expect(locationOf(md, "render")).toBe("src/render.js:20");
  });
});
