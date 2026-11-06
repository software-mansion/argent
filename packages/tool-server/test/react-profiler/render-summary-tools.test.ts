import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FAILURE_CODES, ServiceState, getFailureSignal, type Registry } from "@argent/registry";
import { createReactProfilerStopTool } from "../../src/tools/profiler/react/react-profiler-stop";
import { profilerCommitQueryTool } from "../../src/tools/profiler/query/profiler-commit-query";
import { profilerCpuQueryTool } from "../../src/tools/profiler/query/profiler-cpu-query";
import { profilerLoadTool } from "../../src/tools/profiler/query/profiler-load";
import { reactProfilerRendersTool } from "../../src/tools/profiler/react/react-profiler-renders";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
  type ProfilerSessionPaths,
} from "../../src/blueprints/react-profiler-session";
import { readCommitTree } from "../../src/utils/react-profiler/debug/dump";
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

function stopRegistry(live: ProfilingDataBackend, recordingMs: number): Registry {
  const profile = {
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

async function stop(live: ProfilingDataBackend, recordingMs: number) {
  const response = await createReactProfilerStopTool(stopRegistry(live, recordingMs)).execute!(
    {},
    { port: PORT, device_id: "stop-device" }
  );
  const files = await fs.readdir(join(scratch, "argent-profiler-cwd"));
  const commitsFile = files.find((f) => f.endsWith("_commits.json"))!;
  const onDisk = await readCommitTree(join(scratch, "argent-profiler-cwd", commitsFile));
  return { response, onDisk };
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
    expect(one.split("\n").filter((l) => l.startsWith("| `"))).toHaveLength(1);

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
});

// ── profiler-cpu-query ────────────────────────────────────────────────

describe("profiler-cpu-query component_cpu", () => {
  async function cacheCpuSession(
    deviceId: string,
    commits: DevToolsFiberCommit[],
    meta: Record<string, unknown>
  ): Promise<void> {
    const cpuProfilePath = join(scratch, `${deviceId}_cpu.json`);
    const root = {
      id: 1,
      callFrame: { functionName: "[root]", scriptId: "0", url: "", lineNumber: 0, columnNumber: 0 },
    };
    await fs.writeFile(
      cpuProfilePath,
      JSON.stringify({
        startTime: 1000,
        endTime: 2000,
        nodes: [root],
        samples: [1, 1],
        timeDeltas: [0, 1000],
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
});

// ── profiler-load ─────────────────────────────────────────────────────

describe("profiler-load with and without a render summary", () => {
  async function writeSession(sid: string, meta: Record<string, unknown>): Promise<void> {
    const dir = join(scratch, "argent-profiler-cwd");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, `react-profiler-${sid}_commits.json`),
      JSON.stringify({ commits: [], meta })
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
});

// ── react-profiler-renders ────────────────────────────────────────────

describe("react-profiler-renders", () => {
  // It cannot reach screen content (top 30 fiber levels) and double-counts;
  // HTTP and SDK callers keep it.
  it("is hidden from MCP", () => {
    expect(reactProfilerRendersTool.hideFromMcp).toBe(true);
  });
});
