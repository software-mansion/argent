import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  cacheProfilerPaths,
  clearCachedProfilerPaths,
  type ProfilerSessionPaths,
} from "../../src/blueprints/react-profiler-session";
import { profilerCpuQueryTool } from "../../src/tools/profiler/query/profiler-cpu-query";
import {
  buildCpuSampleIndex,
  serializeCpuSampleIndex,
} from "../../src/utils/react-profiler/pipeline/00-cpu-correlate";
import type { HermesCpuProfile } from "../../src/utils/react-profiler/types/input";

const DEVICE = "ios-sim";
const PORT = 8081;

const PROFILE = {
  nodes: [
    { id: 1, callFrame: { functionName: "(root)", url: "", lineNumber: -1 }, children: [2] },
    { id: 2, callFrame: { functionName: "work", url: "app.js", lineNumber: 10 }, children: [] },
  ],
  samples: [2, 2, 2],
  timeDeltas: [0, 1000, 1000],
  startTime: 0,
  endTime: 2000,
} as unknown as HermesCpuProfile;

let dir = "";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "argent-cpu-query-test-"));
});

afterEach(async () => {
  clearCachedProfilerPaths(PORT, DEVICE);
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Caches a session whose CPU sample index was already built by
 * react-profiler-analyze. The raw CPU profile path points nowhere, so any
 * attempt to rebuild the index from it fails with ENOENT.
 */
async function cacheSession(commitsContents: string): Promise<void> {
  const cpuSampleIndexPath = path.join(dir, "cpu-index.json");
  await fs.writeFile(
    cpuSampleIndexPath,
    JSON.stringify(serializeCpuSampleIndex(buildCpuSampleIndex(PROFILE)))
  );
  const commitsPath = path.join(dir, "commits.json");
  await fs.writeFile(commitsPath, commitsContents);

  const paths: ProfilerSessionPaths = {
    sessionId: "s",
    debugDir: dir,
    cpuProfilePath: path.join(dir, "missing-cpu-profile.json"),
    commitsPath,
    cpuSampleIndexPath,
    detectedArchitecture: null,
    anyCompilerOptimized: null,
    hotCommitIndices: null,
    totalReactCommits: null,
  };
  cacheProfilerPaths(PORT, paths, DEVICE);
}

function run(): Promise<string> {
  return profilerCpuQueryTool.execute(
    {} as never,
    {
      port: PORT,
      device_id: DEVICE,
      mode: "top_functions",
      top_n: 15,
      include_callers: false,
    } as never
  ) as Promise<string>;
}

describe("profiler-cpu-query with a cached CPU sample index", () => {
  it("uses the cached index without the raw CPU profile", async () => {
    await cacheSession(JSON.stringify({ commits: [] }));

    await expect(run()).resolves.toContain("work");
  });

  it("reports a corrupt commits file instead of rebuilding the index", async () => {
    await cacheSession('{"commits":[{"commitIndex":0');

    await expect(run()).rejects.toThrow("On-disk commit tree");
  });
});
