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
 * So the driver samples the tree several times and always returns the fullest
 * snapshot seen — the sparser states are subsets of it, so this is
 * order-independent: the same oscillating screen mints one key no matter which
 * phase it happened to sample first. Two consecutive samples that agree on the
 * fingerprint (while about as full as the fullest seen) are only a cost signal:
 * the screen has settled, so stop describing early — but still hand back the
 * fullest snapshot, never the current sample.
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

// The early exit only fires when the agreeing, settled samples are at least
// this full relative to the fullest seen — so a still-filling tree keeps
// sampling until it is close to complete rather than exiting on early chrome.
// (Correctness no longer rides on this ratio: the exit returns the fullest
// snapshot regardless; the ratio only tunes how eagerly we stop describing.)
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
    // Settled (two agreeing keys, and this stable state is close to the fullest
    // we've seen) — stop early to save describes, but return `best`, not the
    // current sample: a sparse phase of an oscillation must never win over a
    // fuller phase already captured, or the same screen keys differently
    // depending on sampling order.
    if (prevKey !== null && key === prevKey && count >= FULLNESS_RATIO * maxCount) {
      return best!.tree;
    }
    prevKey = key;
  }
  return best!.tree;
}
