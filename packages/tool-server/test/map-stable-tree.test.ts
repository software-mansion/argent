import { describe, it, expect } from "vitest";
import type { DescribeNode } from "../src/tools/describe/contract";
import { fetchStableTree } from "../src/tools/map/stable-tree";
import { screenKey } from "../src/tools/map/fingerprint";

// A flat tree with `count` uniform buttons — enough to give each state a
// distinct fingerprint and node count.
function treeWithButtons(count: number): DescribeNode {
  const children: DescribeNode[] = [];
  for (let i = 0; i < count; i++) {
    children.push({
      role: "AXButton",
      frame: { x: 0.1, y: 0.1 + i * 0.05, width: 0.8, height: 0.04 },
      children: [],
      label: `Row ${i}`,
    });
  }
  return { role: "AXGroup", frame: { x: 0, y: 0, width: 1, height: 1 }, children };
}

// Drives fetchStableTree with a scripted sequence of trees; the last entry
// repeats if the sampler asks for more. Records sleeps instead of waiting.
function scripted(states: DescribeNode[]) {
  let i = 0;
  const sleeps: number[] = [];
  return {
    fetches: () => i,
    sleeps,
    options: {
      fetch: () => Promise.resolve(states[Math.min(i++, states.length - 1)]!),
      keyOf: screenKey,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}

describe("fetchStableTree — sampled tree capture", () => {
  it("exits after two agreeing samples on a stable screen", async () => {
    const stable = treeWithButtons(10);
    const s = scripted([stable, stable]);
    const result = await fetchStableTree(s.options);
    expect(result).toBe(stable);
    expect(s.fetches()).toBe(2);
    expect(s.sleeps).toHaveLength(1);
  });

  it("returns the fullest snapshot when the tree decays mid-capture", async () => {
    // The live failure mode this exists for: an idle iOS screen whose AX tree
    // drops content nodes seconds after settling (observed 41 ⇒ 30 on the
    // Settings root). The sparse repeats must not win over the full look.
    const full = treeWithButtons(12);
    const sparse = treeWithButtons(4);
    const s = scripted([full, sparse, sparse, sparse, sparse]);
    const result = await fetchStableTree(s.options);
    expect(result).toBe(full);
    expect(s.fetches()).toBe(5);
  });

  it("converges on the full tree while the AX tree is still filling", async () => {
    const chrome = treeWithButtons(2);
    const full = treeWithButtons(12);
    const s = scripted([chrome, full, full]);
    const result = await fetchStableTree(s.options);
    expect(result).toBe(full);
    expect(s.fetches()).toBe(3);
  });

  it("never exceeds maxSamples and returns the fullest sample seen", async () => {
    const a = treeWithButtons(3);
    const b = treeWithButtons(9);
    const c = treeWithButtons(6);
    const s = scripted([a, b, c, a, b, c, a]);
    const result = await fetchStableTree({ ...s.options, maxSamples: 3 });
    expect(s.fetches()).toBe(3);
    expect(result).toBe(b);
  });

  it("a late equally-full sample wins over an earlier one (freshest full look)", async () => {
    const early = treeWithButtons(8);
    const late = treeWithButtons(8);
    // Distinct keys (different frames) so no early agreement fires.
    late.children[0]!.frame.y = 0.9;
    const mid = treeWithButtons(2);
    const s = scripted([early, mid, late, mid, mid]);
    const result = await fetchStableTree(s.options);
    expect(result).toBe(late);
  });
});

describe("fetchStableTree — order-independent capture of an oscillating screen", () => {
  // The same screen flickering between a full and a sparse phase must produce
  // ONE screenKey however the sampler phased into it — else back-navigation
  // verification and revisit dedup fail. Oscillate once then settle: (A,B,B,…).
  async function keyFromOrder(phaseA: DescribeNode, phaseB: DescribeNode): Promise<string> {
    const s = scripted([phaseA, phaseB, phaseB]);
    return screenKey(await fetchStableTree(s.options));
  }

  it("small sub-10% oscillation (40 ⇄ 38) keys the same from either phase first", async () => {
    const full = treeWithButtons(40);
    const sparse = treeWithButtons(38);
    const fullFirst = await keyFromOrder(full, sparse); // (40, 38, 38)
    const sparseFirst = await keyFromOrder(sparse, full); // (38, 40, 40)
    expect(fullFirst).toBe(sparseFirst);
    // ...and it is the fuller phase's key both times.
    expect(fullFirst).toBe(screenKey(full));
  });

  it("large 27% oscillation (41 ⇄ 30) keys the same from either phase first", async () => {
    const full = treeWithButtons(41);
    const sparse = treeWithButtons(30);
    const fullFirst = await keyFromOrder(full, sparse); // (41, 30, 30)
    const sparseFirst = await keyFromOrder(sparse, full); // (30, 41, 41)
    expect(fullFirst).toBe(sparseFirst);
    expect(fullFirst).toBe(screenKey(full));
  });
});
