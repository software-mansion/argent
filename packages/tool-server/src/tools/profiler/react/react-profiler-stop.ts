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
} from "../../../utils/react-profiler/types/input";
import { getDebugDir, writeDumpCompact } from "../../../utils/react-profiler/debug/dump";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: z
    .string()
    .optional()
    .describe(
      "iOS Simulator UDID (logicalDeviceId). Must match the value passed to react-profiler-start."
    ),
});

export function createReactProfilerStopTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, Record<string, unknown>> {
  return {
    id: "react-profiler-stop",
    description: `Stop CPU profiling and collect the cpuProfile + React commit tree.
Stores results in the ReactProfilerSession for later use by react-profiler-analyze or react-profiler-cpu-summary.
Call react-profiler-start first, then exercise the app, then call this.
Use when the user has finished the interaction to profile and you need to end the recording.
Returns { duration_ms, sample_count, fiber_renders_captured, hot_commit_indices } summarizing the session.
Fails if no active profiling session exists or the CDP connection was lost during recording.`,
    zodSchema,
    services: () => ({}),
    async execute(_services, params) {
      const deviceSuffix = params.device_id ? `:${params.device_id}` : "";
      const psUrn = `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}${deviceSuffix}`;
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

      api.profilingActive = false; // Reset BEFORE the CDP call so state is clean even if it throws

      const result = (await cdp.send("Profiler.stop")) as {
        profile?: HermesCpuProfile;
      };

      if (!result?.profile) {
        throw new Error("Profiler returned no profile data.");
      }

      const profile = result.profile;

      let commitCount = 0;
      let totalReactCommits = 0;
      let hookInstalled = false;
      const allCommits: DevToolsFiberCommit[] = [];

      // Step 1: Check hook status (small CDP call, non-fatal if hook absent)
      try {
        const hookStatus = (await cdp.evaluate(
          `JSON.stringify({ installed: typeof globalThis.__ARGENT_DEVTOOLS_COMMITS__ !== 'undefined', count: globalThis.__ARGENT_DEVTOOLS_COMMITS__?.length ?? 0 })`
        )) as string | undefined;

        if (hookStatus) {
          const status = JSON.parse(hookStatus) as {
            installed: boolean;
            count: number;
          };
          hookInstalled = status.installed;
          commitCount = status.count;
        }
      } catch {
        // non-fatal — React commit hook may not be installed
      }

      if (hookInstalled && commitCount === 0) {
        // Hook was installed but no commits captured — set empty (not null)
        // so downstream code distinguishes "installed, 0 commits" from "not installed"
        api.hotCommitIndices = [];
        api.totalReactCommits = 0;
        api.anyCompilerOptimized = false;
      } else if (hookInstalled && commitCount > 0) {
        // === Pass 1: Compute heat map + compiler flag on-device ===
        // A single lightweight CDP call iterates all commits in-place and returns
        // only aggregated data (~50KB), avoiding transfer of the full dataset.
        const heatScript = `(function() {
        var commits = globalThis.__ARGENT_DEVTOOLS_COMMITS__;
        var heat = {};
        var compiler = false;
        for (var i = 0; i < commits.length; i++) {
          var c = commits[i];
          var cd = c.commitDuration || 0;
          if (!(c.commitIndex in heat) || cd > heat[c.commitIndex]) {
            heat[c.commitIndex] = cd;
          }
          if (c.isCompilerOptimized) compiler = true;
        }
        return JSON.stringify({ heat: heat, anyCompilerOptimized: compiler });
      })()`;

        const heatResult = (await cdp.send("Runtime.evaluate", {
          expression: heatScript,
          returnByValue: true,
          timeout: 30000,
        })) as { result?: { value?: string } };

        const heatStr = heatResult?.result?.value;
        if (!heatStr) {
          throw new Error("Failed to compute heat map on device: no value returned");
        }

        const { heat, anyCompilerOptimized: compilerFromHeat } = JSON.parse(heatStr) as {
          heat: Record<string, number>;
          anyCompilerOptimized: boolean;
        };

        let anyCompilerOptimized = compilerFromHeat;

        // Fallback: scan live fiber tree for memoCache if not found in commits.
        // This catches compiler-optimized components whose per-fiber detection failed
        // (e.g. React 18 vs 19 memoCache path differences). Non-fatal.
        if (!anyCompilerOptimized) {
          try {
            const fallbackScript = `(function() {
            try {
              var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
              if (hook && hook.__argent_roots__) {
                var found = false;
                hook.__argent_roots__.forEach(function(root) {
                  if (found) return;
                  try {
                    var fstack = root.current ? [root.current] : [];
                    while (fstack.length > 0) {
                      var f = fstack.pop();
                      if (!f) continue;
                      if ((f.updateQueue && f.updateQueue.memoCache != null) ||
                          (f.alternate && f.alternate.updateQueue && f.alternate.updateQueue.memoCache != null)) {
                        found = true; break;
                      }
                      if (f.child) fstack.push(f.child);
                      if (f.sibling) fstack.push(f.sibling);
                    }
                  } catch(e) {}
                });
                return String(found);
              }
            } catch(e) {}
            return 'false';
          })()`;
            const fallbackResult = (await cdp.send("Runtime.evaluate", {
              expression: fallbackScript,
              returnByValue: true,
              timeout: 10000,
            })) as { result?: { value?: string } };
            if (fallbackResult?.result?.value === "true") anyCompilerOptimized = true;
          } catch {
            // non-fatal
          }
        }

        // Build commitHeat map from on-device result
        const commitHeat = new Map<number, number>();
        for (const [key, value] of Object.entries(heat)) {
          commitHeat.set(Number(key), value);
        }
        const allKeys = [...commitHeat.keys()];
        const totalCommits = allKeys.length;

        // Absolute floor — only commits >= 16ms are "interesting"
        const ABSOLUTE_FLOOR_MS = 16;
        const interestingKeys = allKeys.filter(
          (k) => (commitHeat.get(k) ?? 0) >= ABSOLUTE_FLOOR_MS
        );

        api.anyCompilerOptimized = anyCompilerOptimized;
        api.totalReactCommits = totalCommits;
        totalReactCommits = totalCommits;

        if (interestingKeys.length === 0) {
          // All-clear: nothing exceeds the floor — skip Pass 2 entirely
          api.hotCommitIndices = [];
        } else {
          // Compute hot + ±1 margin sets
          const hotSet = new Set(interestingKeys);
          const marginSet = new Set<number>();
          for (const ci of interestingKeys) {
            if (commitHeat.has(ci - 1) && !hotSet.has(ci - 1)) marginSet.add(ci - 1);
            if (commitHeat.has(ci + 1) && !hotSet.has(ci + 1)) marginSet.add(ci + 1);
          }
          const keepSet = new Set([...hotSet, ...marginSet]);

          // === Pass 2: Chunked filtered fetch (only hot+margin commits) ===
          // Each chunk is parsed and filtered immediately; only matching entries
          // are retained, so peak memory is O(CHUNK_SIZE + filtered_commits).
          const CHUNK_SIZE = 500;
          for (let start = 0; start < commitCount; start += CHUNK_SIZE) {
            const end = start + CHUNK_SIZE;
            const chunkResult = (await cdp.send("Runtime.evaluate", {
              expression: `JSON.stringify(globalThis.__ARGENT_DEVTOOLS_COMMITS__.slice(${start}, ${end}))`,
              returnByValue: true,
              timeout: 30000,
            })) as { result?: { value?: string } };

            const chunkStr = chunkResult?.result?.value;
            if (!chunkStr) {
              throw new Error(`Failed to fetch commit chunk [${start}, ${end}): no value returned`);
            }
            for (const entry of JSON.parse(chunkStr) as DevToolsFiberCommit[]) {
              if (keepSet.has(entry.commitIndex)) {
                allCommits.push(entry);
              }
            }
          }
          api.hotCommitIndices = [...interestingKeys];
        }
      }

      const commitTree = { commits: allCommits, hookNames: new Map() };

      // Write raw data to disk immediately — no in-memory retention
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
            // Provenance fields — used by profiler-load to display session origin
            projectRoot: api.projectRoot,
            deviceId: api.deviceId,
            port: api.port,
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
        deviceId: api.deviceId,
        deviceName: null,
        appName: null,
        projectRoot: api.projectRoot,
      };

      cacheProfilerPaths(api.port, sessionPaths, api.deviceId ?? undefined);
      api.sessionPaths = sessionPaths;
      api.disposeSession();

      const duration_ms = (profile.endTime - profile.startTime) / 1000;

      const response: Record<string, unknown> = {
        duration_ms,
        sample_count: profile.samples.length,
        fiber_renders_captured: commitCount,
        hook_installed: hookInstalled,
      };
      if (totalReactCommits > 0) {
        response["total_react_commits"] = totalReactCommits;
        response["hot_commit_indices"] = api.hotCommitIndices ?? [];
        response["any_compiler_optimized"] = api.anyCompilerOptimized ?? false;
        response["fiber_renders_analyzed"] = allCommits.length;
        const hotCount = api.hotCommitIndices?.length ?? 0;
        if (hotCount === 0) {
          response["selection_note"] = "All commits below 16ms — app appears smooth (all-clear)";
        } else if (hotCount < totalReactCommits) {
          response["selection_note"] =
            `${hotCount} of ${totalReactCommits} commits at ≥16ms absolute floor`;
        }
      }

      return response;
    },
  };
}
