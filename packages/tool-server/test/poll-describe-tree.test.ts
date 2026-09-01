import { describe, expect, it } from "vitest";
import type { DescribeTreeData } from "../src/tools/describe/contract";
import { pollDescribeTree } from "../src/utils/poll-describe-tree";

const tree = (label: string): DescribeTreeData => ({
  tree: {
    role: "window",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    children: [
      { role: "button", label, frame: { x: 0, y: 0, width: 1, height: 0.1 }, children: [] },
    ],
  },
  source: "ax-service",
});

const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise((r) => setTimeout(() => r(value), ms));

const never = <T>(): Promise<T> => new Promise(() => {});

/** Poll loop with a predicate that never says done, so every run times out. */
function neverDone(
  fetchTree: () => Promise<DescribeTreeData>,
  timeoutMs: number,
  pollIntervalMs: number,
  signal?: AbortSignal
) {
  return pollDescribeTree<true>({
    fetchTree,
    timeoutMs,
    pollIntervalMs,
    signal,
    onSample: () => ({ done: false }),
  });
}

describe("pollDescribeTree", () => {
  it("counts only the fetches that came back with a tree as samples", async () => {
    let n = 0;
    const poll = await neverDone(
      async () => {
        n += 1;
        if (n % 2 === 0) throw new Error(`boom ${n}`);
        return after(5, tree("a"));
      },
      160,
      10
    );

    // Exact counts would ride on how many cycles the runner fits in the budget;
    // what the field promises is the relation.
    expect(poll.polls).toBeGreaterThan(3);
    expect(poll.samples).toBeGreaterThan(0);
    expect(poll.samples).toBeLessThan(poll.polls);
  });

  it("clears lastError on a successful fetch and keeps the tree that arrived", async () => {
    let n = 0;
    const poll = await neverDone(
      async () => {
        n += 1;
        if (n === 1) throw new Error("first read failed");
        return after(5, tree(`read-${n}`));
      },
      120,
      10
    );

    expect(poll.lastError).toBeUndefined();
    expect(poll.lastData?.tree.children[0]?.label).toMatch(/^read-/);
  });

  // The break that keeps the loop from issuing a fetch with nothing left to read
  // it in. `pollIntervalMs` dwarfs `timeoutMs`, so the clamped sleep lands exactly
  // on the deadline: a second fetch there could only ever end in `timeout`, and
  // would brand a wait that merely ran out of time as one whose tree was too slow
  // to read. Deleting the break makes `polls` 2 and `lastAttemptSettled` false.
  it("issues no fetch once the clamped sleep has consumed the whole budget", async () => {
    let issued = 0;
    const poll = await neverDone(
      async () => {
        issued += 1;
        return after(5, tree("a"));
      },
      1000,
      5000
    );

    expect(issued).toBe(1);
    expect(poll.polls).toBe(1);
    expect(poll.samples).toBe(1);
    expect(poll.lastAttemptSettled).toBe(true);
    expect(poll.lastError).toBeUndefined();
    expect(poll.elapsedMs).toBeGreaterThanOrEqual(1000);
  });

  // The exemption in that same break: the FIRST fetch is issued whatever the
  // budget, because a budget too small to read anything in IS the tree outrunning
  // it, and that has to be observable rather than silently skipped.
  it("still issues the first fetch and reports it cut off when the tree never answers", async () => {
    const poll = await neverDone(never, 60, 5000);

    expect(poll.polls).toBe(1);
    expect(poll.samples).toBe(0);
    expect(poll.lastAttemptSettled).toBe(false);
    expect(poll.lastData).toBeNull();
    expect(poll.lastError).toBe("tree fetch did not complete within the 60ms wait budget");
  });

  // A fetch abandoned at the deadline leaves the PREVIOUS tree in place, so the
  // caller can still build a note from it — but `lastAttemptSettled` false is what
  // says that tree is not the last word.
  it("keeps the older tree when the deadline abandons a later fetch", async () => {
    let n = 0;
    const poll = await neverDone(
      () => {
        n += 1;
        return n === 1 ? after(5, tree("first")) : never<DescribeTreeData>();
      },
      300,
      10
    );

    expect(poll.samples).toBe(1);
    expect(poll.polls).toBeGreaterThan(1);
    expect(poll.lastAttemptSettled).toBe(false);
    expect(poll.lastData?.tree.children[0]?.label).toBe("first");
    // Only reported when NO tree ever arrived; one did.
    expect(poll.lastError).toBeUndefined();
  });

  it("reports the last fetch's error with lastAttemptSettled set", async () => {
    const poll = await neverDone(
      async () => {
        throw new Error("device locked");
      },
      80,
      10
    );

    expect(poll.samples).toBe(0);
    expect(poll.lastAttemptSettled).toBe(true);
    expect(poll.lastError).toBe("device locked");
  });

  it("returns aborted without issuing a fetch when the signal is already aborted", async () => {
    let issued = 0;
    const ac = new AbortController();
    ac.abort();
    const poll = await neverDone(
      async () => {
        issued += 1;
        return tree("a");
      },
      5000,
      10,
      ac.signal
    );

    expect(issued).toBe(0);
    expect(poll.aborted).toBe(true);
    expect(poll.polls).toBe(0);
  });

  it("returns aborted when the signal fires mid-wait", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 40);
    const poll = await neverDone(() => after(5, tree("a")), 5000, 20, ac.signal);

    expect(poll.aborted).toBe(true);
    expect(poll.elapsedMs).toBeLessThan(1000);
  });

  // What separates "the sleep starved the second read" from "the read was too big
  // for a second one at any sleep". Measured over every attempt, so a fetch the
  // deadline cut off counts for the time it did consume.
  it("reports the longest single fetch, cut-off attempts included", async () => {
    let n = 0;
    const poll = await neverDone(
      () => {
        n += 1;
        if (n === 1) return after(20, tree("quick"));
        if (n === 2) return after(90, tree("slow"));
        return never<DescribeTreeData>();
      },
      400,
      10
    );

    expect(poll.samples).toBe(2);
    expect(poll.slowestFetchMs).toBeGreaterThanOrEqual(90);
    // The trailing fetch is abandoned at the deadline, so it can only have run
    // for what was left — never longer than the budget itself.
    expect(poll.slowestFetchMs).toBeLessThanOrEqual(400);
  });

  it("reports zero slowestFetchMs when no fetch was ever issued", async () => {
    const ac = new AbortController();
    ac.abort();
    const poll = await neverDone(() => after(5, tree("a")), 5000, 10, ac.signal);

    expect(poll.polls).toBe(0);
    expect(poll.slowestFetchMs).toBe(0);
  });

  it("stops early and carries the predicate's result", async () => {
    const poll = await pollDescribeTree<string>({
      fetchTree: () => after(5, tree("a")),
      timeoutMs: 5000,
      pollIntervalMs: 10,
      onSample: () => ({ done: true, result: "hit" }),
    });

    expect(poll.result).toBe("hit");
    expect(poll.polls).toBe(1);
    expect(poll.samples).toBe(1);
    expect(poll.aborted).toBe(false);
  });
});
