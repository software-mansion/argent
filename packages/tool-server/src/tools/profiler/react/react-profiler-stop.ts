import { z } from "zod";
import { ServiceState } from "@argent/registry";
import type { Registry, ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  type ProfilerSessionPaths,
  cacheProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import type {
  HermesCpuProfile,
  DevToolsFiberCommit,
  DevToolsChangeDescription,
} from "../../../utils/react-profiler/types/input";
import { getDebugDir, writeDumpCompact } from "../../../utils/react-profiler/debug/dump";
import {
  mergeProfilingData,
  type ProfilingDataBackend,
} from "./react-profiler-session-owner";
import {
  STOP_AND_READ_SCRIPT,
  RESOLVE_FIBER_META_SCRIPT,
} from "../../../utils/react-profiler/scripts";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z.string().describe("iOS Simulator UDID (logicalDeviceId)."),
});

interface StopReadResult {
  live: ProfilingDataBackend | null;
  prev: ProfilingDataBackend | null;
  displayNameById: Record<string, string | null>;
}

interface FiberMetaEntry {
  hookTypes: string[] | null;
  isCompilerOptimized: boolean;
  parentName: string | null;
}
type FiberMetaMap = Record<string, FiberMetaEntry>;

function normalizeChangeDescription(raw: unknown): DevToolsChangeDescription | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const props = Array.isArray(r.props) ? (r.props as string[]) : null;
  const state = typeof r.state === "boolean" ? (r.state as boolean) : null;
  const hooks = Array.isArray(r.hooks) ? (r.hooks as number[]) : null;
  const context = typeof r.context === "boolean" ? (r.context as boolean) : null;
  const didHooksChange = r.didHooksChange === true;
  const isFirstMount = r.isFirstMount === true;
  return { props, state, hooks, context, didHooksChange, isFirstMount };
}

/**
 * Flatten `ProfilingDataBackend` into the `DevToolsFiberCommit[]` shape the
 * downstream pipeline expects. `commitIndex` is assigned flatly across roots
 * so the map-key grouping in `buildHotCommitSummaries` works correctly.
 */
export function flattenProfilingData(
  merged: ProfilingDataBackend,
  displayNameById: Record<string, string | null>,
  fiberMeta: FiberMetaMap
): { commits: DevToolsFiberCommit[]; totalCommits: number } {
  const commits: DevToolsFiberCommit[] = [];
  let flatCommitIndex = 0;

  for (const root of merged.dataForRoots) {
    for (const c of root.commitData) {
      const actualMap = new Map<number, number>();
      for (const pair of c.fiberActualDurations ?? []) {
        if (Array.isArray(pair) && pair.length >= 2) actualMap.set(pair[0], pair[1]);
      }
      const selfMap = new Map<number, number>();
      for (const pair of c.fiberSelfDurations ?? []) {
        if (Array.isArray(pair) && pair.length >= 2) selfMap.set(pair[0], pair[1]);
      }
      const cdMap = new Map<number, unknown>();
      for (const pair of c.changeDescriptions ?? []) {
        if (Array.isArray(pair) && pair.length >= 2) cdMap.set(pair[0] as number, pair[1]);
      }

      const commitDuration = typeof c.duration === "number" ? c.duration : 0;

      for (const [fiberID, actualDuration] of actualMap) {
        const componentName = displayNameById[String(fiberID)] ?? null;
        if (!componentName) continue; // skip host / unnamed fibers
        const selfDuration = selfMap.get(fiberID) ?? 0;
        const cd = normalizeChangeDescription(cdMap.get(fiberID));
        const meta: FiberMetaEntry | undefined = fiberMeta[componentName];

        commits.push({
          commitIndex: flatCommitIndex,
          timestamp: c.timestamp,
          componentName,
          actualDuration,
          selfDuration,
          commitDuration,
          didRender: actualDuration > 0,
          changeDescription: cd,
          hookTypes: meta?.hookTypes ?? null,
          parentName: meta?.parentName ?? null,
          isCompilerOptimized: meta?.isCompilerOptimized === true,
        });
      }

      flatCommitIndex++;
    }
  }

  return { commits, totalCommits: flatCommitIndex };
}

export function createReactProfilerStopTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, Record<string, unknown>> {
  return {
    id: "react-profiler-stop",
    description: `Stop CPU profiling and collect the cpuProfile + React commit tree.
Reads commit data from the in-app React DevTools backend (ri.getProfilingData) — no per-commit JS work runs during capture. Wipe-protected via __ARGENT_PREV_PROFILE__.
Stores results in the ReactProfilerSession for later use by react-profiler-analyze or react-profiler-cpu-summary.
Call react-profiler-start first, then exercise the app, then call this.
Returns { duration_ms, sample_count, fiber_renders_captured, total_react_commits, hot_commit_indices, session_id } summarizing the session.
Fails if no active profiling session exists or the CDP connection was lost during recording.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const psUrn = `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}:${params.device_id}`;
      const snapshot = registry.getSnapshot();
      const entry = snapshot.services.get(psUrn);

      if (!entry || entry.state !== ServiceState.RUNNING) {
        throw new Error(
          "No active profiling session. The session may have been lost due to a Metro reload. " +
            "Call react-profiler-start to begin a new session."
        );
      }

      const api = await registry.resolveService<ReactProfilerSessionApi>(psUrn);
      const cdp = api.cdp;

      if (!api.cdp.isConnected()) {
        api.profilingActive = false;
        throw new Error(
          "CDP connection lost — profiling data could not be collected. " +
            "Call react-profiler-start to begin a new session."
        );
      }

      api.profilingActive = false; // reset BEFORE the CDP call so state is clean even if it throws

      const cpuResult = (await cdp.send("Profiler.stop")) as {
        profile?: HermesCpuProfile;
      };
      if (!cpuResult?.profile) {
        throw new Error("Profiler returned no profile data.");
      }
      const profile = cpuResult.profile;

      // Single evaluate: stop the backend profiler, read live + prev buffers, and
      // resolve every referenced fiberID to a displayName in one round-trip.
      const stopReadStr = (await cdp.send("Runtime.evaluate", {
        expression: STOP_AND_READ_SCRIPT,
        returnByValue: true,
        timeout: 60000,
      })) as { result?: { value?: string }; exceptionDetails?: { text?: string } };
      if (stopReadStr.exceptionDetails) {
        throw new Error(
          `Runtime exception while reading profiling data: ${stopReadStr.exceptionDetails.text ?? "unknown"}`
        );
      }
      const stopReadRaw = stopReadStr.result?.value;
      if (!stopReadRaw) {
        throw new Error("No profiling data returned from runtime.");
      }
      const stopRead = JSON.parse(stopReadRaw) as StopReadResult;

      // live > PREV: if both cover the same rootID, live wins and PREV is
      // dropped — so if we're here after a takeover of an abandoned session,
      // a PREV snapshot for the same rootID (which included the abandoned
      // commits) will be discarded in favour of our own new session.
      const merged = mergeProfilingData(stopRead.live, stopRead.prev);
      const backendCommitCount = merged.dataForRoots.reduce(
        (a, r) => a + (r.commitData?.length ?? 0),
        0
      );

      let fiberMeta: FiberMetaMap = {};
      if (backendCommitCount > 0) {
        try {
          const metaStr = (await cdp.send("Runtime.evaluate", {
            expression: RESOLVE_FIBER_META_SCRIPT,
            returnByValue: true,
            timeout: 15000,
          })) as { result?: { value?: string } };
          if (metaStr.result?.value) {
            fiberMeta = JSON.parse(metaStr.result.value) as FiberMetaMap;
          }
        } catch {
          // non-fatal — hookTypes / parentName / isCompilerOptimized fall back to defaults
        }
      }

      const { commits: allCommits, totalCommits } = flattenProfilingData(
        merged,
        stopRead.displayNameById,
        fiberMeta
      );

      const commitHeat = new Map<number, number>();
      let anyCompilerOptimized = false;
      for (const c of allCommits) {
        const prev = commitHeat.get(c.commitIndex) ?? 0;
        if (c.commitDuration > prev) commitHeat.set(c.commitIndex, c.commitDuration);
        if (c.isCompilerOptimized) anyCompilerOptimized = true;
      }

      const ABSOLUTE_FLOOR_MS = 16;
      const interestingKeys = [...commitHeat.keys()].filter(
        (k) => (commitHeat.get(k) ?? 0) >= ABSOLUTE_FLOOR_MS
      );

      const hotSet = new Set(interestingKeys);
      const marginSet = new Set<number>();
      for (const ci of interestingKeys) {
        if (commitHeat.has(ci - 1) && !hotSet.has(ci - 1)) marginSet.add(ci - 1);
        if (commitHeat.has(ci + 1) && !hotSet.has(ci + 1)) marginSet.add(ci + 1);
      }
      const keepSet = new Set([...hotSet, ...marginSet]);

      const filteredCommits: DevToolsFiberCommit[] =
        interestingKeys.length === 0 ? [] : allCommits.filter((c) => keepSet.has(c.commitIndex));

      api.anyCompilerOptimized = anyCompilerOptimized;
      api.totalReactCommits = totalCommits;
      api.hotCommitIndices = interestingKeys;

      const commitTree = { commits: filteredCommits, hookNames: new Map() };

      const sessionTs = new Date()
        .toISOString()
        .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
        .slice(0, 15);

      const debugDir = await getDebugDir();

      const cpuProfilePath = await writeDumpCompact(
        debugDir,
        `react-profiler-${sessionTs}_cpu.json`,
        profile
      );
      const commitsPath = await writeDumpCompact(
        debugDir,
        `react-profiler-${sessionTs}_commits.json`,
        {
          commits: commitTree.commits,
          meta: {
            detectedArchitecture: api.detectedArchitecture,
            anyCompilerOptimized: api.anyCompilerOptimized,
            hotCommitIndices: api.hotCommitIndices,
            totalReactCommits: api.totalReactCommits,
            profileStartWallMs: api.profileStartWallMs,
            projectRoot: api.projectRoot,
            deviceId: api.deviceId,
            port: api.port,
            appName: api.appName,
            deviceName: api.deviceName,
          },
        }
      );

      const sessionPaths: ProfilerSessionPaths = {
        sessionId: sessionTs,
        debugDir,
        cpuProfilePath,
        commitsPath,
        cpuSampleIndexPath: null,
        detectedArchitecture: api.detectedArchitecture,
        anyCompilerOptimized: api.anyCompilerOptimized,
        hotCommitIndices: api.hotCommitIndices,
        totalReactCommits: api.totalReactCommits,
      };

      cacheProfilerPaths(api.port, sessionPaths, api.deviceId);
      api.sessionPaths = sessionPaths;
      const reactSessionId = api.sessionId;
      api.sessionId = null;
      api.ownerToolServerPid = null;
      api.disposeSession();

      const duration_ms = (profile.endTime - profile.startTime) / 1000;

      const response: Record<string, unknown> = {
        duration_ms,
        sample_count: profile.samples.length,
        fiber_renders_captured: allCommits.length,
        hook_installed: true,
        session_id: reactSessionId,
      };
      if (totalCommits > 0) {
        response["total_react_commits"] = totalCommits;
        response["hot_commit_indices"] = api.hotCommitIndices ?? [];
        response["any_compiler_optimized"] = api.anyCompilerOptimized ?? false;
        response["fiber_renders_analyzed"] = filteredCommits.length;
        const hotCount = api.hotCommitIndices?.length ?? 0;
        if (hotCount === 0) {
          response["selection_note"] = "All commits below 16ms — app appears smooth (all-clear)";
        } else if (hotCount < totalCommits) {
          response["selection_note"] =
            `${hotCount} of ${totalCommits} commits at ≥16ms absolute floor`;
        }
      }

      return response;
    },
  };
}
