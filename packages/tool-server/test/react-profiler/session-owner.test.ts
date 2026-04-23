import { describe, it, expect } from "vitest";
import {
  classifyStaleness,
  DEFAULT_STALE_THRESHOLD_MS,
  type ProfilerSessionOwner,
  type ProfilingDataBackend,
} from "../../src/utils/react-profiler/session-ownership";
import { flattenProfilingData } from "../../src/tools/profiler/react/react-profiler-stop";
import { buildHotCommitSummaries } from "../../src/utils/react-profiler/pipeline/00-hot-commits";
import type { DevToolsFiberCommit } from "../../src/utils/react-profiler/types/input";

function owner(overrides: Partial<ProfilerSessionOwner> = {}): ProfilerSessionOwner {
  return {
    sessionId: "sess-1",
    startedAtEpochMs: 1_000_000_000,
    lastHeartbeatEpochMs: 1_000_000_000,
    ...overrides,
  };
}

// ── classifyStaleness ─────────────────────────────────────────────────

describe("classifyStaleness", () => {
  it("marks session reclaimable when owner is null", () => {
    const r = classifyStaleness({ owner: null, nowEpochMs: 1_000_000_100 });
    expect(r.stale).toBe(false);
    expect(r.canReclaimWithoutForce).toBe(true);
    expect(r.ageSeconds).toBeNull();
  });

  it("keeps a fresh session non-stale and non-reclaimable", () => {
    const r = classifyStaleness({
      owner: owner({ lastHeartbeatEpochMs: 1_000_000_000 }),
      nowEpochMs: 1_000_001_000, // 1s later
    });
    expect(r.stale).toBe(false);
    expect(r.canReclaimWithoutForce).toBe(false);
    expect(r.ageSeconds).toBeCloseTo(1, 3);
  });

  it("marks a session stale once lastHeartbeat is older than threshold", () => {
    const nowMs = 1_000_000_000 + DEFAULT_STALE_THRESHOLD_MS + 1;
    const r = classifyStaleness({
      owner: owner({ lastHeartbeatEpochMs: 1_000_000_000 }),
      nowEpochMs: nowMs,
    });
    expect(r.stale).toBe(true);
    expect(r.canReclaimWithoutForce).toBe(true);
  });

  it("honours a custom stale threshold", () => {
    const r = classifyStaleness({
      owner: owner({ lastHeartbeatEpochMs: 1_000_000_000 }),
      nowEpochMs: 1_000_000_500, // 500ms later
      staleThresholdMs: 100,
    });
    expect(r.stale).toBe(true);
    expect(r.canReclaimWithoutForce).toBe(true);
  });

  it("clamps negative durations to zero (clock-skew safety)", () => {
    const r = classifyStaleness({
      owner: owner({ startedAtEpochMs: 2_000_000_000, lastHeartbeatEpochMs: 2_000_000_000 }),
      nowEpochMs: 1_000_000_000,
    });
    expect(r.ageSeconds).toBe(0);
  });
});

// ── flattenProfilingData ──────────────────────────────────────────────

describe("flattenProfilingData", () => {
  function pd(): ProfilingDataBackend {
    return {
      dataForRoots: [
        {
          rootID: 1,
          commitData: [
            {
              timestamp: 10,
              duration: 20,
              fiberActualDurations: [
                [101, 5],
                [102, 3],
              ],
              fiberSelfDurations: [
                [101, 4],
                [102, 2],
              ],
              changeDescriptions: [
                [
                  101,
                  {
                    props: ["onPress"],
                    state: null,
                    hooks: null,
                    context: null,
                    didHooksChange: false,
                    isFirstMount: false,
                  },
                ],
              ],
            },
            {
              timestamp: 30,
              duration: 5,
              fiberActualDurations: [[101, 2]],
              fiberSelfDurations: [[101, 2]],
              changeDescriptions: [],
            },
          ],
        },
        {
          rootID: 2,
          commitData: [
            {
              timestamp: 50,
              duration: 10,
              fiberActualDurations: [[201, 8]],
              fiberSelfDurations: [[201, 7]],
              changeDescriptions: [],
            },
          ],
        },
      ],
    };
  }

  const displayNameById = {
    "101": "Button",
    "102": "Text",
    "201": "Modal",
  };
  const fiberMeta = {
    Button: { hookTypes: ["useState"], isCompilerOptimized: false, parentName: "App" },
    Text: { hookTypes: null, isCompilerOptimized: false, parentName: "Button" },
    Modal: { hookTypes: null, isCompilerOptimized: true, parentName: "App" },
  };

  it("assigns a flat commitIndex across roots", () => {
    const { commits, totalCommits } = flattenProfilingData(pd(), displayNameById, fiberMeta);
    expect(totalCommits).toBe(3);
    const indices = [...new Set(commits.map((c) => c.commitIndex))].sort();
    expect(indices).toEqual([0, 1, 2]);
  });

  it("produces one entry per rendered fiber per commit", () => {
    const { commits } = flattenProfilingData(pd(), displayNameById, fiberMeta);
    expect(commits).toHaveLength(4); // 2 + 1 + 1
  });

  it("drops fibers that have no resolved display name", () => {
    const partialNames = { "101": "Button" }; // 102 and 201 are unnamed/host
    const { commits } = flattenProfilingData(pd(), partialNames, fiberMeta);
    expect(commits.every((c) => c.componentName === "Button")).toBe(true);
    expect(commits).toHaveLength(2);
  });

  it("hydrates hookTypes / parentName / isCompilerOptimized from fiberMeta", () => {
    const { commits } = flattenProfilingData(pd(), displayNameById, fiberMeta);
    const modal = commits.find((c) => c.componentName === "Modal");
    expect(modal?.isCompilerOptimized).toBe(true);
    expect(modal?.parentName).toBe("App");
    const button = commits.find((c) => c.componentName === "Button");
    expect(button?.hookTypes).toEqual(["useState"]);
  });

  it("preserves the change description for the matching fiberID", () => {
    const { commits } = flattenProfilingData(pd(), displayNameById, fiberMeta);
    const button = commits.find(
      (c) => c.componentName === "Button" && c.commitIndex === 0
    );
    expect(button?.changeDescription?.props).toEqual(["onPress"]);
    expect(button?.changeDescription?.isFirstMount).toBe(false);
  });

  it("defaults missing meta to nulls and false", () => {
    const { commits } = flattenProfilingData(pd(), displayNameById, {});
    for (const c of commits) {
      expect(c.hookTypes).toBeNull();
      expect(c.parentName).toBeNull();
      expect(c.isCompilerOptimized).toBe(false);
    }
  });

  it("returns no unattributed entries when all fibers resolve", () => {
    const { unattributedByCommit } = flattenProfilingData(pd(), displayNameById, fiberMeta);
    expect(unattributedByCommit).toEqual([]);
  });

  it("records per-commit dropped fiber count and summed ms when names are unresolved", () => {
    // Only 101 is named; 102 (commit 0) and 201 (commit 2) are transient/unmounted.
    const partialNames = { "101": "Button" };
    const { commits, unattributedByCommit } = flattenProfilingData(pd(), partialNames, fiberMeta);

    // Named fibers survive.
    expect(commits.every((c) => c.componentName === "Button")).toBe(true);

    // unattributed ms uses selfDuration (exclusive per-fiber time), not actualDuration.
    // Commit 0: 102 selfDuration=2; Commit 2: 201 selfDuration=7.
    expect(unattributedByCommit).toEqual([
      [0, 1, 2],
      [2, 1, 7],
    ]);
  });

  it("sums multiple dropped fibers within the same commit using selfDuration", () => {
    // Make every fiber drop by passing an empty name map.
    const { unattributedByCommit } = flattenProfilingData(pd(), {}, fiberMeta);

    // Commit 0: 101 self=4 + 102 self=2 = 6 across 2 fibers.
    expect(unattributedByCommit[0]).toEqual([0, 2, 6]);
    // Commit 1: 101 self=2.
    expect(unattributedByCommit[1]).toEqual([1, 1, 2]);
    // Commit 2: 201 self=7.
    expect(unattributedByCommit[2]).toEqual([2, 1, 7]);
  });

  it("uses selfDuration rather than actualDuration for a nested dropped subtree", () => {
    // Parent actualDuration includes its child's actualDuration (inclusive).
    // Using actualDuration for both would double-count the child's work.
    const nested: ProfilingDataBackend = {
      dataForRoots: [
        {
          rootID: 1,
          commitData: [
            {
              timestamp: 0,
              duration: 30,
              fiberActualDurations: [
                [1, 30], // parent — inclusive 30ms
                [2, 25], // child  — inclusive 25ms
              ],
              fiberSelfDurations: [
                [1, 5], // parent exclusive 5ms
                [2, 25], // child exclusive 25ms
              ],
              changeDescriptions: [],
            },
          ],
        },
      ],
    };
    const { commits, unattributedByCommit } = flattenProfilingData(nested, {}, {});
    expect(commits).toHaveLength(0);
    // Correct answer: 5 + 25 = 30 (the commit's total work).
    // Bug would give: 30 + 25 = 55.
    expect(unattributedByCommit).toEqual([[0, 2, 30]]);
  });

  it("rounds unattributed ms to 2 decimals", () => {
    const data: ProfilingDataBackend = {
      dataForRoots: [
        {
          rootID: 1,
          commitData: [
            {
              timestamp: 0,
              duration: 10,
              fiberActualDurations: [
                [1, 1.23456],
                [2, 2.34567],
              ],
              fiberSelfDurations: [
                [1, 1.23456],
                [2, 2.34567],
              ],
              changeDescriptions: [],
            },
          ],
        },
      ],
      rendererID: 1,
    };
    const { unattributedByCommit } = flattenProfilingData(data, {}, {});
    // 1.23456 + 2.34567 = 3.58023 → rounds to 3.58
    expect(unattributedByCommit).toEqual([[0, 2, 3.58]]);
  });

  it("recovers commits for fibers resolved via the commit-time name cache", () => {
    // Simulate the output of STOP_AND_READ_SCRIPT after the cache fallback:
    // all fiber IDs (including ones that would be dropped at stop time) now
    // resolve to names, so nothing is unattributed and every fiber's
    // selfDuration is preserved in the commits array.
    const recoveredNames = {
      "101": "Button",
      "102": "Tooltip", // "recovered" transient — resolved via cache
      "201": "Modal", // "recovered" transient — resolved via cache
    };
    const { commits, unattributedByCommit } = flattenProfilingData(
      pd(),
      recoveredNames,
      fiberMeta
    );

    expect(unattributedByCommit).toEqual([]);
    const tooltip = commits.find((c) => c.componentName === "Tooltip");
    expect(tooltip).toBeDefined();
    expect(tooltip?.selfDuration).toBe(2);
    expect(tooltip?.actualDuration).toBe(3);
    const modal = commits.find((c) => c.componentName === "Modal");
    expect(modal?.selfDuration).toBe(7);
    expect(modal?.actualDuration).toBe(8);
  });
});

// ── buildHotCommitSummaries (unattributed threading) ──────────────────

describe("buildHotCommitSummaries (unattributed threading)", () => {
  function commit(commitIndex: number, commitDuration: number): DevToolsFiberCommit {
    return {
      commitIndex,
      timestamp: commitIndex * 10,
      componentName: "Button",
      actualDuration: commitDuration,
      selfDuration: commitDuration,
      commitDuration,
      didRender: true,
      changeDescription: {
        props: ["onPress"],
        state: null,
        hooks: null,
        context: null,
        didHooksChange: false,
        isFirstMount: false,
      },
      hookTypes: null,
      parentName: null,
      isCompilerOptimized: false,
    };
  }

  it("omits unattributed fields when no tuples are provided", () => {
    const summaries = buildHotCommitSummaries([commit(0, 20)], [0]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.unattributedMs).toBeUndefined();
    expect(summaries[0]!.unattributedFiberCount).toBeUndefined();
  });

  it("attaches unattributedMs and unattributedFiberCount to the matching commit", () => {
    const summaries = buildHotCommitSummaries(
      [commit(0, 20), commit(1, 30)],
      [0, 1],
      [
        [0, 3, 12.5],
        [1, 1, 4],
      ]
    );
    const byIndex = new Map(summaries.map((s) => [s.commitIndex, s]));
    expect(byIndex.get(0)?.unattributedMs).toBe(12.5);
    expect(byIndex.get(0)?.unattributedFiberCount).toBe(3);
    expect(byIndex.get(1)?.unattributedMs).toBe(4);
    expect(byIndex.get(1)?.unattributedFiberCount).toBe(1);
  });

  it("only attaches unattributed fields on the commit that recorded drops", () => {
    const summaries = buildHotCommitSummaries(
      [commit(0, 20), commit(1, 30)],
      [0, 1],
      [[0, 2, 7]]
    );
    const byIndex = new Map(summaries.map((s) => [s.commitIndex, s]));
    expect(byIndex.get(0)?.unattributedMs).toBe(7);
    expect(byIndex.get(0)?.unattributedFiberCount).toBe(2);
    expect(byIndex.get(1)?.unattributedMs).toBeUndefined();
    expect(byIndex.get(1)?.unattributedFiberCount).toBeUndefined();
  });

  it("omits fields for a tuple with zero fiber count (defensive)", () => {
    const summaries = buildHotCommitSummaries([commit(0, 20)], [0], [[0, 0, 0]]);
    expect(summaries[0]!.unattributedMs).toBeUndefined();
    expect(summaries[0]!.unattributedFiberCount).toBeUndefined();
  });
});
