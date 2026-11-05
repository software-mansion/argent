import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "@argent/registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
  getCachedProfilerPaths,
  type ProfilerSessionPaths,
} from "../src/blueprints/react-profiler-session";
import { reactProfilerAnalyzeTool } from "../src/tools/profiler/react/react-profiler-analyze";
import { reactProfilerCpuSummaryTool } from "../src/tools/profiler/react/react-profiler-cpu-summary";
import {
  forgetDeviceAlias,
  rememberDeviceAlias,
  resetDeviceAliases,
} from "../src/utils/debugger/device-alias";

const PORT = 8081;
const SERIAL = "emulator-5554";
const LOGICAL = "6cca05b47beabb97";
const PATHS = { cpuProfilePath: "/tmp/cpu.json" } as ProfilerSessionPaths;
const OLDER = { cpuProfilePath: "/tmp/older.json" } as ProfilerSessionPaths;
const NEWER = { cpuProfilePath: "/tmp/newer.json" } as ProfilerSessionPaths;

afterEach(() => {
  resetDeviceAliases();
  clearCachedProfilerPaths(PORT, SERIAL);
  clearCachedProfilerPaths(PORT, LOGICAL);
});

describe("profiler paths cache", () => {
  it("finds a session stored under the connect id by its logicalDeviceId", () => {
    rememberDeviceAlias(LOGICAL, SERIAL);
    cacheProfilerPaths(PORT, PATHS, SERIAL);

    expect(getCachedProfilerPaths(PORT, LOGICAL)).toBe(PATHS);
    expect(getCachedProfilerPaths(PORT, SERIAL)).toBe(PATHS);
  });

  it("clears a session by either id", () => {
    rememberDeviceAlias(LOGICAL, SERIAL);
    cacheProfilerPaths(PORT, PATHS, SERIAL);

    clearCachedProfilerPaths(PORT, LOGICAL);

    expect(getCachedProfilerPaths(PORT, SERIAL)).toBeUndefined();
  });

  it("keeps devices apart", () => {
    rememberDeviceAlias(LOGICAL, SERIAL);
    cacheProfilerPaths(PORT, PATHS, SERIAL);

    expect(getCachedProfilerPaths(PORT, "other-device")).toBeUndefined();
    expect(getCachedProfilerPaths(9090, LOGICAL)).toBeUndefined();
  });

  it("finds a session stored under the logicalDeviceId before the alias existed", () => {
    cacheProfilerPaths(PORT, PATHS, LOGICAL);
    rememberDeviceAlias(LOGICAL, SERIAL);

    expect(getCachedProfilerPaths(PORT, LOGICAL)).toBe(PATHS);
    expect(getCachedProfilerPaths(PORT, SERIAL)).toBe(PATHS);
  });

  it("returns the newest run when a restart stored it under the other id", () => {
    rememberDeviceAlias(LOGICAL, SERIAL);
    cacheProfilerPaths(PORT, OLDER, SERIAL);
    // A restart closes the connection, so the next run is stored without an alias.
    forgetDeviceAlias(LOGICAL);
    cacheProfilerPaths(PORT, NEWER, LOGICAL);

    expect(getCachedProfilerPaths(PORT, LOGICAL)).toBe(NEWER);

    // Connecting with the serial again brings the alias back.
    rememberDeviceAlias(LOGICAL, SERIAL);

    expect(getCachedProfilerPaths(PORT, LOGICAL)).toBe(NEWER);
    expect(getCachedProfilerPaths(PORT, SERIAL)).toBe(NEWER);
  });

  it("returns the newest run when the older one sits under the logicalDeviceId", () => {
    cacheProfilerPaths(PORT, OLDER, LOGICAL);
    rememberDeviceAlias(LOGICAL, SERIAL);
    cacheProfilerPaths(PORT, NEWER, SERIAL);

    expect(getCachedProfilerPaths(PORT, LOGICAL)).toBe(NEWER);
    expect(getCachedProfilerPaths(PORT, SERIAL)).toBe(NEWER);
  });
});

describe("the tools that take device_id as given", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "profiler-paths-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A stored run whose CPU profile lasts `durationMs`. */
  async function storedRun(durationMs: number, deviceId: string): Promise<void> {
    const cpuProfilePath = path.join(dir, `cpu-${durationMs}.json`);
    await fs.writeFile(
      cpuProfilePath,
      JSON.stringify({
        nodes: [
          {
            id: 1,
            callFrame: { functionName: "App", url: "", lineNumber: 1, columnNumber: 1 },
            children: [],
          },
        ],
        samples: [1],
        timeDeltas: [durationMs * 1000],
        startTime: 0,
        endTime: durationMs * 1000,
      })
    );
    cacheProfilerPaths(
      PORT,
      {
        sessionId: `run-${durationMs}`,
        debugDir: dir,
        cpuProfilePath,
        commitsPath: null,
        cpuSampleIndexPath: null,
        detectedArchitecture: null,
        anyCompilerOptimized: null,
        hotCommitIndices: null,
        totalReactCommits: null,
      },
      deviceId
    );
  }

  const cpuSummary = (deviceId: string) =>
    reactProfilerCpuSummaryTool.execute!(
      {},
      { port: PORT, device_id: deviceId, top_n: 5, react_only: false }
    ) as Promise<string>;

  const analyze = (deviceId: string) =>
    reactProfilerAnalyzeTool.execute!(
      {},
      {
        port: PORT,
        device_id: deviceId,
        project_root: dir,
        platform: "android",
        rn_version: "0.83.6",
      } as never,
      { artifacts: new ArtifactStore() } as never
    );

  /** The sessions analyze wrote a CPU index for, which it names after the run. */
  async function analyzedRuns(): Promise<string[]> {
    const names = await fs.readdir(dir);
    return names.flatMap((name) => /^react-profiler-(.+)_cpu-index\.json$/.exec(name)?.[1] ?? []);
  }

  it("read a run stored under the serial by its logicalDeviceId", async () => {
    rememberDeviceAlias(LOGICAL, SERIAL);
    await storedRun(4300, SERIAL);

    await expect(cpuSummary(LOGICAL)).resolves.toContain("**Duration:** 4300 ms");
    await expect(analyze(LOGICAL)).resolves.toBeDefined();
    expect(await analyzedRuns()).toEqual(["run-4300"]);
  });

  it("report the second run after a restart and a new connection with the serial", async () => {
    rememberDeviceAlias(LOGICAL, SERIAL);
    await storedRun(4300, SERIAL);
    forgetDeviceAlias(LOGICAL);
    await storedRun(900, LOGICAL);
    rememberDeviceAlias(LOGICAL, SERIAL);

    await expect(cpuSummary(LOGICAL)).resolves.toContain("**Duration:** 900 ms");
    await expect(analyze(LOGICAL)).resolves.toBeDefined();
    expect(await analyzedRuns()).toEqual(["run-900"]);
  });

  it("report no data for a device with no stored run", async () => {
    await expect(cpuSummary(LOGICAL)).rejects.toThrow("No CPU profile stored");
    await expect(analyze(LOGICAL)).rejects.toThrow("No profiling data stored");
  });
});
