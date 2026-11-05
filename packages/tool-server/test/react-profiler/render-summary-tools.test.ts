import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceState, type Registry } from "@argent/registry";
import { createReactProfilerStopTool } from "../../src/tools/profiler/react/react-profiler-stop";
import { clearCachedProfilerPaths } from "../../src/blueprints/react-profiler-session";
import { readCommitTree } from "../../src/utils/react-profiler/debug/dump";
import { parseRenderSummary } from "../../src/utils/react-profiler/render-summary";
import type { ProfilingDataBackend } from "../../src/utils/react-profiler/types/input";
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

describe("react-profiler-stop render summary", () => {
  it("saves counts over all commits next to the unchanged hot ±1 commits", async () => {
    // 100 cheap commits, then a hot one: only commit 99 (margin) and 100 are kept.
    const { onDisk } = await stop(backend(100, true), 2000);
    expect(new Set(onDisk.commits.map((c) => c.commitIndex))).toEqual(new Set([99, 100]));

    const summary = parseRenderSummary(onDisk.meta?.renderSummary)!;
    expect(summary).not.toBeNull();
    expect(summary).toMatchObject({
      totalCommits: 101,
      totalCommitMs: 540,
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

  it("does not call a busy session without slow commits smooth", async () => {
    // 200 commits × 5 ms in 2 s: 50% of the session, none ≥16 ms.
    const { response } = await stop(backend(200, false), 2000);
    expect(response["hot_commit_indices"]).toEqual([]);
    expect(response["react_commit_ms"]).toBe(1000);
    expect(response["react_commit_share_pct"]).toBe(50);
    expect(response["selection_note"]).toContain("React spent 50% of the session");
    expect(response["selection_note"]).not.toContain("smooth");
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
    expect(response["selection_note"]).not.toContain("All commits below 16ms");
  });

  it("still calls a quiet session smooth", async () => {
    // 4 commits × 5 ms in 2 s: 1%.
    const { response } = await stop(backend(4, false), 2000);
    expect(response["selection_note"]).toContain("app appears smooth (all-clear)");
    expect(response["selection_note"]).toContain("1.0%");
  });
});
