import { z } from "zod";
import type { ToolDefinition } from "@radon-lite/registry";
import {
  PROFILER_SESSION_NAMESPACE,
  type ProfilerSessionApi,
  cacheProfilerData,
} from "../../blueprints/profiler-session";
import type { HermesCpuProfile, DevToolsFiberCommit } from "../../profiler/src/types/input";

const zodSchema = z.object({
  port: z.number().default(8081).describe("Metro server port"),
});

export const profilerStopTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  Record<string, unknown>
> = {
  id: "profiler-stop",
  description: `Stop CPU profiling and collect the cpuProfile + React commit tree.
Stores results in the ProfilerSession for later use by profiler-analyze or profiler-cpu-summary.
Call profiler-start first, then exercise the app, then call this.`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${PROFILER_SESSION_NAMESPACE}:${params.port}`,
  }),
  async execute(services) {
    const api = services.profilerSession as ProfilerSessionApi;
    const cdp = api.cdp;

    if (!api.profilingActive) {
      throw new Error("Profiling is not active. Call profiler-start first.");
    }

    const result = (await cdp.send("Profiler.stop")) as {
      profile?: HermesCpuProfile;
    };

    api.profilingActive = false;

    if (!result?.profile) {
      throw new Error("Profiler returned no profile data.");
    }

    const profile = result.profile;
    api.cpuProfile = profile;

    let commitCount = 0;
    let totalReactCommits = 0;
    let hookInstalled = false;
    const allCommits: DevToolsFiberCommit[] = [];

    // Step 1: Check hook status (small CDP call, non-fatal if hook absent)
    try {
      const hookStatus = await cdp.evaluate(
        `JSON.stringify({ installed: typeof globalThis.__RN_DEVTOOLS_MCP_COMMITS__ !== 'undefined', count: globalThis.__RN_DEVTOOLS_MCP_COMMITS__?.length ?? 0 })`
      ) as string | undefined;

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
      // Step 2: Fetch raw commits in chunks to avoid CDP message size limits.
      // Throws on any chunk failure to prevent partial / silent data loss.
      const CHUNK_SIZE = 500;
      const rawCommits: DevToolsFiberCommit[] = [];

      for (let start = 0; start < commitCount; start += CHUNK_SIZE) {
        const end = start + CHUNK_SIZE;
        const chunkResult = (await cdp.send("Runtime.evaluate", {
          expression: `JSON.stringify(globalThis.__RN_DEVTOOLS_MCP_COMMITS__.slice(${start}, ${end}))`,
          returnByValue: true,
          timeout: 30000,
        })) as { result?: { value?: string } };

        const chunkStr = chunkResult?.result?.value;
        if (!chunkStr) {
          throw new Error(`Failed to fetch commit chunk [${start}, ${end}): no value returned`);
        }
        for (const entry of JSON.parse(chunkStr) as DevToolsFiberCommit[]) {
          rawCommits.push(entry);
        }
      }

      // Step 3: All processing runs in Node.js (not inside the JS runtime).

      // 1a. Scan all commits for compiler detection
      let anyCompilerOptimized = false;
      for (const entry of rawCommits) {
        if (entry.isCompilerOptimized) { anyCompilerOptimized = true; break; }
      }

      // 1b. Fallback: scan live fiber tree for memoCache if not found in commits.
      // This catches compiler-optimized components whose per-fiber detection failed
      // (e.g. React 18 vs 19 memoCache path differences). Non-fatal.
      if (!anyCompilerOptimized) {
        try {
          const fallbackScript = `(function() {
            try {
              var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
              if (hook && hook.__rn_mcp_roots__) {
                var found = false;
                hook.__rn_mcp_roots__.forEach(function(root) {
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
          if (fallbackResult?.result?.value === 'true') anyCompilerOptimized = true;
        } catch {
          // non-fatal
        }
      }

      // 2. Compute heat per commitIndex (sum of selfDuration)
      const commitHeat = new Map<number, number>();
      for (const entry of rawCommits) {
        commitHeat.set(entry.commitIndex, (commitHeat.get(entry.commitIndex) ?? 0) + (entry.selfDuration ?? 0));
      }
      const allKeys = [...commitHeat.keys()];
      const totalCommits = allKeys.length;

      // 3. Absolute floor — only commits >= 16ms are "interesting"
      const ABSOLUTE_FLOOR_MS = 16;
      const interestingKeys = allKeys.filter(k => (commitHeat.get(k) ?? 0) >= ABSOLUTE_FLOOR_MS);

      api.anyCompilerOptimized = anyCompilerOptimized;
      api.totalReactCommits = totalCommits;
      totalReactCommits = totalCommits;

      if (interestingKeys.length === 0) {
        // 4. All-clear: nothing exceeds the floor — allCommits stays empty
        api.hotCommitIndices = [];
      } else {
        // 5-6. All interesting commits are "hot" (absolute floor already applied)
        const hotSet = new Set(interestingKeys);

        // 7. Add ±1 margin
        const marginSet = new Set<number>();
        for (const ci of interestingKeys) {
          if (commitHeat.has(ci - 1) && !hotSet.has(ci - 1)) marginSet.add(ci - 1);
          if (commitHeat.has(ci + 1) && !hotSet.has(ci + 1)) marginSet.add(ci + 1);
        }

        // 8. Filter to hot + margin set only
        for (const entry of rawCommits) {
          if (hotSet.has(entry.commitIndex) || marginSet.has(entry.commitIndex)) {
            allCommits.push(entry);
          }
        }
        api.hotCommitIndices = [...interestingKeys];
      }
    }

    api.commitTree = { commits: allCommits, hookNames: new Map() };

    cacheProfilerData(api.port, {
      cpuProfile: profile,
      commitTree: api.commitTree,
      detectedArchitecture: api.detectedArchitecture,
      anyCompilerOptimized: api.anyCompilerOptimized,
      hotCommitIndices: api.hotCommitIndices,
      totalReactCommits: api.totalReactCommits,
    });

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
        response["selection_note"] = `${hotCount} of ${totalReactCommits} commits at ≥16ms absolute floor`;
      }
    }

    return response;
  },
};
