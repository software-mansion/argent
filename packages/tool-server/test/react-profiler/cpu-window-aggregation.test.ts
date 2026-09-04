import { describe, expect, it } from "vitest";
import { __testables } from "../../src/tools/profiler/query/profiler-cpu-query";
import type { CpuSampleIndex } from "../../src/utils/react-profiler/pipeline/00-cpu-correlate";
import type { HermesProfileNode } from "../../src/utils/react-profiler/types/input";

/**
 * `profiler-cpu-query component_name=…` aggregates CPU along two axes at once,
 * and they need opposite treatment.
 *
 * Across commit windows — disjoint stretches of wall clock — a function's
 * inclusive time in one cannot overlap its time in another, so both columns add.
 *
 * Within a window the same function can arrive as several call-tree NODES:
 * - disjoint nodes (the same helper called from two unrelated call sites) are
 *   separate subtrees, so both columns add;
 * - nested nodes (recursion) overlap — the outer frame's inclusive time already
 *   contains the inner one's — so self still adds but inclusive keeps the larger.
 *
 * Getting either axis wrong is visible in the output: summing nested inclusive
 * times inflates them past what the tree contains, and an exclusive column summed
 * against an inclusive column maxed prints rows whose `Self` exceeds their own
 * `Total`, which no single frame can do.
 */
const { renderComponentCpu } = __testables;

/**
 * One flat node: `parse` called under a root, no recursion.
 *
 * Takes the END of each sample's interval. Sample `i` stands for
 * `(t[i-1], t[i]]` — the weighting `buildCpuSampleIndex` derives from Hermes'
 * `timeDeltas`, and what `queryCpuWindow` integrates over a window.
 */
function flatIndex(sampleEndsMs: number[]): CpuSampleIndex {
  const nodeMap = new Map<number, HermesProfileNode>();
  nodeMap.set(1, {
    id: 1,
    hitCount: 0,
    callFrame: { functionName: "(root)", url: "", scriptId: "0", lineNumber: -1, columnNumber: -1 },
    children: [2],
  });
  nodeMap.set(2, {
    id: 2,
    hitCount: sampleEndsMs.length,
    callFrame: {
      functionName: "parse",
      url: "http://localhost/bundle.js",
      scriptId: "1",
      lineNumber: 10,
      columnNumber: 0,
    },
    children: [],
  });
  return {
    timestampsMs: Float64Array.from(sampleEndsMs),
    intervalStartsMs: Float64Array.from(sampleEndsMs, (_, i) =>
      i === 0 ? 0 : sampleEndsMs[i - 1]!
    ),
    sampleNodeIds: sampleEndsMs.map(() => 2),
    nodeMap,
    durationMs: sampleEndsMs[sampleEndsMs.length - 1]!,
  };
}

// A sample every 1ms out to 15ms, so both commit windows below are fully
// covered and each one's self-time comes to its own 5ms width.
const everyMs = Array.from({ length: 15 }, (_, i) => i + 1);
const firstCommitOnly = everyMs.slice(0, 5);

function frame(functionName: string): HermesProfileNode["callFrame"] {
  return { functionName, url: "", scriptId: "0", lineNumber: -1, columnNumber: -1 };
}

/**
 * Two DISTINCT `parse` nodes under different parents — the same helper called
 * from two unrelated call sites. Samples alternate between them inside one
 * window, so each ends up with 5ms of self time.
 */
function siblingIndex(): CpuSampleIndex {
  const nodeMap = new Map<number, HermesProfileNode>();
  const mk = (id: number, name: string, children: number[]): HermesProfileNode => ({
    id,
    hitCount: 0,
    callFrame: frame(name),
    children,
  });
  nodeMap.set(1, mk(1, "(root)", [2, 3]));
  nodeMap.set(2, mk(2, "helperA", [4]));
  nodeMap.set(3, mk(3, "helperB", [5]));
  nodeMap.set(4, mk(4, "parse", []));
  nodeMap.set(5, mk(5, "parse", []));
  const n = 10;
  return {
    timestampsMs: Float64Array.from({ length: n }, (_, i) => i + 1),
    intervalStartsMs: Float64Array.from({ length: n }, (_, i) => i),
    sampleNodeIds: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 4 : 5)),
    nodeMap,
    durationMs: n,
  };
}

/**
 * Recursive `walk`: the outer frame (node 2) holds 2ms of self, its inner frame
 * (node 3) holds 5ms. The outer's inclusive time is 7ms and already contains
 * the inner's 5ms.
 */
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
 * Three same-name `walk` nodes in one tree mixing BOTH shapes at once: a
 * recursive pair (`root → wrapA → walk-outer → walk-inner`) plus a disjoint
 * second call site (`root → wrapB → walk-disjoint`). Self-time weights are
 * parameters so tests can force any arrival order — `queryCpuWindow` sorts by
 * self DESC. The wrapper frames carry no samples, so the `walk` figures come
 * purely from their own nodes.
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

/** One commit covering the whole index, on `Login`. */
const oneCommit = {
  commits: [{ commitIndex: 0, timestamp: 0, commitDuration: 10, componentName: "Login" }],
};

/** Two commits, 10 ms apart, each 5 ms long — disjoint windows. */
const twoCommits = {
  commits: [
    {
      commitIndex: 0,
      timestamp: 0,
      commitDuration: 5,
      componentName: "Login",
    },
    {
      commitIndex: 1,
      timestamp: 10,
      commitDuration: 5,
      componentName: "Login",
    },
  ],
};

/** `| \`name\` | self | total | loc |` → the two numbers. */
function readRow(markdown: string, name: string): { self: number; total: number } {
  const row = markdown.split("\n").find((line) => line.startsWith(`| \`${name}\``));
  if (row === undefined) throw new Error(`no row for ${name} in:\n${markdown}`);
  const cells = row.split("|").map((c) => c.trim());
  return { self: Number(cells[2]), total: Number(cells[3]) };
}

describe("renderComponentCpu — aggregating one function across commit windows", () => {
  // Whatever the per-window figures come to, the two windows are separate
  // stretches of time, so the row must add them rather than report one window's.
  const markdown = renderComponentCpu(flatIndex(everyMs), twoCommits, "Login", 10);

  it("never prints a self time longer than the inclusive time beside it", () => {
    const { self, total } = readRow(markdown, "parse");
    expect(self).toBeLessThanOrEqual(total);
  });

  it("adds the disjoint windows rather than keeping the larger one", () => {
    const oneWindow = renderComponentCpu(
      flatIndex(firstCommitOnly),
      { commits: [twoCommits.commits[0]!] },
      "Login",
      10
    );
    const single = readRow(oneWindow, "parse");
    const both = readRow(markdown, "parse");

    expect(both.self).toBeCloseTo(single.self * 2, 5);
    expect(both.total).toBeCloseTo(single.total * 2, 5);
  });

  it("stays within the total commit time it prints in the header", () => {
    const { total } = readRow(markdown, "parse");
    const commitTotal = Number(/\*\*Total commit time:\*\* ([\d.]+)ms/.exec(markdown)![1]);
    expect(total).toBeLessThanOrEqual(commitTotal);
  });
});

describe("renderComponentCpu — one function arriving as several nodes in ONE window", () => {
  it("adds both columns for disjoint same-name nodes", () => {
    const { self, total } = readRow(
      renderComponentCpu(siblingIndex(), oneCommit, "Login", 10),
      "parse"
    );
    expect(self).toBeCloseTo(10, 5);
    expect(total).toBeCloseTo(10, 5);
    expect(self).toBeLessThanOrEqual(total);
  });

  it("keeps the larger inclusive time for nested same-name frames", () => {
    const nested = {
      commits: [{ commitIndex: 0, timestamp: 0, commitDuration: 7, componentName: "Login" }],
    };
    const md = renderComponentCpu(nestedIndex(), nested, "Login", 10);
    const { self, total } = readRow(md, "walk");
    // self adds: 2ms outer + 5ms inner. Inclusive must be the outer frame's
    // whole subtree (7ms), not the sum of the two overlapping figures (12ms).
    expect(self).toBeCloseTo(7, 5);
    expect(total).toBeCloseTo(7, 5);
    expect(self).toBeLessThanOrEqual(total);
  });

  it("unions nesting AND disjointness in one window (disjoint site arrives first)", () => {
    // selfs: disjoint 6 > inner 3 > outer 1 — the disjoint node sorts first.
    // Inclusive truth: outer subtree (1+3=4) + disjoint (6) = 10. Summing all
    // three rows would read 13; maxing pairwise against the seed row also
    // misses either the disjoint or the outer figure depending on order.
    const md = renderComponentCpu(mixedIndex(6, 3, 1), oneCommit, "Login", 10);
    const { self, total } = readRow(md, "walk");
    expect(self).toBeCloseTo(10, 5);
    expect(total).toBeCloseTo(10, 5);
  });

  it("unions nesting AND disjointness when the recursive ancestor arrives first", () => {
    // selfs: outer 4 > inner 2 > disjoint 1. Inclusive truth: outer subtree
    // (4+2=6) + disjoint (1) = 7.
    const md = renderComponentCpu(mixedIndex(1, 2, 4), oneCommit, "Login", 10);
    const { self, total } = readRow(md, "walk");
    expect(self).toBeCloseTo(7, 5);
    expect(total).toBeCloseTo(7, 5);
  });
});
