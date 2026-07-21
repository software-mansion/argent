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
 * that agree on the fingerprint are a cost signal that the screen has settled, so
 * it can stop describing early — but ONLY once it has watched the tree climb to a
 * peak and hold there: it has seen a strictly sparser sample, so the peak is one
 * it grew INTO rather than just the first phase it landed in. That is what stops
 * a sparse phase sampled first from locking the capture in before the fuller
 * phase appears — a run of leading sparse reads is the fullest seen SO FAR, so
 * "fullest look" alone is not enough; it keeps sampling until it has actually
 * witnessed the tree be both sparser and fuller. It still hands back the fullest
 * snapshot, never the current sample. A transient describe failure on one sample
 * is ridden out (the good samples are kept); only an all-failed capture surfaces
 * the error.
 *
 * Known limitation: "fullest wins" assumes sparser samples are subsets of the
 * fullest (AX dropping and refilling content). A transient that ADDS nodes — a
 * snackbar/toast/tooltip/banner shown during the sampling window — violates that:
 * the inflated sample wins and its overlay enters the screenKey, so the same
 * screen can key differently across visits (a duplicate graph node, plus
 * recovery restart-replays). There is no structural way to tell such an additive
 * transient apart from a modal sheet that genuinely SHOULD be mapped, nor from
 * ordinary AX content-drop, so returning the fullest sample is an accepted
 * trade-off favouring the far more common AX-decay case.
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
  let minCount = Infinity;
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
    minCount = Math.min(minCount, count);
    // ">=" so an equally-full later sample wins: it is the more recent look.
    if (!best || count >= best.count) best = { tree, count };

    const key = options.keyOf(tree);
    // Settled — stop early to save describes, but ONLY once we have watched the
    // tree climb to a peak and hold there:
    //   • two consecutive samples agree (`key === prevKey`) — the settle signal;
    //   • the current sample is the fullest seen (`count === maxCount`);
    //   • AND we have actually observed a strictly sparser sample
    //     (`minCount < maxCount`), so `maxCount` is a peak we grew INTO, not just
    //     the first phase we happened to land in.
    // The last clause is the crux: without it the guard is vacuous when a sparse
    // phase LEADS — `maxCount` is only the fullest seen SO FAR, so a run of sparse
    // reads trivially satisfies `count === maxCount` and locks the capture to the
    // sparse look before the fuller phase is ever sampled (keying the screen
    // differently depending on which phase the visit began in). Requiring an
    // observed sparser sample means a leading sparse phase never early-exits; it
    // keeps sampling until the fuller phase appears (or the budget runs out).
    // Always hands back `best` (the fullest snapshot), never the current sample.
    if (
      i + 1 >= MIN_SETTLE_SAMPLES &&
      prevKey !== null &&
      key === prevKey &&
      count === maxCount &&
      minCount < maxCount
    ) {
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
