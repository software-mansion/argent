import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  type ProfilerSessionPaths,
  getCachedProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import {
  buildCpuSampleIndex,
  queryCpuWindow,
  deserializeCpuSampleIndex,
  isArgentProfilerFunction,
  type CpuSampleIndex,
} from "../../../utils/react-profiler/pipeline/00-cpu-correlate";
import type { HermesProfileNode } from "../../../utils/react-profiler/types/input";
import { readCpuProfile, readCommitTree } from "../../../utils/react-profiler/debug/dump";
import { promises as fs } from "fs";

const timeWindowSchema = z.object({
  start: z.coerce.number().describe("Start of window in ms (performance.now clock)"),
  end: z.coerce.number().describe("End of window in ms (performance.now clock)"),
});

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  mode: z
    .enum(["top_functions", "time_window", "call_tree", "component_cpu"])
    .describe(
      "Query mode: top_functions (global hotspots), time_window (CPU in a time range), " +
        "call_tree (callers/callees of a function), component_cpu (CPU during a component's commits)"
    ),
  time_window_ms: timeWindowSchema
    .optional()
    .describe("Time window filter for time_window mode (ms, performance.now clock)"),
  component_name: z.string().optional().describe("Component name for component_cpu mode"),
  function_name: z.string().optional().describe("Function name for call_tree mode"),
  top_n: z.coerce
    .number()
    .int()
    .positive()
    .default(15)
    .describe("Number of results to return (default 15)"),
  include_callers: z
    .boolean()
    .default(false)
    .describe("For call_tree mode: also show callers of the function"),
});

async function getIndex(api: ReactProfilerSessionApi): Promise<{
  index: CpuSampleIndex;
  commitTree: {
    commits: {
      commitIndex: number;
      timestamp: number;
      commitDuration: number;
      componentName: string;
    }[];
  } | null;
}> {
  const sessionPaths: ProfilerSessionPaths | undefined =
    api.sessionPaths ?? getCachedProfilerPaths(api.port) ?? undefined;

  if (!sessionPaths?.cpuProfilePath) {
    throw new Error(
      "No CPU profile stored. Run react-profiler-start → exercise the app → react-profiler-stop → react-profiler-analyze first."
    );
  }

  // Fast path: use pre-built index from analyze if available
  if (sessionPaths.cpuSampleIndexPath) {
    try {
      const raw = JSON.parse(await fs.readFile(sessionPaths.cpuSampleIndexPath, "utf8"));
      const index = deserializeCpuSampleIndex(raw);
      let commitTree = null;
      if (sessionPaths.commitsPath) {
        const onDisk = await readCommitTree(sessionPaths.commitsPath);
        commitTree = { commits: onDisk.commits };
      }
      return { index, commitTree };
    } catch {
      // Fall through to building from raw profile
    }
  }

  // Slow path: build index from raw CPU profile
  const cpuProfile = await readCpuProfile(sessionPaths.cpuProfilePath);
  let commitTree = null;
  let firstCommitTs: number | null = null;
  if (sessionPaths.commitsPath) {
    const onDisk = await readCommitTree(sessionPaths.commitsPath);
    commitTree = { commits: onDisk.commits };
    firstCommitTs = onDisk.commits[0]?.timestamp ?? null;
  }

  return { index: buildCpuSampleIndex(cpuProfile, firstCommitTs), commitTree };
}

function renderTopFunctions(
  index: CpuSampleIndex,
  topN: number,
  startMs?: number,
  endMs?: number
): string {
  const windowStart = startMs ?? index.timestampsMs[0]!;
  const windowEnd = endMs ?? index.timestampsMs[index.timestampsMs.length - 1]!;
  const hotspots = queryCpuWindow(index, windowStart, windowEnd, topN);

  if (hotspots.length === 0) return "_No CPU hotspots found in the specified range._";

  const header = "| Function | Self (ms) | Total (ms) | Location |";
  const sep = "|---|---|---|---|";
  const rows = hotspots.map((hs) => {
    const loc = hs.url
      ? `${shortenUrl(hs.url)}${hs.lineNumber != null ? `:${hs.lineNumber}` : ""}`
      : "—";
    return `| \`${hs.name}\` | ${hs.selfMs} | ${hs.totalMs} | ${loc} |`;
  });

  const rangeNote =
    startMs != null ? `**Window:** ${startMs.toFixed(1)}ms → ${endMs!.toFixed(1)}ms\n\n` : "";

  return `## CPU Hotspots\n\n${rangeNote}${header}\n${sep}\n${rows.join("\n")}`;
}

function renderCallTree(
  index: CpuSampleIndex,
  functionName: string,
  topN: number,
  includeCallers: boolean
): string {
  const { nodeMap, sampleNodeIds, timestampsMs } = index;

  // Find all nodes matching the function name
  const matchingNodeIds: number[] = [];
  for (const [id, node] of nodeMap) {
    if (node.callFrame.functionName === functionName) {
      matchingNodeIds.push(id);
    }
  }

  if (matchingNodeIds.length === 0) {
    return `_Function \`${functionName}\` not found in the CPU profile._`;
  }

  const matchingSet = new Set(matchingNodeIds);

  // Count self hits
  let selfHits = 0;
  for (const nodeId of sampleNodeIds) {
    if (matchingSet.has(nodeId)) selfHits++;
  }

  const totalSamples = sampleNodeIds.length;
  const durationMs = timestampsMs[timestampsMs.length - 1]! - timestampsMs[0]! || 1;
  const avgIntervalMs = durationMs / totalSamples;
  const selfMs = Math.round(selfHits * avgIntervalMs * 100) / 100;

  const lines: string[] = [
    `## Call Tree for \`${functionName}\``,
    "",
    `**Self time:** ${selfMs}ms (${totalSamples > 0 ? ((selfHits / totalSamples) * 100).toFixed(1) : "0"}%)`,
    "",
  ];

  // Find callees: children of matching nodes
  const calleeHits = new Map<string, { hits: number; node: HermesProfileNode }>();
  for (const nodeId of matchingNodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node?.children) continue;
    for (const childId of node.children) {
      const child = nodeMap.get(childId);
      if (!child) continue;
      const name = child.callFrame.functionName;
      if (!name || name === "(idle)") continue;
      if (isArgentProfilerFunction(name)) continue;
      const existing = calleeHits.get(name);
      if (existing) {
        existing.hits += child.hitCount || 0;
      } else {
        calleeHits.set(name, { hits: child.hitCount || 0, node: child });
      }
    }
  }

  if (calleeHits.size > 0) {
    lines.push("### Callees (functions called by this function)");
    lines.push("");
    lines.push("| Function | Hits | Location |");
    lines.push("|---|---|---|");
    const sorted = [...calleeHits.entries()].sort((a, b) => b[1].hits - a[1].hits).slice(0, topN);
    for (const [name, { hits, node }] of sorted) {
      const loc = node.callFrame.url
        ? `${shortenUrl(node.callFrame.url)}:${node.callFrame.lineNumber}`
        : "—";
      lines.push(`| \`${name}\` | ${hits} | ${loc} |`);
    }
    lines.push("");
  }

  if (includeCallers) {
    // Build parent map
    const childToParent = new Map<number, number>();
    for (const node of nodeMap.values()) {
      for (const childId of node.children ?? []) {
        childToParent.set(childId, node.id);
      }
    }

    const callerHits = new Map<string, { hits: number; node: HermesProfileNode }>();
    for (const nodeId of matchingNodeIds) {
      const parentId = childToParent.get(nodeId);
      if (parentId == null) continue;
      const parent = nodeMap.get(parentId);
      if (!parent) continue;
      const name = parent.callFrame.functionName;
      if (!name || name === "(root)") continue;
      if (isArgentProfilerFunction(name)) continue;
      const existing = callerHits.get(name);
      if (existing) {
        existing.hits += parent.hitCount || 0;
      } else {
        callerHits.set(name, { hits: parent.hitCount || 0, node: parent });
      }
    }

    if (callerHits.size > 0) {
      lines.push("### Callers (functions that call this function)");
      lines.push("");
      lines.push("| Function | Hits | Location |");
      lines.push("|---|---|---|");
      const sorted = [...callerHits.entries()].sort((a, b) => b[1].hits - a[1].hits).slice(0, topN);
      for (const [name, { hits, node }] of sorted) {
        const loc = node.callFrame.url
          ? `${shortenUrl(node.callFrame.url)}:${node.callFrame.lineNumber}`
          : "—";
        lines.push(`| \`${name}\` | ${hits} | ${loc} |`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderComponentCpu(
  index: CpuSampleIndex,
  commitTree: {
    commits: {
      commitIndex: number;
      timestamp: number;
      commitDuration: number;
      componentName: string;
    }[];
  } | null,
  componentName: string,
  topN: number
): string {
  if (!commitTree || commitTree.commits.length === 0) {
    return "_No commit data available. Run react-profiler-analyze first._";
  }

  // Find all commits where this component rendered
  const componentCommits = commitTree.commits.filter((c) => c.componentName === componentName);

  if (componentCommits.length === 0) {
    return `_Component \`${componentName}\` not found in commit data._`;
  }

  // Group by commitIndex to get unique commit windows
  const commitWindows = new Map<number, { start: number; end: number; duration: number }>();
  for (const c of componentCommits) {
    if (!commitWindows.has(c.commitIndex)) {
      commitWindows.set(c.commitIndex, {
        start: c.timestamp,
        end: c.timestamp + c.commitDuration,
        duration: c.commitDuration,
      });
    }
  }

  // Aggregate CPU across all commit windows
  const aggregated = new Map<
    string,
    { selfMs: number; totalMs: number; url?: string; lineNumber?: number }
  >();

  for (const window of commitWindows.values()) {
    const hotspots = queryCpuWindow(index, window.start, window.end, 50);
    for (const hs of hotspots) {
      const existing = aggregated.get(hs.name);
      if (existing) {
        existing.selfMs += hs.selfMs;
        existing.totalMs += hs.totalMs;
      } else {
        aggregated.set(hs.name, {
          selfMs: hs.selfMs,
          totalMs: hs.totalMs,
          url: hs.url,
          lineNumber: hs.lineNumber,
        });
      }
    }
  }

  const sorted = [...aggregated.entries()].sort((a, b) => b[1].selfMs - a[1].selfMs).slice(0, topN);

  if (sorted.length === 0) {
    return `_No CPU samples found during \`${componentName}\` commits._`;
  }

  const totalCommitMs = [...commitWindows.values()].reduce((sum, w) => sum + w.duration, 0);

  const lines: string[] = [
    `## CPU During \`${componentName}\` Commits`,
    "",
    `**Commits:** ${commitWindows.size}  **Total commit time:** ${totalCommitMs.toFixed(1)}ms`,
    "",
    "| Function | Self (ms) | Total (ms) | Location |",
    "|---|---|---|---|",
  ];

  for (const [name, { selfMs, totalMs, url, lineNumber }] of sorted) {
    const loc = url ? `${shortenUrl(url)}${lineNumber != null ? `:${lineNumber}` : ""}` : "—";
    lines.push(
      `| \`${name}\` | ${Math.round(selfMs * 100) / 100} | ${Math.round(totalMs * 100) / 100} | ${loc} |`
    );
  }

  return lines.join("\n");
}

function shortenUrl(url: string): string {
  const parts = url.replace(/\\/g, "/").split("/");
  return parts.slice(-2).join("/");
}

export const profilerCpuQueryTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "profiler-cpu-query",
  description: `Query Hermes CPU profile data with targeted modes for iterative investigation.
Requires react-profiler-stop (and ideally react-profiler-analyze) to have been called first.
Modes:
- top_functions: Global CPU hotspots ranked by self-time. Optional time_window_ms to filter.
- time_window: CPU breakdown for a specific time range (e.g. during a slow commit or hang).
- call_tree: For a given function_name, show its callees and optionally callers.
- component_cpu: For a given component_name, aggregate CPU activity across all its commits.
Use when investigating JS CPU hotspots or correlating CPU cost with specific components.
Returns a markdown table of CPU hotspots, call tree, or per-component CPU breakdown.
Fails if no CPU profile is stored — run react-profiler-stop first.`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.profilerSession as ReactProfilerSessionApi;
    const { index, commitTree } = await getIndex(api);

    switch (params.mode) {
      case "top_functions":
        return renderTopFunctions(
          index,
          params.top_n,
          params.time_window_ms?.start,
          params.time_window_ms?.end
        );

      case "time_window": {
        if (!params.time_window_ms) {
          throw new Error("time_window mode requires the time_window_ms parameter.");
        }
        return renderTopFunctions(
          index,
          params.top_n,
          params.time_window_ms.start,
          params.time_window_ms.end
        );
      }

      case "call_tree": {
        if (!params.function_name) {
          throw new Error("call_tree mode requires the function_name parameter.");
        }
        return renderCallTree(index, params.function_name, params.top_n, params.include_callers);
      }

      case "component_cpu": {
        if (!params.component_name) {
          throw new Error("component_cpu mode requires the component_name parameter.");
        }
        return renderComponentCpu(index, commitTree, params.component_name, params.top_n);
      }

      default:
        throw new Error(`Unknown mode: ${params.mode}`);
    }
  },
};
