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
 *    overshoot, while still allowing one final poll at the deadline.
 *
 * The predicate owns the tool-specific meaning of "done" (an element reached a
 * state, or the screen settled); this loop owns timing, cancellation, and the
 * fetch lifecycle.
 */

/** Verdict from evaluating one successfully-fetched tree. */
export type PollVerdict<R> = { done: true; result: R } | { done: false };

export interface PollDescribeTreeArgs<R> {
  /**
   * Read the current tree. Called once per poll; must be read-only.
   *
   * `budgetMs` is what is left before the wait's deadline. This loop abandons a
   * read that overruns it but cannot cancel one, so a backend whose read holds
   * a device-side resource has to bound itself with this to keep the abandoned
   * read from charging the caller's next call for it.
   */
  fetchTree: (budgetMs: number) => Promise<DescribeTreeData>;
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
}

/**
 * What the last read said about itself, as clauses for a wait's timeout note:
 * a tree the adapter flagged as degraded or partial, and an app whose native
 * inspection needs a restart before it can be seen at all. A wait that ends
 * without its condition met ends on one of these far more often than on a
 * screen that genuinely kept moving, and neither wait tool can tell them apart
 * from the tree alone.
 */
export function readCaveats(lastData: DescribeTreeData | null): string[] {
  if (!lastData) return [];
  const caveats: string[] = [];
  if (lastData.should_restart) {
    caveats.push(
      "the foreground app may need a restart for native inspection — call restart-app and retry"
    );
  }
  if (lastData.hint) caveats.push(lastData.hint);
  return caveats;
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

  const outcome = (result: R | undefined, aborted: boolean): PollDescribeTreeResult<R> => ({
    result,
    aborted,
    polls,
    elapsedMs: Date.now() - start,
    lastData,
    lastError,
  });

  for (;;) {
    if (signal?.aborted) return outcome(undefined, true);

    // Bound each fetch to the time left before the deadline.
    const remaining = Math.max(0, deadline - Date.now());
    // The final poll runs AT the deadline (see the sleep clamp below), so it is
    // handed nothing. A backend that refuses an empty budget outright then fails
    // for a reason of the loop's own making, which must not displace what the
    // polls that had time actually found — the same reason the timeout branch
    // below only speaks up when no tree was ever read.
    const unbudgeted = remaining === 0;
    const settled = await settleWithin(fetchTree(remaining), remaining, signal);
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
      if (!unbudgeted || (lastError === undefined && lastData === null)) lastError = settled.error;
    } else {
      lastData = settled.value;
      lastError = undefined;
      const verdict = onSample(settled.value, Date.now());
      if (verdict.done) return outcome(verdict.result, false);
    }

    if (Date.now() >= deadline) break;
    // Clamp the poll sleep so a large pollIntervalMs can't overshoot the
    // deadline; the next iteration still does one final poll at the deadline.
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, signal))) return outcome(undefined, true);
  }

  return outcome(undefined, false);
}
