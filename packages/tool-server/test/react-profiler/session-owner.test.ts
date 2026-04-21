import { describe, it, expect } from "vitest";
import {
  mergeProfilingData,
  classifyStaleness,
  DEFAULT_STALE_THRESHOLD_MS,
  type ProfilerSessionOwner,
  type ProfilingDataBackend,
} from "../../src/tools/profiler/react/react-profiler-session-owner";
import { flattenProfilingData } from "../../src/tools/profiler/react/react-profiler-stop";

function owner(overrides: Partial<ProfilerSessionOwner> = {}): ProfilerSessionOwner {
  return {
    sessionId: "sess-1",
    startedAtEpochMs: 1_000_000_000,
    lastHeartbeatEpochMs: 1_000_000_000,
    toolServerPid: 100,
    toolServerStartedAtEpochMs: 1_000_000_000 - 1000,
    toolName: "react-profiler-start",
    startArgs: {},
    commitCountAtStart: 0,
    ...overrides,
  };
}

function backend(roots: Array<{ rootID: number; commits: number }>): ProfilingDataBackend {
  return {
    dataForRoots: roots.map((r) => ({
      rootID: r.rootID,
      commitData: Array.from({ length: r.commits }, (_, i) => ({
        timestamp: i * 10,
        duration: 5,
        fiberActualDurations: [],
        fiberSelfDurations: [],
        changeDescriptions: [],
      })),
    })),
    rendererID: 1,
  };
}

// ── mergeProfilingData ────────────────────────────────────────────────

describe("mergeProfilingData", () => {
  it("returns live verbatim when prev is null", () => {
    const live = backend([{ rootID: 1, commits: 3 }]);
    const out = mergeProfilingData(live, null);
    expect(out.dataForRoots).toHaveLength(1);
    expect(out.dataForRoots[0]!.commitData).toHaveLength(3);
  });

  it("returns prev verbatim when live is null", () => {
    const prev = backend([{ rootID: 42, commits: 2 }]);
    const out = mergeProfilingData(null, prev);
    expect(out.dataForRoots).toHaveLength(1);
    expect(out.dataForRoots[0]!.rootID).toBe(42);
  });

  it("prefers live over prev when rootIDs overlap", () => {
    const live = backend([{ rootID: 1, commits: 3 }]);
    const prev = backend([{ rootID: 1, commits: 99 }]);
    const out = mergeProfilingData(live, prev);
    expect(out.dataForRoots).toHaveLength(1);
    expect(out.dataForRoots[0]!.commitData).toHaveLength(3); // live wins
  });

  it("appends prev roots that are not in live", () => {
    const live = backend([{ rootID: 1, commits: 3 }]);
    const prev = backend([
      { rootID: 1, commits: 99 }, // dropped: overlaps with live
      { rootID: 2, commits: 5 }, // kept
    ]);
    const out = mergeProfilingData(live, prev);
    expect(out.dataForRoots).toHaveLength(2);
    expect(out.dataForRoots[0]!.rootID).toBe(1);
    expect(out.dataForRoots[0]!.commitData).toHaveLength(3);
    expect(out.dataForRoots[1]!.rootID).toBe(2);
    expect(out.dataForRoots[1]!.commitData).toHaveLength(5);
  });

  it("returns an empty dataForRoots when both inputs are null", () => {
    const out = mergeProfilingData(null, null);
    expect(out.dataForRoots).toEqual([]);
  });
});

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
});
