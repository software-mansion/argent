import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FAILURE_CODES, ServiceState, getFailureSignal, type Registry } from "@argent/registry";
import { createReactProfilerStopTool } from "../../src/tools/profiler/react/react-profiler-stop";
import { profilerCommitQueryTool } from "../../src/tools/profiler/query/profiler-commit-query";
import { profilerCpuQueryTool } from "../../src/tools/profiler/query/profiler-cpu-query";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { reactProfilerRendersTool } from "../../src/tools/profiler/react/react-profiler-renders";
import { nativeProfilerSessionBlueprint } from "../../src/blueprints/native-profiler-session";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
  getCachedProfilerPaths,
  type ProfilerSessionPaths,
} from "../../src/blueprints/react-profiler-session";
import { readCommitTree, readCpuProfile } from "../../src/utils/react-profiler/debug/dump";
import {
  buildCpuSampleIndex,
  serializeCpuSampleIndex,
} from "../../src/utils/react-profiler/pipeline/00-cpu-correlate";
import {
  parseRenderSummary,
  summarizeRenders,
  type RenderSummary,
} from "../../src/utils/react-profiler/render-summary";
import type {
  DevToolsFiberCommit,
  ProfilingDataBackend,
} from "../../src/utils/react-profiler/types/input";
import { redirectTmpdir } from "../helpers/tmpdir-env";

const PORT = 8081;

let scratch = "";
let restoreTmpdir: () => void = () => {};
const cachedDevices: string[] = [];

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), "argent-render-summary-tools-"));
  // getDebugDir() resolves under os.tmpdir(); keep the dumps out of the
  // machine-wide /tmp/argent-profiler-cwd that a real tool-server lists.
  restoreTmpdir = redirectTmpdir(scratch);
});

afterEach(async () => {
  restoreTmpdir();
  for (const id of cachedDevices.splice(0)) clearCachedProfilerPaths(PORT, id);
  await fs.rm(scratch, { recursive: true, force: true });
});

// ── react-profiler-stop ───────────────────────────────────────────────

/**
 * A backend recording: `cheap` commits of 5 ms where `Row` re-renders, then
 * one 40 ms commit. Fiber 1 = Screen, fiber 2 = Row.
 */
function backend(cheap: number, withHotCommit: boolean): ProfilingDataBackend {
  const commitData = [];
  const rerender = {
    props: ["now"],
    state: null,
    hooks: [],
    context: false,
    didHooksChange: false,
    isFirstMount: false,
  };
  for (let i = 0; i < cheap; i++) {
    commitData.push({
      timestamp: i * 16,
      duration: 5,
      fiberActualDurations: [
        [1, 5],
        [2, 4],
      ] as Array<[number, number]>,
      fiberSelfDurations: [
        [1, 1],
        [2, 4],
      ] as Array<[number, number]>,
      changeDescriptions: [
        [1, { ...rerender, props: [] }],
        [2, rerender],
      ] as Array<[number, unknown]>,
    });
  }
  if (withHotCommit) {
    commitData.push({
      timestamp: cheap * 16,
      duration: 40,
      fiberActualDurations: [[1, 40]] as Array<[number, number]>,
      fiberSelfDurations: [[1, 40]] as Array<[number, number]>,
      changeDescriptions: [[1, { ...rerender, props: [] }]] as Array<[number, unknown]>,
    });
  }
  return { dataForRoots: [{ commitData }] };
}

function stopRegistry(
  live: ProfilingDataBackend,
  recordingMs: number,
  cpuProfile?: object
): Registry {
  const profile = cpuProfile ?? {
    nodes: [{ id: 1, callFrame: {}, hitCount: 0 }],
    samples: [1],
    timeDeltas: [0],
    startTime: 0,
    endTime: recordingMs * 1000,
  };
  const cdp = {
    isConnected: () => true,
    send: async (method: string, params?: { expression?: string }) => {
      if (method === "Profiler.stop") return { profile };
      if (method === "Runtime.evaluate" && params?.expression?.includes("getProfilingData")) {
        return {
          result: {
            value: JSON.stringify({
              live,
              displayNameById: { "1": "Screen", "2": "Row" },
              displayNameApiAvailable: true,
            }),
          },
        };
      }
      // Fiber metadata and anything else: nothing to add.
      return { result: { value: JSON.stringify({}) } };
    },
  };
  const api = {
    cdp,
    port: PORT,
    deviceId: "stop-device",
    profilingActive: true,
    sessionId: null,
    ownerToolServerPid: null,
    detectedArchitecture: "bridgeless",
    profileStartWallMs: 0,
    projectRoot: "/app",
    appName: "app",
    deviceName: "sim",
    disposeSession: () => {},
  };
  cachedDevices.push("stop-device");
  return {
    getSnapshot: () => ({
      services: new Map([
        [`ReactProfilerSession:${PORT}:stop-device`, { state: ServiceState.RUNNING }],
      ]),
      namespaces: [],
      tools: [],
    }),
    resolveService: async () => api,
  } as unknown as Registry;
}

async function stop(live: ProfilingDataBackend, recordingMs: number, cpuProfile?: object) {
  const response = await createReactProfilerStopTool(stopRegistry(live, recordingMs, cpuProfile))
    .execute!({}, { port: PORT, device_id: "stop-device" });
  const dir = join(scratch, "argent-profiler-cwd");
  const files = await fs.readdir(dir);
  const onDisk = await readCommitTree(
    join(
      dir,
      files.find((f) => f.endsWith("_commits.json"))!
    )
  );
  const cpuOnDisk = await readCpuProfile(
    join(
      dir,
      files.find((f) => f.endsWith("_cpu.json"))!
    )
  );
  return { response, onDisk, cpuOnDisk };
}

/** Commit timings for these durations, `gapMs` apart. */
function timings(durations: number[], gapMs = 100) {
  return durations.map((durationMs, i) => ({ timestamp: i * gapMs, durationMs }));
}

describe("react-profiler-stop render summary", () => {
  it("saves counts over all commits next to the unchanged hot ±1 commits", async () => {
    // 100 cheap commits, then a hot one: only commit 99 (margin) and 100 are kept.
    const { onDisk } = await stop(backend(100, true), 2000);
    expect(new Set(onDisk.commits.map((c) => c.commitIndex))).toEqual(new Set([99, 100]));

    const summary = parseRenderSummary(onDisk.meta?.renderSummary)!;
    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      totalCommits: 101,
      totalRenderMs: 540,
      // The last second: 62 commits of 5 ms, 16 ms apart, and the 40 ms commit.
      peakSecondRenderMs: 350,
      maxCommitMs: 40,
      recordingMs: 2000,
    });
    expect(summary.components.find((c) => c.name === "Row")).toMatchObject({
      rerenders: 100,
      rerenderSelfMs: 400,
      reason: "props",
      topProps: ["now"],
    });
  });

  it("reports what was measured on a session with no slow commit", async () => {
    // 200 commits × 5 ms in 2 s: 50% of the session, none ≥16 ms.
    const { response } = await stop(backend(200, false), 2000);
    expect(response["hot_commit_indices"]).toEqual([]);
    expect(response["react_render_ms"]).toBe(1000);
    expect(response["react_render_share_pct"]).toBe(50);
    expect(response["react_render_peak_1s_pct"]).toBe(31.5);
    expect(response["selection_note"]).toBe(
      "No commit reached 16ms. React rendered for 50% of the session, peak 32% in 1 s"
    );
  });

  it("counts updates in subtrees no rendered ancestor joins, named or not", async () => {
    // 100 commits in 2 s: Screen, Row and an unnamed fiber each update on their
    // own, so the DevTools duration is only the largest of them.
    const durations: Array<[number, number]> = [
      [1, 3],
      [2, 2],
      [3, 1],
    ];
    const commitData = Array.from({ length: 100 }, (_, i) => ({
      timestamp: i * 16,
      duration: 3,
      fiberActualDurations: durations,
      fiberSelfDurations: durations,
      changeDescriptions: [] as Array<[number, unknown]>,
    }));
    const { response } = await stop({ dataForRoots: [{ commitData }] }, 2000);
    expect(response["react_render_ms"]).toBe(600);
    expect(response["react_render_share_pct"]).toBe(30);
    expect(response["hot_commit_indices"]).toEqual([]);
  });

  it("does not claim all commits were cheap when a slow one has no named fibers", async () => {
    const live = backend(4, false);
    live.dataForRoots[0]!.commitData.push({
      timestamp: 100,
      duration: 40,
      fiberActualDurations: [[99, 40]],
      fiberSelfDurations: [[99, 40]],
      changeDescriptions: [],
    });
    const { response } = await stop(live, 10_000);
    expect(response["hot_commit_indices"]).toEqual([]);
    expect(response["selection_note"]).toContain("The slowest commit took 40.0ms");
    expect(response["selection_note"]).not.toContain("No commit reached 16ms");
  });

  it("measures the session from the first real sample of a profile with a stale first stamp", async () => {
    // 200 commits × 5 ms in 2 s, under a profile whose first sample has no stamp:
    // `startTime` is 0 and the first positive delta is the device clock.
    const { response, onDisk, cpuOnDisk } = await stop(backend(200, false), 2000, {
      nodes: [{ id: 1, callFrame: {}, hitCount: 0 }],
      samples: [1, 1, 1],
      timeDeltas: [0, 704_097_219_211, 2_000_000],
      startTime: 0,
      endTime: 704_099_219_211,
    });
    expect(response["duration_ms"]).toBe(2000);
    expect(response["react_render_share_pct"]).toBe(50);
    expect(parseRenderSummary(onDisk.meta?.renderSummary)!.recordingMs).toBe(2000);
    // The saved profile is the repaired one, so analyze and the CPU queries agree.
    expect(cpuOnDisk).toMatchObject({
      startTime: 704_097_219_211,
      endTime: 704_099_219_211,
      timeDeltas: [0, 0, 2_000_000],
    });
  });

  it("does not call a commit hot when its only named fiber did not render", async () => {
    // The pipeline builds a hot commit from fibers that rendered. A commit stop
    // called hot without one had no place in the report: stop said 1 hot, the
    // report said 0.
    const live = backend(4, false);
    live.dataForRoots[0]!.commitData.push({
      timestamp: 100,
      duration: 40,
      fiberActualDurations: [
        [1, 0],
        [99, 40],
      ],
      fiberSelfDurations: [
        [1, 0],
        [99, 40],
      ],
      changeDescriptions: [],
    });
    const { response, onDisk } = await stop(live, 10_000);
    expect(response["hot_commit_indices"]).toEqual([]);
    expect(onDisk.commits).toEqual([]);
    expect(response["selection_note"]).toContain("The slowest commit took 40.0ms");
  });

  it("does not keep a neighbour for a commit that is not hot", async () => {
    // Two slow commits: one with a rendered named fiber, one without.
    const live = backend(0, true);
    live.dataForRoots[0]!.commitData.push({
      timestamp: 100,
      duration: 40,
      fiberActualDurations: [[1, 0]],
      fiberSelfDurations: [[1, 0]],
      changeDescriptions: [],
    });
    const { response, onDisk } = await stop(live, 10_000);
    expect(response["hot_commit_indices"]).toEqual([0]);
    expect(response["selection_note"]).toBe("1 of 2 commits at ≥16ms absolute floor");
    expect(new Set(onDisk.commits.map((c) => c.commitIndex))).toEqual(new Set([0]));
  });

  it("words a quiet session the same way, with no verdict", async () => {
    // 4 commits × 5 ms in 2 s: 1%.
    const { response } = await stop(backend(4, false), 2000);
    expect(response["selection_note"]).toBe(
      "No commit reached 16ms. React rendered for 1.0% of the session, peak 2.0% in 1 s"
    );
  });
});

// ── profiler-commit-query ─────────────────────────────────────────────

function fiber(name: string, commitIndex: number, selfDuration: number): DevToolsFiberCommit {
  return {
    commitIndex,
    timestamp: commitIndex * 16,
    componentName: name,
    actualDuration: selfDuration,
    selfDuration,
    commitDuration: 20,
    didRender: true,
    changeDescription: {
      props: ["now"],
      state: null,
      hooks: [],
      context: false,
      didHooksChange: false,
      isFirstMount: false,
    },
  };
}

/** A context provider's fiber: no change data on any render. */
function providerFiber(commitIndex: number): DevToolsFiberCommit {
  return { ...fiber("ListContext.Provider", commitIndex, 0.1), changeDescription: null };
}

async function cacheSession(
  deviceId: string,
  commits: DevToolsFiberCommit[],
  meta: Record<string, unknown>,
  cpuProfilePath: string | null = null
): Promise<void> {
  const commitsPath = join(scratch, `${deviceId}_commits.json`);
  await fs.writeFile(commitsPath, JSON.stringify({ commits, meta }));
  const paths: ProfilerSessionPaths = {
    sessionId: deviceId,
    debugDir: scratch,
    cpuProfilePath,
    commitsPath,
    cpuSampleIndexPath: null,
    detectedArchitecture: null,
    anyCompilerOptimized: null,
    hotCommitIndices: (meta.hotCommitIndices as number[] | undefined) ?? null,
    totalReactCommits: (meta.totalReactCommits as number | undefined) ?? null,
  };
  cacheProfilerPaths(PORT, paths, deviceId);
  cachedDevices.push(deviceId);
}

function query(deviceId: string, params: Record<string, unknown>): Promise<string> {
  return profilerCommitQueryTool.execute!({}, {
    port: PORT,
    device_id: deviceId,
    ...params,
  } as never) as Promise<string>;
}

/** `Memo(Row)` holds the stored commits; with `plainRow`, a plain `Row` renders in 300 others. */
async function cacheMemoRowSession(
  deviceId: string,
  withSibling: boolean,
  siblingName = "Row"
): Promise<void> {
  const stored = [fiber("Memo(Row)", 0, 30), fiber("Memo(Row)", 1, 30)];
  const cheap = withSibling
    ? Array.from({ length: 300 }, (_, i) => fiber(siblingName, i + 4, 4))
    : [];
  await cacheSession(deviceId, stored, {
    hotCommitIndices: [0, 1],
    totalReactCommits: 2 + cheap.length,
    renderSummary: summarizeRenders(
      [...stored, ...cheap],
      timings(new Array(2 + cheap.length).fill(5), 16),
      5000
    ),
  });
}

/** 468 cheap commits: ClockRow ×30 per commit, nothing kept. */
function clockSummary(): RenderSummary {
  const all: DevToolsFiberCommit[] = [];
  for (let i = 0; i < 468; i++) {
    for (let r = 0; r < 30; r++) all.push(fiber("ClockRow", i, 0.07));
    all.push(fiber("Text", i, 0.08));
  }
  return summarizeRenders(all, timings(new Array(468).fill(7.19), 21.5), 10_074);
}

describe("profiler-commit-query on a session with no kept commits", () => {
  it("still fails when no session is stored", async () => {
    const err = await query("no-session-device", { mode: "by_index", commit_index: 0 }).catch(
      (e: unknown) => e
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.PROFILER_DATA_NOT_LOADED);
  });

  it("explains why nothing is stored instead of asking for a new profile", async () => {
    await cacheSession("no-hot-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    for (const mode of ["by_index", "by_component", "by_time_range", "cascade_tree"]) {
      const out = await query("no-hot-device", {
        mode,
        commit_index: 3,
        component_name: "ClockRow",
        time_range_ms: { start: 0, end: 1000 },
      });
      expect(out, mode).toContain("none of its 468 React commits reached 16ms (peak 7.1ms)");
      expect(out, mode).toContain("not a missing session");
      expect(out, mode).toContain(
        "**React render time:** 3,365 ms of 10.1 s (33%), peak 34% in 1 s, 468 commits."
      );
      expect(out, mode).not.toMatch(/smooth|All clear|add up/);
      expect(out, mode).toContain("mode=`render_counts`");
      expect(out, mode).not.toContain("Run react-profiler-start");
    }
  });

  it("gives a quiet session no verdict either", async () => {
    await cacheSession("quiet-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 4,
      renderSummary: summarizeRenders([fiber("A", 0, 1)], timings([2, 2, 2, 2]), 10_000),
    });
    const out = await query("quiet-device", { mode: "by_index", commit_index: 0 });
    expect(out).toContain("8.0 ms of 10.0 s (0.1%), peak 0.8% in 1 s, 4 commits.");
    expect(out).not.toContain("smooth");
  });

  it("says a slow commit was not kept", async () => {
    await cacheSession("unnamed-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 2,
      renderSummary: summarizeRenders([fiber("A", 0, 1)], timings([2, 40]), 10_000),
    });
    const out = await query("unnamed-device", { mode: "by_index", commit_index: 0 });
    expect(out).toContain("those of 16ms or more (peak 40.0ms) have no component");
    expect(out).toContain("A commit was slow, but it has no breakdown.");
  });

  it("handles an old session without a summary", async () => {
    await cacheSession("old-device", [], { hotCommitIndices: [], totalReactCommits: 12 });
    const out = await query("old-device", { mode: "by_index", commit_index: 0 });
    expect(out).toContain("none of its 12 React commits reached 16ms");
    expect(out).toContain("usually because an older version saved it");
  });

  it("says when nothing rendered at all", async () => {
    await cacheSession("idle-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 0,
      renderSummary: summarizeRenders([], [], 10_000),
    });
    expect(await query("idle-device", { mode: "by_index", commit_index: 0 })).toContain(
      "No React commits were recorded"
    );
  });
});

describe("profiler-commit-query render_counts", () => {
  it("lists every component over all commits, library ones included", async () => {
    await cacheSession("counts-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    const out = await query("counts-device", { mode: "render_counts" });
    expect(out).toContain("## Render Counts — all 468 commits");
    expect(out).toContain(
      "**React render time:** 3,365 ms of 10.1 s (33%), peak 34% in 1 s, 468 commits"
    );
    const rows = out.split("\n").filter((l) => l.startsWith("| `"));
    expect(out).toContain("| Per second | Re-render commits | Self total (ms) |");
    expect(rows[0]).toMatch(/^\| `ClockRow` \| 14,040 \| 1393\.7 \| 468 \| /);
    expect(rows[0]).toContain("props: now");
    expect(rows[1]).toMatch(/^\| `Text` \| 468 \|/);
  });

  it("narrows to one component and caps with top_n", async () => {
    await cacheSession("counts-filter-device", [], {
      hotCommitIndices: [],
      renderSummary: clockSummary(),
    });
    const one = await query("counts-filter-device", {
      mode: "render_counts",
      component_name: "Text",
    });
    expect(one).toContain("## Render Counts for `Text`");
    const oneRows = one.split("\n").filter((l) => l.startsWith("| `"));
    expect(oneRows).toHaveLength(1);
    expect(oneRows[0]).toMatch(/^\| `Text` \|/);
    expect(one).not.toContain("raise top_n");

    const capped = await query("counts-filter-device", { mode: "render_counts", top_n: 1 });
    expect(capped).toContain("_Showing 1 of 2 components; raise top_n for more._");

    const missing = await query("counts-filter-device", {
      mode: "render_counts",
      component_name: "Nope",
    });
    expect(missing).toContain("not found in this profiling session");
  });

  it("keeps a context fiber's renders out of Mounts and shows them as no change data", async () => {
    const provider = (commitIndex: number): DevToolsFiberCommit => ({
      ...fiber("ListContext.Provider", commitIndex, 0.1),
      changeDescription: null,
    });
    await cacheSession("context-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 2,
      renderSummary: summarizeRenders([provider(0), provider(1)], timings([1, 1]), 1000),
    });
    const out = await query("context-device", { mode: "render_counts" });
    expect(out).toContain("0 re-renders, 0 mounts, 2 with no change data");
    expect(out).toMatch(/\| 0 \| 2 \| no change data \|$/m);
  });

  it("explains an old session without a summary", async () => {
    await cacheSession("counts-old-device", [fiber("A", 0, 20)], { hotCommitIndices: [0] });
    expect(await query("counts-old-device", { mode: "render_counts" })).toContain(
      "has no render summary"
    );
  });

  it("by_component points at render_counts for a component that rendered only in cold commits", async () => {
    await cacheSession("cold-device", [fiber("Hot", 5, 30)], {
      hotCommitIndices: [5],
      renderSummary: summarizeRenders(
        [fiber("Hot", 5, 30), fiber("Cold", 1, 1)],
        timings([3, 30]),
        1000
      ),
    });
    const out = await query("cold-device", { mode: "by_component", component_name: "Cold" });
    expect(out).toContain("`Cold` rendered 1 time in this session, but never in a stored commit");
    expect(out).toContain("mode=`render_counts` component_name=`Cold`");
  });

  it("by_component reports a name that is ambiguous only among cold commits", async () => {
    await cacheSession("cold-ambiguous-device", [fiber("Hot", 5, 30)], {
      hotCommitIndices: [5],
      renderSummary: summarizeRenders(
        [fiber("Hot", 5, 30), fiber("Memo(Foo)", 1, 1), fiber("Forget(Foo)", 2, 1)],
        timings([3, 3, 30]),
        1000
      ),
    });
    const out = await query("cold-ambiguous-device", {
      mode: "by_component",
      component_name: "Foo",
    });
    expect(out).toContain("is ambiguous");
    expect(out).not.toContain("not found");
  });

  it("by_component counts a missing name against the whole session", async () => {
    await cacheSession("cold-missing-device", [fiber("Hot", 5, 30)], {
      hotCommitIndices: [5],
      renderSummary: summarizeRenders(
        [fiber("Hot", 5, 30), fiber("Cold", 1, 1)],
        timings([3, 3, 3]),
        1000
      ),
    });
    const out = await query("cold-missing-device", {
      mode: "by_component",
      component_name: "Nope",
    });
    expect(out).toContain("recorded 2 fiber renders across 3 commits");
    expect(out).toContain("mode=`render_counts` without `component_name`");
    expect(out).not.toContain("by_index");
  });

  it("by_component finds a cold component by its name without wrappers", async () => {
    await cacheSession("cold-display-device", [fiber("Hot", 5, 30)], {
      hotCommitIndices: [5],
      renderSummary: summarizeRenders(
        [fiber("Hot", 5, 30), fiber("Memo(Ticker)", 1, 1)],
        timings([3, 30]),
        1000
      ),
    });
    const out = await query("cold-display-device", {
      mode: "by_component",
      component_name: "Ticker",
    });
    expect(out).toContain("`Memo(Ticker)` rendered 1 time in this session");
  });

  it("by_component says when its total covers only the stored commits", async () => {
    const stored = [fiber("ClockRow", 7, 0.07), fiber("ClockRow", 8, 0.07)];
    await cacheSession("partial-device", stored, {
      hotCommitIndices: [7],
      renderSummary: clockSummary(),
    });
    const out = await query("partial-device", { mode: "by_component", component_name: "ClockRow" });
    expect(out).toContain(
      "**Total occurrences:** 2 across 2 commits (stored commits only; 14,040 renders over all 468 commits, see mode=`render_counts`)"
    );
  });

  it("by_component adds nothing when the stored commits hold every render", async () => {
    const stored = [fiber("Row", 0, 20), fiber("Row", 1, 20)];
    await cacheSession("complete-device", stored, {
      hotCommitIndices: [0, 1],
      renderSummary: summarizeRenders(stored, timings([20, 20]), 1000),
    });
    const out = await query("complete-device", { mode: "by_component", component_name: "Row" });
    expect(out).toContain("**Total occurrences:** 2 across 2 commits\n");
  });

  it("by_component does not let stored entries that did not render hide renders elsewhere", async () => {
    const bailouts = [0, 1, 2].map((i) => ({ ...fiber("Row", i, 0), didRender: false }));
    const renders = [fiber("Row", 5, 4), fiber("Row", 6, 4)];
    await cacheSession("bailout-device", bailouts, {
      hotCommitIndices: [1],
      renderSummary: summarizeRenders(
        [...bailouts, ...renders],
        timings(new Array(7).fill(5)),
        1000
      ),
    });
    const out = await query("bailout-device", { mode: "by_component", component_name: "Row" });
    expect(out).toContain(
      "(stored commits only; 2 renders over all 7 commits, see mode=`render_counts`)"
    );
  });

  it("by_component counts a provider that rendered only in unstored commits", async () => {
    const hot = fiber("Hot", 5, 30);
    await cacheSession("provider-cold-device", [hot], {
      hotCommitIndices: [5],
      renderSummary: summarizeRenders(
        [providerFiber(0), providerFiber(1), providerFiber(2), hot],
        timings([1, 1, 1, 30]),
        1000
      ),
    });
    const out = await query("provider-cold-device", {
      mode: "by_component",
      component_name: "ListContext.Provider",
    });
    expect(out).toContain("`ListContext.Provider` rendered 3 times in this session");
  });

  it("by_component keeps the stored-only note for a provider with stored renders", async () => {
    await cacheSession("provider-partial-device", [providerFiber(2)], {
      hotCommitIndices: [2],
      renderSummary: summarizeRenders(
        [providerFiber(0), providerFiber(1), providerFiber(2)],
        timings([1, 1, 30]),
        1000
      ),
    });
    const out = await query("provider-partial-device", {
      mode: "by_component",
      component_name: "ListContext.Provider",
    });
    expect(out).toContain(
      "**Total occurrences:** 1 across 1 commits (stored commits only; 3 renders over all 3 commits, see mode=`render_counts`)"
    );
  });

  it("does not treat a plain name as its wrapped fiber when the plain one is its own component", async () => {
    await cacheMemoRowSession("row-memo-device", true);
    const out = await query("row-memo-device", { mode: "by_component", component_name: "Row" });
    expect(out).toContain("## Commits for `Memo(Row)`");
    expect(out).toContain("A separate `Row` rendered 300 times outside the stored commits.");
    expect(out).toContain("mode=`render_counts` component_name=`Row`");
    expect(out).not.toContain("Either name works");
  });

  it.each(["Forget(Row)", "ForwardRef(Row)", "Forget(Memo(Row))"])(
    "names a separate %s too, not only an unwrapped one",
    async (sibling) => {
      const device = `row-sibling-${sibling}`;
      await cacheMemoRowSession(device, true, sibling);
      const out = await query(device, { mode: "by_component", component_name: "Row" });
      expect(out).toContain("## Commits for `Memo(Row)`");
      expect(out).toContain(
        `A separate \`${sibling}\` rendered 300 times outside the stored commits.`
      );
      expect(out).toContain(`mode=\`render_counts\` component_name=\`${sibling}\``);
      expect(out).not.toContain("Either name works");
    }
  );

  it("counts the mounts of a separate component of that name", async () => {
    const stored = [fiber("Memo(Row)", 0, 30), fiber("Memo(Row)", 1, 30)];
    const mounts = Array.from({ length: 40 }, (_, i) => {
      const row = fiber("Row", i + 4, 1);
      return { ...row, changeDescription: { ...row.changeDescription!, isFirstMount: true } };
    });
    await cacheSession("row-mounts-device", stored, {
      hotCommitIndices: [0, 1],
      totalReactCommits: 42,
      renderSummary: summarizeRenders(
        [...stored, ...mounts],
        timings(new Array(42).fill(5), 16),
        5000
      ),
    });
    const out = await query("row-mounts-device", { mode: "by_component", component_name: "Row" });
    expect(out).toContain("A separate `Row` rendered 40 times outside the stored commits.");
  });

  it("keeps the short note when the wrapped fiber is the only component of that name", async () => {
    await cacheMemoRowSession("memo-only-device", false);
    const out = await query("memo-only-device", { mode: "by_component", component_name: "Row" });
    expect(out).toContain("Either name works here.");
    expect(out).not.toContain("A separate");
  });

  it("a name render_counts cannot find points at the full list, not at by_index", async () => {
    await cacheSession("counts-miss-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    const out = await query("counts-miss-device", {
      mode: "render_counts",
      component_name: "Nope",
    });
    expect(out).toContain("not found in this profiling session");
    expect(out).toContain("mode=`render_counts` without `component_name`");
    expect(out).not.toContain("by_index");
  });

  it("says no commits were recorded instead of printing an empty table", async () => {
    await cacheSession("counts-idle-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 0,
      renderSummary: summarizeRenders([], [], 6000),
    });
    const out = await query("counts-idle-device", { mode: "render_counts" });
    expect(out).toContain("No React commits were recorded");
    expect(out).not.toContain("| Component |");
  });

  it("says no component could be named instead of printing an empty table", async () => {
    await cacheSession("counts-nameless-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 2,
      renderSummary: summarizeRenders([], timings([5, 5]), 1000),
    });
    for (const params of [{}, { component_name: "Row" }]) {
      const out = await query("counts-nameless-device", { mode: "render_counts", ...params });
      expect(out).toContain("**React render time:** 10 ms of 1.0 s");
      expect(out).toContain("No component in this session could be named");
      expect(out).not.toContain("| Component |");
    }
  });
});

describe("profiler-commit-query by_time_range outside the stored commits", () => {
  const window = { mode: "by_time_range", time_range_ms: { start: 0, end: 4000 } };
  // Stored at t = 80 000 ms, so the window above holds none of them.
  const stored = [fiber("Hot", 5000, 30)];

  it("says the window can hold commits that were not stored", async () => {
    await cacheSession("range-device", stored, {
      hotCommitIndices: [5000],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    const out = await query("range-device", window);
    expect(out).toContain("No stored commits in the range 0ms → 4000ms");
    expect(out).toContain("commits under 16ms in this range are not listed");
    expect(out).toContain("mode=`render_counts`");
  });

  it("does not offer render_counts to a session without a summary", async () => {
    await cacheSession("range-old-device", stored, {
      hotCommitIndices: [5000],
      totalReactCommits: 468,
    });
    const out = await query("range-old-device", window);
    expect(out).toContain("commits under 16ms in this range are not listed");
    expect(out).not.toContain("render_counts");
  });

  it("keeps the plain answer when every commit is stored", async () => {
    await cacheSession("range-all-device", stored, {
      hotCommitIndices: [5000],
      totalReactCommits: 1,
      renderSummary: summarizeRenders(stored, timings([30]), 1000),
    });
    expect(await query("range-all-device", window)).toBe(
      "_No commits found in the range 0ms → 4000ms._"
    );
  });

  // Commit 5 sits at t = 80 ms, inside the window above.
  const inWindow = [fiber("Hot", 5, 30)];

  it("notes commits that were not stored when the window holds a stored commit", async () => {
    await cacheSession("range-partial-device", inWindow, {
      hotCommitIndices: [5],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    const out = await query("range-partial-device", window);
    expect(out).toContain("**Commits:** 1  **Fiber renders:** 1");
    expect(out).toContain(
      "_Only commits of 16ms or more and their neighbours are stored (1 of 468 commits in this session), so this range can hold commits that are not listed. mode=`render_counts` counts them over the whole session, without timing._"
    );
  });

  it("does not offer render_counts next to a stored commit without a summary", async () => {
    await cacheSession("range-partial-old-device", inWindow, {
      hotCommitIndices: [5],
      totalReactCommits: 468,
    });
    const out = await query("range-partial-old-device", window);
    expect(out).toContain("(1 of 468 commits in this session)");
    expect(out).not.toContain("render_counts");
  });

  it("adds no note next to a stored commit when every commit is stored", async () => {
    await cacheSession("range-partial-all-device", inWindow, {
      hotCommitIndices: [5],
      totalReactCommits: 1,
      renderSummary: summarizeRenders(inWindow, timings([30]), 1000),
    });
    const out = await query("range-partial-all-device", window);
    expect(out).toContain("**Commits:** 1  **Fiber renders:** 1");
    expect(out).not.toContain("are stored");
  });

  it("compares the session total with stored commits, not with their fibers", async () => {
    // 6 fiber entries, 2 commits, 4 commits in the session: 2 commits were not stored.
    const manyFibers = [5, 6].flatMap((i) => [
      fiber("A", i, 10),
      fiber("B", i, 10),
      fiber("C", i, 10),
    ]);
    await cacheSession("range-fibers-device", manyFibers, {
      hotCommitIndices: [5, 6],
      totalReactCommits: 4,
    });
    expect(await query("range-fibers-device", window)).toContain(
      "(2 of 4 commits in this session)"
    );
    expect(
      await query("range-fibers-device", {
        mode: "by_time_range",
        time_range_ms: { start: 1000, end: 4000 },
      })
    ).toContain("No stored commits in the range 1000ms → 4000ms");
  });
});

// ── profiler-cpu-query ────────────────────────────────────────────────

describe("profiler-cpu-query component_cpu", () => {
  async function cacheCpuSession(
    deviceId: string,
    commits: DevToolsFiberCommit[],
    meta: Record<string, unknown>
  ): Promise<void> {
    const cpuProfilePath = join(scratch, `${deviceId}_cpu.json`);
    const frame = { scriptId: "0", url: "", lineNumber: 0, columnNumber: 0 };
    const root = { id: 1, callFrame: { ...frame, functionName: "[root]" }, children: [2] };
    const work = { id: 2, callFrame: { ...frame, functionName: "work" } };
    await fs.writeFile(
      cpuProfilePath,
      JSON.stringify({
        startTime: 1000,
        endTime: 1_001_000,
        nodes: [root, work],
        // One sample of `work` spans the first second, where the fixtures' commits sit.
        samples: [2, 2],
        timeDeltas: [0, 1_000_000],
      })
    );
    await cacheSession(deviceId, commits, meta, cpuProfilePath);
  }

  function componentCpu(deviceId: string, componentName: string): Promise<string> {
    return profilerCpuQueryTool.execute!({}, {
      port: PORT,
      device_id: deviceId,
      mode: "component_cpu",
      component_name: componentName,
      top_n: 15,
    } as never) as Promise<string>;
  }

  it("says when the wrapped fiber it answers for is not the only component of that name", async () => {
    const stored = [fiber("Memo(Row)", 0, 30), fiber("Memo(Row)", 1, 30)];
    const cheap = Array.from({ length: 300 }, (_, i) => fiber("Row", i + 4, 4));
    await cacheCpuSession("cpu-row-memo-device", stored, {
      hotCommitIndices: [0, 1],
      totalReactCommits: 302,
      renderSummary: summarizeRenders(
        [...stored, ...cheap],
        timings(new Array(302).fill(5), 16),
        5000
      ),
    });
    const out = await componentCpu("cpu-row-memo-device", "Row");
    expect(out).toContain("## CPU During `Memo(Row)` Commits");
    expect(out).toContain("A separate `Row` rendered 300 times outside the stored commits.");
    expect(out).toContain(
      "Run `profiler-commit-query` mode=`render_counts` component_name=`Row` for its counts."
    );
    expect(out).not.toContain("Either name works");
  });

  it("says so for a wrapped separate component too", async () => {
    const stored = [fiber("Memo(Row)", 0, 30), fiber("Memo(Row)", 1, 30)];
    const cheap = Array.from({ length: 300 }, (_, i) => fiber("Forget(Row)", i + 4, 4));
    await cacheCpuSession("cpu-row-forget-device", stored, {
      hotCommitIndices: [0, 1],
      totalReactCommits: 302,
      renderSummary: summarizeRenders(
        [...stored, ...cheap],
        timings(new Array(302).fill(5), 16),
        5000
      ),
    });
    const out = await componentCpu("cpu-row-forget-device", "Row");
    expect(out).toContain("## CPU During `Memo(Row)` Commits");
    expect(out).toContain(
      "A separate `Forget(Row)` rendered 300 times outside the stored commits."
    );
    expect(out).not.toContain("Either name works");
  });

  it("reads the stored commits through the index analyze cached", async () => {
    // The path agents take: analyze wrote the index. No raw profile exists here,
    // so a fall-through to it would fail instead of passing unnoticed.
    const stored = [fiber("ClockRow", 7, 0.07), fiber("ClockRow", 8, 0.07)];
    await cacheSession(
      "cpu-cached-device",
      stored,
      { hotCommitIndices: [7], totalReactCommits: 468, renderSummary: clockSummary() },
      join(scratch, "no-such-profile.json")
    );
    const frame = { scriptId: "0", url: "", lineNumber: 0, columnNumber: 0 };
    const index = buildCpuSampleIndex({
      startTime: 1000,
      endTime: 1_001_000,
      nodes: [
        { id: 1, callFrame: { ...frame, functionName: "[root]" }, children: [2] },
        { id: 2, callFrame: { ...frame, functionName: "work" } },
      ],
      samples: [2, 2],
      timeDeltas: [0, 1_000_000],
    } as never);
    const cpuSampleIndexPath = join(scratch, "cpu-cached-device_index.json");
    await fs.writeFile(cpuSampleIndexPath, JSON.stringify(serializeCpuSampleIndex(index)));
    const paths = getCachedProfilerPaths(PORT, "cpu-cached-device")!;
    cacheProfilerPaths(PORT, { ...paths, cpuSampleIndexPath }, "cpu-cached-device");

    const out = await componentCpu("cpu-cached-device", "ClockRow");
    expect(out).toContain("## CPU During `ClockRow` Commits");
    expect(out).toContain("| `work` |");
    expect(out).toContain("14,040 renders over all 468 commits");
  });

  it("does not deny a component that rendered only in commits that were not stored", async () => {
    await cacheCpuSession("cpu-cold-device", [fiber("Hot", 7, 30)], {
      hotCommitIndices: [7],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    const out = await componentCpu("cpu-cold-device", "ClockRow");
    expect(out).toContain("`ClockRow` rendered 14,040 times in this session");
    expect(out).toContain("mode=`render_counts` component_name=`ClockRow`");
    expect(out).toContain("mode=`top_functions`");
    expect(out).not.toContain("not found");
  });

  it("says when its totals cover only the stored commits, and names the other tool", async () => {
    const stored = [fiber("ClockRow", 7, 0.07), fiber("ClockRow", 8, 0.07)];
    await cacheCpuSession("cpu-partial-device", stored, {
      hotCommitIndices: [7],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    const out = await componentCpu("cpu-partial-device", "ClockRow");
    expect(out).toContain(
      "**Commits:** 2  **Total commit time:** 40.0ms (stored commits only; 14,040 renders over all 468 commits, see `profiler-commit-query` mode=`render_counts`)"
    );
  });

  it("does not let stored entries that did not render hide renders elsewhere", async () => {
    const bailouts = [0, 1, 2].map((i) => ({ ...fiber("Row", i, 0), didRender: false }));
    const renders = [fiber("Row", 5, 4), fiber("Row", 6, 4)];
    await cacheCpuSession("cpu-bailout-device", bailouts, {
      hotCommitIndices: [1],
      totalReactCommits: 7,
      renderSummary: summarizeRenders(
        [...bailouts, ...renders],
        timings(new Array(7).fill(5)),
        1000
      ),
    });
    const out = await componentCpu("cpu-bailout-device", "Row");
    expect(out).toContain("(stored commits only; 2 renders over all 7 commits");
  });

  it("adds nothing when the stored commits hold every render", async () => {
    const stored = [fiber("Row", 0, 20), fiber("Row", 1, 20)];
    await cacheCpuSession("cpu-complete-device", stored, {
      hotCommitIndices: [0, 1],
      totalReactCommits: 2,
      renderSummary: summarizeRenders(stored, timings([20, 20]), 1000),
    });
    const out = await componentCpu("cpu-complete-device", "Row");
    expect(out).toContain("**Commits:** 2  **Total commit time:** 40.0ms\n");
  });

  it("counts a missing name against the whole session", async () => {
    await cacheCpuSession("cpu-miss-device", [fiber("Hot", 7, 30)], {
      hotCommitIndices: [7],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    const out = await componentCpu("cpu-miss-device", "Nope");
    expect(out).toContain("not found in this profiling session");
    expect(out).toContain("mode=`render_counts` without `component_name`");
  });

  it("keeps the stored-commit answer for a session without a summary", async () => {
    await cacheCpuSession("cpu-old-miss-device", [fiber("Hot", 7, 30)], {
      hotCommitIndices: [7],
      totalReactCommits: 12,
    });
    const out = await componentCpu("cpu-old-miss-device", "Nope");
    expect(out).toContain("across 1 commits");
    expect(out).toContain("mode=by_index");
  });

  it("explains a session with no stored commit", async () => {
    await cacheCpuSession("cpu-empty-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    const out = await componentCpu("cpu-empty-device", "ClockRow");
    expect(out).toContain("none of its 468 React commits reached 16ms");
    expect(out).toContain("mode=`render_counts`");
    expect(out).toContain("mode=`top_functions`");
  });

  it("says nothing was recorded on a session with no commits", async () => {
    await cacheCpuSession("cpu-idle-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 0,
      renderSummary: summarizeRenders([], [], 6000),
    });
    const out = await componentCpu("cpu-idle-device", "ClockRow");
    expect(out).toContain("No React commits were recorded");
    expect(out).not.toContain("16ms");
  });

  it("does not send a session without a summary to render_counts for counts", async () => {
    await cacheCpuSession("cpu-old-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 456,
    });
    const out = await componentCpu("cpu-old-device", "ClockRow");
    expect(out).toContain("has no render summary");
    expect(out).not.toContain("for render counts");
  });
});

// ── profiler-combined-report ──────────────────────────────────────────

describe("profiler-combined-report on a session with no stored commit", () => {
  it("names the storage rule and points at the native report", async () => {
    await cacheSession("combined-device", [], {
      hotCommitIndices: [],
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    const device = { id: "combined-device", platform: "ios" as const, kind: "simulator" as const };
    const { api } = await nativeProfilerSessionBlueprint.factory({}, device, { device });
    api.parsedData = {
      cpuSamples: [],
      uiHangs: [],
      cpuHotspots: [],
      memoryLeaks: [],
      leaksRecorded: true,
      mallocStackLogging: true,
      wallClockStartMs: 1_000_000,
    };
    const error: unknown = await Promise.resolve(
      profilerCombinedReportTool.execute!({ nativeSession: api } as never, {
        port: PORT,
        device_id: "combined-device",
      })
    ).catch((e: unknown) => e);
    expect((error as Error).message).toContain("No React commits are stored for this session");
    expect((error as Error).message).toContain("native-profiler-analyze report on its own");
    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.PROFILER_DATA_NOT_LOADED);
  });
});

// ── profiler-load ─────────────────────────────────────────────────────

describe("profiler-load with and without a render summary", () => {
  async function writeSession(
    sid: string,
    meta: Record<string, unknown>,
    commits: DevToolsFiberCommit[] = []
  ): Promise<void> {
    const dir = join(scratch, "argent-profiler-cwd");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, `react-profiler-${sid}_commits.json`),
      JSON.stringify({ commits, meta })
    );
  }

  function load(sid: string): Promise<string> {
    cachedDevices.push("load-device");
    return profilerLoadTool.execute!({}, {
      mode: "load_react",
      session_id: sid,
      port: PORT,
      device_id: "load-device",
    } as never) as Promise<string>;
  }

  it("prints the render time of a new session", async () => {
    await writeSession("20261103-120000", {
      totalReactCommits: 468,
      renderSummary: clockSummary(),
    });
    expect(await load("20261103-120000")).toContain(
      "- React render time (all commits): 3,365 ms of 10.1 s (33%), peak 34% in 1 s, 468 commits"
    );
  });

  it("loads an old session and says it has no counts over all commits", async () => {
    await writeSession("20261103-120001", { totalReactCommits: 12 });
    const out = await load("20261103-120001");
    expect(out).toContain("Loaded React profiler session");
    expect(out).toContain("- Render counts over all commits: not available for this session");
  });

  it("counts persisted commits, not their fibers", async () => {
    const stored = [fiber("A", 5, 20), fiber("B", 5, 1), fiber("A", 6, 1)];
    await writeSession("20261103-120002", { totalReactCommits: 12 }, stored);
    expect(await load("20261103-120002")).toContain(
      "- Commits persisted (hot ±1 margin, ≥16ms): 2"
    );
  });
});

// ── react-profiler-renders ────────────────────────────────────────────

describe("react-profiler-renders", () => {
  // It cannot reach screen content (top 30 fiber levels) and double-counts;
  // HTTP and SDK callers keep it.
  it("is hidden from MCP", () => {
    expect(reactProfilerRendersTool.hideFromMcp).toBe(true);
  });
});
