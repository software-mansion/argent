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
  /** Fetch error or timeout message; cleared by a successful fetch. */
  lastError?: string;
  /**
   * How many fetches came back with a tree, as opposed to erroring or being cut
   * off by the deadline. Always `<= polls`.
   *
   * This is what says whether a timed-out wait observed anything: a caller that
   * reports its own negative verdict on fewer than two samples describes a
   * screen it never got to compare with itself. Two different things starve it,
   * and {@link lastAttemptSettled} tells them apart: a tree too slow to read
   * (the deadline cuts a fetch off), or a `pollIntervalMs` that leaves no room
   * for a second read inside `timeoutMs` (every fetch settled, the schedule ran
   * out). Only the first is fixed by raising `timeoutMs`.
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

  const outcome = (result: R | undefined, aborted: boolean): PollDescribeTreeResult<R> => ({
    result,
    aborted,
    polls,
    elapsedMs: Date.now() - start,
    lastData,
    lastError,
    samples,
    lastAttemptSettled,
  });

  for (;;) {
    if (signal?.aborted) return outcome(undefined, true);

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
    lastAttemptSettled = settled.type !== "timeout";
    if (settled.type === "timeout") {
      // A fetch that merely straddled the deadline leaves lastData in place for
      // the caller's note; only report a hard failure when no tree ever arrived.
      // `lastAttemptSettled` is what tells that stale tree from a fresh one.
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
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    if (!(await sleepOrAbort(sleepMs, signal))) return outcome(undefined, true);
  }

  return outcome(undefined, false);
}
