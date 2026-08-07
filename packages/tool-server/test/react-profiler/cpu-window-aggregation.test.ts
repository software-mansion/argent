import { describe, expect, it } from "vitest";
import { __testables } from "../../src/tools/profiler/query/profiler-cpu-query";
import type { CpuSampleIndex } from "../../src/utils/react-profiler/pipeline/00-cpu-correlate";
import type { HermesProfileNode } from "../../src/utils/react-profiler/types/input";

/**
 * `profiler-cpu-query component_name=…` aggregates CPU along two axes at once,
 * and they need opposite treatment.
 *
 * Across commit windows — disjoint stretches of wall clock — a function's
 * inclusive time in one window cannot overlap its time in another, so both
 * columns add. Within a window the same function can arrive as several
 * call-tree nodes, and a recursive frame's inclusive time already contains its
 * own inner frame's, so those cannot.
 *
 * Getting the first axis wrong is visible in the output: an exclusive column
 * summed against an inclusive column maxed prints rows whose `Self` exceeds
 * their own `Total`, which no single frame can do.
 */
const { renderComponentCpu } = __testables;

/** One flat node: `parse` called under a root, no recursion. */
function flatIndex(sampleTimesMs: number[]): CpuSampleIndex {
  const nodeMap = new Map<number, HermesProfileNode>();
  nodeMap.set(1, {
    id: 1,
    hitCount: 0,
    callFrame: { functionName: "(root)", url: "", scriptId: "0", lineNumber: -1, columnNumber: -1 },
    children: [2],
  });
  nodeMap.set(2, {
    id: 2,
    hitCount: sampleTimesMs.length,
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
    timestampsMs: Float64Array.from(sampleTimesMs),
    sampleNodeIds: sampleTimesMs.map(() => 2),
    nodeMap,
    durationMs: sampleTimesMs[sampleTimesMs.length - 1]! + 1,
  };
}

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
  // Five samples in each of two windows. Whatever the per-window figures come
  // to, the two windows are separate stretches of time, so the row must add
  // them rather than report one window's.
  const markdown = renderComponentCpu(
    flatIndex([0, 1, 2, 3, 4, 10, 11, 12, 13, 14]),
    twoCommits,
    "Login",
    10
  );

  it("never prints a self time longer than the inclusive time beside it", () => {
    const { self, total } = readRow(markdown, "parse");
    expect(self).toBeLessThanOrEqual(total);
  });

  it("adds the disjoint windows rather than keeping the larger one", () => {
    const oneWindow = renderComponentCpu(
      flatIndex([0, 1, 2, 3, 4]),
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
