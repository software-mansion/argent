import type { DescribeTreeData } from "../tools/describe/contract";
import { settleWithin, sleepOrAbort } from "./timing";

/**
 * Shared `describe`-tree polling loop for the wait tools (`await-ui-element`,
 * `await-screen-idle`). The predicate owns the tool-specific meaning of "done";
 * this loop owns timing, cancellation, and the fetch lifecycle.
 */

/**
 * Prefix both wait tools put on a note that carries a fetch error, so a caller
 * reading either one recognises the same shape. `unmetUiWaitCause` classifies
 * off it.
 */
export const TREE_FETCH_FAILED_NOTE_PREFIX = "last tree fetch failed: ";

/**
 * Smallest `pollIntervalMs` either wait tool's schema accepts. A caller told to
 * lower theirs has to be able to; below this the sleep is not the knob.
 */
export const MIN_POLL_INTERVAL_MS = 50;

/** Verdict from evaluating one successfully-fetched tree. */
type PollVerdict<R> = { done: true; result: R } | { done: false };

interface PollDescribeTreeArgs<R> {
  /** Called once per poll; must be read-only. */
  fetchTree: () => Promise<DescribeTreeData>;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  /**
   * `nowMs` is `Date.now()` at the sample, so predicates can track stability
   * windows without their own timer. Return `{ done: true, result }` to stop early.
   */
  onSample: (data: DescribeTreeData, nowMs: number) => PollVerdict<R>;
}

export interface PollDescribeTreeResult<R> {
  /** Result from the first `onSample` that returned done. */
  result: R | undefined;
  aborted: boolean;
  /** Number of tree fetches attempted. */
  polls: number;
  elapsedMs: number;
  /** Most recent successfully-fetched tree; null if none ever arrived. */
  lastData: DescribeTreeData | null;
  /**
   * Message from a fetch that FAILED. Cleared by a successful fetch, and never
   * written for a fetch the deadline merely abandoned — that one is
   * {@link lastAttemptSettled}, and conflating the two tells a caller its source
   * is broken when it was only slow.
   *
   * Set does not mean the LAST fetch failed, though: a deadline that abandons a
   * fetch leaves the previous poll's failure standing here.
   */
  lastError?: string;
  /**
   * How many fetches came back with a tree, as opposed to erroring or being cut
   * off by the deadline. Always `<= polls`.
   *
   * This is what says whether a timed-out wait observed anything: a caller that
   * reports its own negative verdict on fewer than two samples describes a
   * screen it never got to compare with itself. Three things starve it, taking
   * two different remedies, and {@link lastAttemptSettled} with
   * {@link slowestFetchMs} tell them apart: the deadline cut a fetch off; every
   * fetch settled but one read was over half the budget, so a second could not
   * have fitted at any interval; or every fetch settled and `pollIntervalMs`
   * left no room. Only the last is fixed by polling more often.
   */
  samples: number;
  /**
   * Did the FINAL fetch attempt settle — return a tree or an error — before the
   * loop stopped waiting for it?
   *
   * `lastError` cannot answer this. It is cleared on every successful fetch, so
   * a set value means the last fetch failed; but an unset one does NOT mean it
   * succeeded, because the deadline arm below leaves it unset for an abandoned
   * fetch, so that the caller can still build a note from an older tree.
   */
  lastAttemptSettled: boolean;
  /**
   * The longest single fetch attempt, from issue to settle — or, for one the
   * deadline cut off, to the cut-off.
   *
   * What it answers is whether a second sample was ever affordable: a read this
   * size needs its own length again before the deadline, so past half the budget
   * no `pollIntervalMs` buys a second one and only a larger `timeoutMs` will.
   */
  slowestFetchMs: number;
  /**
   * How many fetches ERRORED, across the whole wait. Unlike {@link lastError},
   * which a later success clears, this is monotonic: it survives a success, so a
   * window that failed repeatedly and then read one good tree can still say the
   * window was mostly blind. A caller with a single sample and this above zero
   * must not blame the schedule for a shortage the failures caused.
   */
  failedFetches: number;
}

export async function pollDescribeTree<R>(
  args: PollDescribeTreeArgs<R>
): Promise<PollDescribeTreeResult<R>> {
  const { fetchTree, timeoutMs, pollIntervalMs, signal, onSample } = args;
  const start = Date.now();
  const deadline = start + timeoutMs;

  let polls = 0;
  let lastData: DescribeTreeData | null = null;
  let lastError: string | undefined;
  let samples = 0;
  let lastAttemptSettled = false;
  let slowestFetchMs = 0;
  let failedFetches = 0;

  const outcome = (result: R | undefined, aborted: boolean): PollDescribeTreeResult<R> => ({
    result,
    aborted,
    polls,
    elapsedMs: Date.now() - start,
    lastData,
    lastError,
    samples,
    lastAttemptSettled,
    slowestFetchMs,
    failedFetches,
  });

  for (;;) {
    if (signal?.aborted) return outcome(undefined, true);

    const remaining = Math.max(0, deadline - Date.now());
    // A fetch handed no budget cannot come back: it would burn a device
    // round-trip to learn nothing, count as a poll, and — because the only way it
    // can end is `timeout` — brand every wait that merely ran out of time as one
    // whose tree was too slow to read. The clamped sleep below ends the wait at
    // its own break; this guards the leftover case, where an interval a hair
    // under the remaining budget lands the next loop here with nothing left. The
    // first fetch is exempt, because a budget too small to read anything IS the
    // tree outrunning it.
    if (polls > 0 && remaining === 0) break;
    const issuedAt = Date.now();
    const settled = await settleWithin(fetchTree(), remaining, signal);
    polls += 1;
    slowestFetchMs = Math.max(slowestFetchMs, Date.now() - issuedAt);

    if (settled.type === "aborted") return outcome(undefined, true);
    lastAttemptSettled = settled.type !== "timeout";
    if (settled.type === "timeout") {
      // Nothing is written to `lastError`: the deadline abandoning a fetch is not
      // that fetch failing, and a caller told otherwise goes looking for a broken
      // source. `lastAttemptSettled` carries it instead, and any error already
      // here belongs to a genuine failure earlier in the wait. `lastData` is left
      // in place too, so the caller can still build a note from the older tree.
      break;
    }
    if (settled.type === "error") {
      lastError = settled.error;
      failedFetches += 1;
    } else {
      samples += 1;
      lastData = settled.value;
      lastError = undefined;
      const verdict = onSample(settled.value, Date.now());
      if (verdict.done) return outcome(verdict.result, false);
    }

    const remainingForSleep = Math.max(0, deadline - Date.now());
    if (remainingForSleep === 0) break;
    const sleepMs = Math.min(pollIntervalMs, remainingForSleep);
    if (!(await sleepOrAbort(sleepMs, signal))) return outcome(undefined, true);
    // A sleep clamped to the whole remaining budget was the wait's last one: end
    // here rather than let a timer that fires a hair early (setTimeout can, by
    // ~1ms) reopen the loop for a fetch that can only be handed the sliver it
    // leaves — a doomed read that flips `lastAttemptSettled` and the note built
    // from it. Only a wider interval leaves a real budget for another read.
    if (sleepMs === remainingForSleep) break;
  }

  return outcome(undefined, false);
}
