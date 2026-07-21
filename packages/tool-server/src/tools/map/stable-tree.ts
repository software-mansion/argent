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
 * snapshot seen — the sparser states are subsets of it. Two consecutive samples
 * that agree on the fingerprint are only a cost signal that the screen has
 * settled, so it can stop describing early — but only once it has settled on its
 * FULLEST look (and past a small floor of samples), so a sparse phase sampled
 * first can't lock the capture in before the fuller phase appears. It still
 * hands back the fullest snapshot, never the current sample. A transient
 * describe failure on one sample is ridden out (the good samples are kept); only
 * an all-failed capture surfaces the error.
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

// Never stop early before this many samples. A screen that oscillates (the
// Settings root flips 41 ⇄ 30 nodes seconds apart) can present its sparse phase
// for the first couple of reads; exiting on that first agreeing pair would lock
// the capture to the sparse look and key the screen differently than a visit
// that happened to begin in the full phase. Taking a few reads first gives the
// fuller phase a chance to appear before we commit.
const MIN_SETTLE_SAMPLES = 3;

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
  let lastError: unknown = null;

  for (let i = 0; i < maxSamples; i++) {
    if (i > 0) await options.sleep(gapMs);
    let tree: DescribeNode;
    try {
      tree = await options.fetch();
    } catch (err) {
      // A transient describe failure on one sample (a flaky AX read, an adb
      // timeout — exactly the post-navigation instability this sampler exists to
      // ride out) must not discard a good tree already captured this pass. Keep
      // the best so far and try the next sample; the error only surfaces if
      // EVERY sample fails.
      lastError = err;
      continue;
    }
    const count = countNodes(tree);
    maxCount = Math.max(maxCount, count);
    // ">=" so an equally-full later sample wins: it is the more recent look.
    if (!best || count >= best.count) best = { tree, count };

    const key = options.keyOf(tree);
    // Settled — stop early to save describes, but only once we have settled on
    // the FULLEST look seen this pass (`count === maxCount`) and past the floor:
    // a sparse phase of an oscillation must never win over a fuller phase, or the
    // same screen keys differently depending on sampling order. Hand back `best`
    // (the fullest snapshot), never the current sample.
    if (i + 1 >= MIN_SETTLE_SAMPLES && prevKey !== null && key === prevKey && count === maxCount) {
      return best!.tree;
    }
    prevKey = key;
  }
  if (!best) {
    // Every sample threw — surface the real device error instead of a
    // null-deref, so the caller sees why the screen was unreadable.
    if (lastError instanceof Error) throw lastError;
    throw new Error("fetchStableTree: no readable tree sampled");
  }
  return best.tree;
}
