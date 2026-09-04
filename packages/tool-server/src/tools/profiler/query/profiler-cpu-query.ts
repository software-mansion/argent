import { z } from "zod";
import { FAILURE_CODES, FailureError, type ToolDefinition } from "@argent/registry";
import { RN_ONLY_TOOL_CAPABILITY } from "../../debugger/debugger-service-ref";
import {
  type ProfilerSessionPaths,
  getCachedProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import {
  buildCpuSampleIndex,
  buildChildToParent,
  queryCpuWindow,
  deserializeCpuSampleIndex,
  isArgentProfilerFunction,
  type CpuSampleIndex,
} from "../../../utils/react-profiler/pipeline/00-cpu-correlate";
import type { CpuWindowResult } from "../../../utils/react-profiler/pipeline/00-cpu-correlate";
import type { HermesProfileNode } from "../../../utils/react-profiler/types/input";
import { readCpuProfile, readCommitTree } from "../../../utils/react-profiler/debug/dump";
import {
  resolveComponentName,
  renderComponentNameMiss,
  describeResolution,
} from "../../../utils/react-profiler/component-names";
import { promises as fs } from "fs";
import { metroDeviceIdParam } from "../../../utils/debugger/device-id-param";

const timeWindowSchema = z.object({
  start: z.coerce
    .number()
    .describe(
      "Start of window in ms since profiling started — the same clock profiler-commit-query prints"
    ),
  end: z.coerce
    .number()
    .describe(
      "End of window in ms since profiling started — the same clock profiler-commit-query prints"
    ),
});

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  device_id: metroDeviceIdParam(
    "Device logicalDeviceId from debugger-connect (iOS simulator UDID or Android logicalDeviceId)."
  ),
  mode: z
    .enum(["top_functions", "time_window", "call_tree", "component_cpu"])
    .describe(
      "Query mode: top_functions (global hotspots), time_window (CPU in a time range), " +
        "call_tree (callers/callees of a function), component_cpu (CPU during a component's commits)"
    ),
  time_window_ms: timeWindowSchema
    .optional()
    .describe(
      "Time window filter for time_window mode (ms since profiling started — the same clock profiler-commit-query prints)"
    ),
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

async function getIndex(sessionPaths: ProfilerSessionPaths): Promise<{
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
  if (!sessionPaths?.cpuProfilePath) {
    throw new FailureError(
      "No CPU profile stored. Run react-profiler-start → exercise the app → react-profiler-stop → react-profiler-analyze first.",
      {
        error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
        failure_stage: "profiler_cpu_query_load_data",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  // Fast path: index already built by react-profiler-analyze.
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
      // Fall through to building from the raw profile.
    }
  }

  const cpuProfile = await readCpuProfile(sessionPaths.cpuProfilePath);
  let commitTree = null;
  if (sessionPaths.commitsPath) {
    const onDisk = await readCommitTree(sessionPaths.commitsPath);
    commitTree = { commits: onDisk.commits };
  }

  return { index: buildCpuSampleIndex(cpuProfile), commitTree };
}

/**
 * Explain a window that produced no ranked functions: a coverage gap, an empty
 * capture and a covered-but-idle window each mean something different and need
 * a different next step, so a bare "no hotspots" was a dead end (#619).
 */
function explainEmptyWindow(res: CpuWindowResult, startMs: number, endMs: number): string {
  const range = `${res.sampleRangeMs.start.toFixed(1)}–${res.sampleRangeMs.end.toFixed(1)}ms`;
  const window = `${startMs.toFixed(1)}–${endMs.toFixed(1)}ms`;

  if (res.sampleRangeMs.end === 0 && res.samplesInWindow === 0) {
    return (
      "_The CPU profile contains no samples. Sampling produced no data for this session — " +
      "that is a capture failure, not a measurement of idleness._"
    );
  }

  if (endMs < res.sampleRangeMs.start || startMs > res.sampleRangeMs.end) {
    return (
      `_No CPU samples exist in ${window} — that is outside the recorded sample range ` +
      `(${range}). This is a coverage gap, not a measurement: nothing can be concluded about CPU ` +
      `cost here. Sample times are ms since profiling started, the same clock ` +
      "`profiler-commit-query` prints._"
    );
  }

  if (res.samplesInWindow > 0) {
    return (
      `_${res.samplesInWindow} sample(s) covering ${res.coveredMs.toFixed(1)}ms fell inside ` +
      `${window}, and all of them were idle — the JS thread was not executing during this window. ` +
      "Native or UI-thread work would not appear here; use `native-profiler-start` for that._"
    );
  }

  return (
    `_No CPU samples fell inside ${window} (${(endMs - startMs).toFixed(1)}ms wide), although it ` +
    `lies within the recorded range (${range}). The sampler runs roughly every ` +
    `${res.medianIntervalMs > 0 ? res.medianIntervalMs.toFixed(1) : "13"}ms, so a window this ` +
    "narrow can contain none at all. **Absence of samples is not evidence that this commit was " +
    "cheap.** Widen the window, or use `mode=component_cpu`._"
  );
}

/** States what the numbers below are a measurement of. */
function coverageNote(res: CpuWindowResult, startMs: number, endMs: number): string {
  const widthMs = endMs - startMs;
  const lines = [
    `**Window:** ${startMs.toFixed(1)}ms → ${endMs.toFixed(1)}ms (${widthMs.toFixed(1)}ms)`,
    `**Samples:** ${res.samplesInWindow} covering ${res.coveredMs.toFixed(1)}ms` +
      (res.idleMs > 0 ? `, of which ${res.idleMs.toFixed(1)}ms idle` : "") +
      ` — sampling interval ~${res.medianIntervalMs.toFixed(1)}ms. Self-times sum to sampled` +
      " coverage, not to the window width.",
  ];
  if (widthMs > 0 && widthMs < 3 * res.medianIntervalMs) {
    lines.push(
      `> This window is narrower than ~3 sampling intervals, so every figure carries ±1 sample` +
        ` (≈${res.medianIntervalMs.toFixed(1)}ms).`
    );
  }
  if (res.maxIntervalMs > 50 && res.maxIntervalMs > 5 * res.medianIntervalMs) {
    lines.push(
      `> The sampler stalled for ${res.maxIntervalMs.toFixed(1)}ms inside this window; that whole` +
        " gap is attributed to whichever function was caught by the sample that ended it."
    );
  }
  return lines.join("\n\n");
}

function renderTopFunctions(
  index: CpuSampleIndex,
  topN: number,
  startMs?: number,
  endMs?: number
): string {
  const windowStart = startMs ?? index.intervalStartsMs[0] ?? 0;
  const windowEnd = endMs ?? index.timestampsMs[index.timestampsMs.length - 1] ?? 0;
  const res = queryCpuWindow(index, windowStart, windowEnd, topN);

  if (res.hotspots.length === 0) return explainEmptyWindow(res, windowStart, windowEnd);

  const header = "| Function | Self (ms) | Total (ms) | Location |";
  const sep = "|---|---|---|---|";
  const rows = res.hotspots.map((hs) => {
    const loc = hs.url
      ? `${shortenUrl(hs.url)}${hs.lineNumber != null ? `:${hs.lineNumber}` : ""}`
      : "—";
    return `| \`${hs.name}\` | ${hs.selfMs} | ${hs.totalMs} | ${loc} |`;
  });

  return `## CPU Hotspots\n\n${coverageNote(res, windowStart, windowEnd)}\n\n${header}\n${sep}\n${rows.join("\n")}`;
}

function renderCallTree(
  index: CpuSampleIndex,
  functionName: string,
  topN: number,
  includeCallers: boolean
): string {
  const { nodeMap, sampleNodeIds, timestampsMs } = index;

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

  const calleeHits = new Map<string, { hits: number; node: HermesProfileNode }>();
  for (const nodeId of matchingNodeIds) {
    const node = nodeMap.get(nodeId);
    if (!node?.children) continue;
    for (const childId of node.children) {
      const child = nodeMap.get(childId);
      if (!child) continue;
      const name = child.callFrame.functionName;
      if (!name || name === "(idle)" || name === "[idle]" || name === "[root]") continue;
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
      if (!name || name === "(root)" || name === "[root]" || name === "[idle]") continue;
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

  // The report prints display names (wrappers stripped), so accept those too —
  // otherwise the tool refuses the name analyze told the caller to use.
  const resolution = resolveComponentName(
    componentName,
    commitTree.commits.map((c) => c.componentName)
  );
  if (resolution.kind === "ambiguous" || resolution.kind === "missing") {
    return renderComponentNameMiss(resolution, {
      fiberRenders: commitTree.commits.length,
      commits: new Set(commitTree.commits.map((c) => c.commitIndex)).size,
    });
  }
  const resolvedName = resolution.rawName;
  const resolutionNote = describeResolution(resolution);

  const componentCommits = commitTree.commits.filter((c) => c.componentName === resolvedName);

  if (componentCommits.length === 0) {
    return `_Component \`${resolvedName}\` not found in commit data._`;
  }

  const commitWindows = new Map<number, { start: number; end: number; duration: number }>();
  for (const c of componentCommits) {
    if (!commitWindows.has(c.commitIndex)) {
      // Dump-read commits can carry nulled timestamps/durations (same source as
      // profiler-commit-query, which guards every use the same way).
      const start = c.timestamp ?? 0;
      const duration = c.commitDuration ?? 0;
      commitWindows.set(c.commitIndex, {
        start,
        end: start + duration,
        duration,
      });
    }
  }

  const aggregated = new Map<
    string,
    { selfMs: number; totalMs: number; url?: string; lineNumber?: number }
  >();

  const childToParent = index.childToParent ?? buildChildToParent(index.nodeMap);

  for (const window of commitWindows.values()) {
    const { hotspots } = queryCpuWindow(index, window.start, window.end, 50);
    // Fold each window down to one row per function BEFORE adding it to the
    // running totals, because the two axes this loop walks need opposite
    // treatment.
    //
    // Within a window, `queryCpuWindow` emits one row per call-tree NODE, so
    // one function name can arrive several times. Self time is exclusive —
    // even nested frames own disjoint sample intervals — so it always adds.
    // Inclusive time belongs to whole subtrees: the row tracks the set of
    // disjoint subtree roots seen so far, and each newcomer is either already
    // inside one of them (recursion), contains some of them (an outer frame
    // arriving after its inner frames), or covers fresh ground (the same
    // helper called from an unrelated site) and joins the union. Deciding
    // pairwise against a single representative would not compose over three
    // or more nodes mixing nesting and disjointness. The window itself is
    // capped at its 50 costliest nodes by self time; nodes past the cap
    // contribute to neither column.
    const perWindow = new Map<
      string,
      {
        selfMs: number;
        totalMs: number;
        members: { nodeId: number; totalMs: number }[];
        url?: string;
        lineNumber?: number;
      }
    >();
    for (const hs of hotspots) {
      const seen = perWindow.get(hs.name);
      if (seen) {
        seen.selfMs += hs.selfMs;
        if (!seen.members.some((m) => isAncestor(m.nodeId, hs.nodeId, childToParent))) {
          seen.members = seen.members.filter(
            (m) => !isAncestor(hs.nodeId, m.nodeId, childToParent)
          );
          seen.members.push({ nodeId: hs.nodeId, totalMs: hs.totalMs });
          seen.totalMs = seen.members.reduce((sum, m) => sum + m.totalMs, 0);
        }
      } else {
        perWindow.set(hs.name, {
          selfMs: hs.selfMs,
          totalMs: hs.totalMs,
          members: [{ nodeId: hs.nodeId, totalMs: hs.totalMs }],
          url: hs.url,
          lineNumber: hs.lineNumber,
        });
      }
    }
    // Across windows both columns add. Commit windows are disjoint stretches of
    // wall clock, so a function's inclusive time in one cannot overlap its time
    // in another — the nesting that makes inclusive times unaddable does not
    // reach across them. Adding also keeps the two columns on one footing: an
    // exclusive column summed against an inclusive column maxed produces rows
    // whose `self` exceeds their own inclusive time, which is impossible for a
    // single frame and reads as broken output. It stays bounded by the commit
    // total printed above, since no single frame outlasts the window it is in.
    for (const [name, win] of perWindow) {
      const existing = aggregated.get(name);
      if (existing) {
        existing.selfMs += win.selfMs;
        existing.totalMs += win.totalMs;
      } else {
        aggregated.set(name, { ...win });
      }
    }
  }

  const sorted = [...aggregated.entries()].sort((a, b) => b[1].selfMs - a[1].selfMs).slice(0, topN);

  if (sorted.length === 0) {
    return `_No CPU samples found during \`${resolvedName}\` commits._`;
  }

  const totalCommitMs = [...commitWindows.values()].reduce((sum, w) => sum + w.duration, 0);

  const lines: string[] = [
    `## CPU During \`${resolvedName}\` Commits`,
    "",
    ...(resolutionNote ? [resolutionNote, ""] : []),
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

/**
 * True when `ancestor` is the given node or one of its call-tree ancestors, so
 * the ancestor's inclusive time already contains the node's. A cycle guard
 * bounds the walk.
 */
function isAncestor(
  ancestor: number,
  nodeId: number,
  childToParent: Map<number, number> | undefined
): boolean {
  if (!childToParent) return false;
  if (ancestor === nodeId) return true;
  const seen = new Set<number>([nodeId]);
  let current = nodeId;
  while (childToParent.has(current)) {
    current = childToParent.get(current)!;
    if (current === ancestor) return true;
    if (seen.has(current)) return false;
    seen.add(current);
  }
  return false;
}

/** Exposed for tests: the aggregation whose inclusive-duration handling is load-bearing. */
export const __testables = { renderComponentCpu };

export const profilerCpuQueryTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "profiler-cpu-query",
  interaction: {
    startedMsg: ({ params }) => `Querying CPU profile by ${params.mode.replaceAll("_", " ")}`,
    completedMsg: ({ params }) => `Queried CPU profile by ${params.mode.replaceAll("_", " ")}`,
    failedMsg: ({ failureSignal }) => `Failed to query CPU profile: ${failureSignal.error_code}`,
  },
  description: `Query Hermes CPU profile data with targeted modes for iterative investigation.
Requires react-profiler-stop (and ideally react-profiler-analyze) to have been called first.
Modes:
- top_functions: Global CPU hotspots ranked by self-time. Optional time_window_ms to filter.
- time_window: CPU breakdown for a specific time range (e.g. during a slow commit or hang).

Self-times are the summed sampling intervals of the samples that landed in the window, so they
measure sampled coverage rather than the window's width and do not change if you widen the query.
Every table states how many samples it covers and how much of that was idle.
- call_tree: For a given function_name, show its callees and optionally callers.
- component_cpu: For a given component_name, aggregate CPU activity across all its commits.
Use when investigating JS CPU hotspots or correlating CPU cost with specific components.
Returns a markdown table of CPU hotspots, call tree, or per-component CPU breakdown.
Fails if no CPU profile is stored — run react-profiler-stop first.`,
  zodSchema,
  // RN-only: reads Hermes-format CPU profiles; Chromium's V8 sample format differs.
  capability: RN_ONLY_TOOL_CAPABILITY,
  services: () => ({}),
  async execute(_services, params) {
    const sessionPaths = getCachedProfilerPaths(params.port, params.device_id);
    if (!sessionPaths) {
      throw new FailureError(
        "No profiling data stored. Run react-profiler-start → exercise the app → react-profiler-stop → react-profiler-analyze first.",
        {
          error_code: FAILURE_CODES.PROFILER_DATA_NOT_LOADED,
          failure_stage: "profiler_cpu_query_load_session",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    const { index, commitTree } = await getIndex(sessionPaths);

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
          throw new FailureError("time_window mode requires the time_window_ms parameter.", {
            error_code: FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING,
            failure_stage: "profiler_cpu_query_params",
            failure_area: "tool_server",
            error_kind: "validation",
          });
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
          throw new FailureError("call_tree mode requires the function_name parameter.", {
            error_code: FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING,
            failure_stage: "profiler_cpu_query_params",
            failure_area: "tool_server",
            error_kind: "validation",
          });
        }
        return renderCallTree(index, params.function_name, params.top_n, params.include_callers);
      }

      case "component_cpu": {
        if (!params.component_name) {
          throw new FailureError("component_cpu mode requires the component_name parameter.", {
            error_code: FAILURE_CODES.PROFILER_QUERY_REQUIRED_PARAM_MISSING,
            failure_stage: "profiler_cpu_query_params",
            failure_area: "tool_server",
            error_kind: "validation",
          });
        }
        return renderComponentCpu(index, commitTree, params.component_name, params.top_n);
      }

      default:
        throw new FailureError(`Unknown mode: ${params.mode}`, {
          error_code: FAILURE_CODES.PROFILER_QUERY_MODE_INVALID,
          failure_stage: "profiler_cpu_query_mode",
          failure_area: "tool_server",
          error_kind: "validation",
        });
    }
  },
};
