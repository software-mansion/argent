import type { DescribeTreeData } from "../tools/describe/contract";
import { settleWithin, sleepOrAbort } from "./timing";

/**
 * Shared accessibility/DOM-tree polling loop used by the wait tools
 * (`await-ui-element`, `await-screen-idle`). It re-reads the `describe` tree on
 * an interval until a caller-supplied `onSample` predicate is satisfied or the
 * timeout elapses, keeping the robust bits in one place:
 *
 *  - each fetch is raced against the remaining budget + abort via `settleWithin`,
 *    so a slow/hung read can't overshoot `timeoutMs` and an abort is observed
 *    promptly instead of after the fetch resolves;
 *  - the poll sleep is clamped to the deadline so a large `pollIntervalMs` can't
 *    overshoot, and the wait ends there rather than asking for one more tree
 *    with no budget left to read it in.
 *
 * The predicate owns the tool-specific meaning of "done" (an element reached a
 * state, or the screen settled); this loop owns timing, cancellation, and the
 * fetch lifecycle.
 */

/** Verdict from evaluating one successfully-fetched tree. */
export type PollVerdict<R> = { done: true; result: R } | { done: false };

export interface PollDescribeTreeArgs<R> {
  /** Read the current tree. Called once per poll; must be read-only. */
  fetchTree: () => Promise<DescribeTreeData>;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  /**
   * Evaluate one successfully-fetched tree. `nowMs` is the poll clock
   * (`Date.now()` at the sample) so predicates can track stability windows
   * without their own timer. Return `{ done: true, result }` to stop early.
   */
  onSample: (data: DescribeTreeData, nowMs: number) => PollVerdict<R>;
}

export interface PollDescribeTreeResult<R> {
  /** Result from the first `onSample` that returned done; undefined on timeout. */
  result: R | undefined;
  /** True if the wait was cancelled via the abort signal. */
  aborted: boolean;
  /** Number of tree fetches attempted. */
  polls: number;
  /** Wall-clock time spent polling (ms). */
  elapsedMs: number;
  /** Most recent successfully-fetched tree, or null if none ever arrived. */
  lastData: DescribeTreeData | null;
  /** Most recent fetch error / timeout message, if the last fetch failed. */
  lastError?: string;
  /**
   * How many fetches came back with a tree, as opposed to erroring or being cut
   * off by the deadline. Always `<= polls`.
   *
   * This is what says whether a timed-out wait observed anything: a tree too
   * slow to read starves the predicate of the samples it needs to ever say yes,
   * and a caller that then reports its own negative verdict describes a screen
   * it never got to look at. Whether the LAST fetch straddled the deadline does
   * not say that — the loop keeps issuing fetches until the deadline, so the
   * final one is cut off on almost every timed-out wait however fast the reads
   * are, and a flag raised by that is raised on every timeout.
   */
  samples: number;
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

  const outcome = (result: R | undefined, aborted: boolean): PollDescribeTreeResult<R> => ({
    result,
    aborted,
    polls,
    elapsedMs: Date.now() - start,
    lastData,
    lastError,
    samples,
  });

  for (;;) {
    if (signal?.aborted) return outcome(undefined, true);

    // Bound each fetch to the time left before the deadline.
    const remaining = Math.max(0, deadline - Date.now());
    // The poll sleep below is clamped to land exactly on the deadline, so the
    // ordinary end of a wait arrives here with nothing left. A fetch handed no
    // budget cannot come back: it would burn a device round-trip to learn
    // nothing, count as a poll, and — because the only way it can end is
    // `timeout` — brand every wait that merely ran out of time as one whose
    // tree was too slow to read. The first fetch is exempt, because a budget
    // too small to read anything IS the tree outrunning it.
    if (polls > 0 && remaining === 0) break;
    const settled = await settleWithin(fetchTree(), remaining, signal);
    polls += 1;

    if (settled.type === "aborted") return outcome(undefined, true);
    if (settled.type === "timeout") {
      // Only synthesize a "did not complete" error when we never got a usable
      // tree; a final fetch that merely straddled the deadline leaves lastData
      // in place so the caller can build a content-based note from it.
      if (lastData === null) {
        lastError ??= `tree fetch did not complete within the ${timeoutMs}ms wait budget`;
      }
      break;
    }
    if (settled.type === "error") {
      lastError = settled.error;
    } else {
      samples += 1;
      lastData = settled.value;
      lastError = undefined;
      const verdict = onSample(settled.value, Date.now());
      if (verdict.done) return outcome(verdict.result, false);
    }

    if (Date.now() >= deadline) break;
    // Clamp the poll sleep so a large pollIntervalMs can't overshoot the
    // deadline; the guard at the top of the loop ends the wait there.
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, signal))) return outcome(undefined, true);
  }

  return outcome(undefined, false);
}
