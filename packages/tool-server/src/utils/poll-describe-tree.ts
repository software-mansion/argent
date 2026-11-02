import type { DescribeTreeData } from "../tools/describe/contract";
import { settleWithin, sleepOrAbort } from "./timing";

/**
 * Shared `describe`-tree polling loop for the wait tools (`await-ui-element`,
 * `await-screen-idle`). The predicate owns the tool-specific meaning of "done";
 * this loop owns timing, cancellation, and the fetch lifecycle.
 */

/** Verdict from evaluating one successfully-fetched tree. */
type PollVerdict<R> = { done: true; result: R } | { done: false };

interface PollDescribeTreeArgs<R> {
  /**
   * Called once per poll; must be read-only. `budgetMs` is what is left of the
   * wait: an overrunning read is abandoned, not cancelled, so a backend holding
   * a device-side resource must bound itself.
   */
  fetchTree: (budgetMs: number) => Promise<DescribeTreeData>;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  /**
   * `nowMs` is `Date.now()` at the sample, so predicates can track stability
   * windows without their own timer. Return `{ done: true, result }` to stop early.
   */
  onSample: (data: DescribeTreeData, nowMs: number) => PollVerdict<R>;
}

interface PollDescribeTreeResult<R> {
  /** Result from the first `onSample` that returned done. */
  result: R | undefined;
  aborted: boolean;
  /** Number of tree fetches attempted. */
  polls: number;
  elapsedMs: number;
  /** Most recent successfully-fetched tree; null if none ever arrived. */
  lastData: DescribeTreeData | null;
  /** Fetch error or timeout message; cleared by a successful fetch. */
  lastError?: string;
  /**
   * How the final fetch ended: `tree`, `error`, or `unsettled` (abandoned at
   * the deadline). An unset `lastError` does not mean it succeeded.
   */
  lastAttempt: "tree" | "error" | "unsettled";
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
  let lastAttempt: PollDescribeTreeResult<R>["lastAttempt"] = "unsettled";

  const outcome = (result: R | undefined, aborted: boolean): PollDescribeTreeResult<R> => ({
    result,
    aborted,
    polls,
    elapsedMs: Date.now() - start,
    lastData,
    lastError,
    lastAttempt,
  });

  for (;;) {
    if (signal?.aborted) return outcome(undefined, true);

    const remaining = Math.max(0, deadline - Date.now());
    const settled = await settleWithin(fetchTree(remaining), remaining, signal);
    polls += 1;

    if (settled.type === "aborted") return outcome(undefined, true);
    lastAttempt =
      settled.type === "timeout" ? "unsettled" : settled.type === "error" ? "error" : "tree";
    if (settled.type === "timeout") {
      // A fetch that merely straddled the deadline leaves lastData in place for
      // the caller's note; only report a hard failure when no tree ever arrived.
      // `lastAttempt` is what tells that stale tree from a fresh one.
      if (lastData === null) {
        lastError ??= `tree fetch did not complete within the ${timeoutMs}ms wait budget`;
      }
      break;
    }
    if (settled.type === "error") {
      lastError = settled.error;
    } else {
      lastData = settled.value;
      lastError = undefined;
      const verdict = onSample(settled.value, Date.now());
      if (verdict.done) return outcome(verdict.result, false);
    }

    if (Date.now() >= deadline) break;
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, signal))) return outcome(undefined, true);
  }

  return outcome(undefined, false);
}
