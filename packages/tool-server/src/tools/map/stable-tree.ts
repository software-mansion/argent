import type { DescribeNode } from "../describe/contract";

/**
 * Repeated-sample tree capture for the `map-app` crawler.
 *
 * A single describe of a settled iOS screen cannot be trusted for screen
 * identity: the AX service populates incrementally after navigation and can
 * later *drop* content nodes again on an untouched screen (observed live: the
 * Settings root oscillating 41 ⇄ 30 nodes seconds apart). Fingerprinting one
 * arbitrary sample of that oscillation mints phantom "new" screens on every
 * revisit and makes back-navigation verification fail.
 *
 * So the driver samples the tree several times and returns the richest
 * consistent snapshot: it exits early once two consecutive samples agree on
 * the fingerprint while being about as full as the fullest sample seen (the
 * common stable case costs one extra describe), and otherwise — an
 * oscillating or still-filling tree — it keeps sampling and returns the
 * fullest snapshot, which the sparser states are subsets of.
 */

export interface StableTreeOptions {
  fetch: () => Promise<DescribeNode>;
  /** Screen fingerprint used to compare samples (the crawler's `screenKey`). */
  keyOf: (tree: DescribeNode) => string;
  sleep: (ms: number) => Promise<void>;
  /** Upper bound on describes per capture. */
  maxSamples?: number;
  /** Pause between samples. */
  gapMs?: number;
}

const DEFAULT_MAX_SAMPLES = 5;
const DEFAULT_GAP_MS = 350;

// A sample only counts as "as full as the fullest seen" within this ratio —
// two consecutive sparse samples of an oscillating tree must not short-circuit
// past the full state we already observed.
const FULLNESS_RATIO = 0.9;

function countNodes(node: DescribeNode): number {
  let count = 1;
  for (const child of node.children) count += countNodes(child);
  return count;
}

export async function fetchStableTree(options: StableTreeOptions): Promise<DescribeNode> {
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS;

  let best: { tree: DescribeNode; count: number } | null = null;
  let maxCount = 0;
  let prevKey: string | null = null;

  for (let i = 0; i < maxSamples; i++) {
    if (i > 0) await options.sleep(gapMs);
    const tree = await options.fetch();
    const count = countNodes(tree);
    maxCount = Math.max(maxCount, count);
    // ">=" so an equally-full later sample wins: it is the more recent look.
    if (!best || count >= best.count) best = { tree, count };

    const key = options.keyOf(tree);
    if (prevKey !== null && key === prevKey && count >= FULLNESS_RATIO * maxCount) {
      return tree;
    }
    prevKey = key;
  }
  return best!.tree;
}
