import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  getCachedProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import type {
  DevToolsFiberCommit,
  DevToolsCommitTree,
} from "../../../utils/react-profiler/types/input";
import { deriveReason } from "../../../utils/react-profiler/pipeline/utils";
import { readCommitTree } from "../../../utils/react-profiler/debug/dump";

const timeRangeSchema = z.object({
  start: z.coerce.number().describe("Start of range in ms (performance.now clock)"),
  end: z.coerce.number().describe("End of range in ms (performance.now clock)"),
});

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  mode: z
    .enum(["by_component", "by_time_range", "by_index", "cascade_tree"])
    .describe(
      "Query mode: by_component (commits for a component), by_time_range (commits in a window), " +
        "by_index (full detail for one commit), cascade_tree (parent-child cascade for a commit)"
    ),
  component_name: z.string().optional().describe("Component name for by_component mode"),
  time_range_ms: timeRangeSchema.optional().describe("Time range filter for by_time_range mode"),
  commit_index: z.coerce
    .number()
    .int()
    .optional()
    .describe("Commit index for by_index and cascade_tree modes"),
  top_n: z.coerce
    .number()
    .int()
    .positive()
    .default(20)
    .describe("Max results to return (default 20)"),
});

async function getCommitTree(api: ReactProfilerSessionApi): Promise<DevToolsCommitTree> {
  const sessionPaths = api.sessionPaths ?? getCachedProfilerPaths(api.port);
  if (!sessionPaths?.commitsPath) {
    throw new Error(
      "No commit data stored. Run react-profiler-start → exercise app → react-profiler-stop first."
    );
  }
  const onDisk = await readCommitTree(sessionPaths.commitsPath);
  if (onDisk.commits.length === 0) {
    throw new Error(
      "No commit data stored. Run react-profiler-start → exercise app → react-profiler-stop first."
    );
  }
  return { commits: onDisk.commits, hookNames: new Map() };
}

function formatReason(commit: DevToolsFiberCommit): string {
  const cd = commit.changeDescription;
  if (!cd) return "unknown";
  if (cd.isFirstMount) return "mount";
  const reason = deriveReason(cd, commit.hookTypes ?? null);
  const parts: string[] = [reason];
  if (cd.props && cd.props.length > 0) {
    parts.push(`[${cd.props.slice(0, 3).join(", ")}]`);
  }
  if (cd.hooks && cd.hooks.length > 0 && commit.hookTypes) {
    const hookNames = cd.hooks.slice(0, 3).map((i) => commit.hookTypes?.[i] ?? `hook[${i}]`);
    parts.push(`[${hookNames.join(", ")}]`);
  }
  if (cd.context) parts.push("(context)");
  return parts.join(" ");
}

function renderByComponent(
  commits: DevToolsFiberCommit[],
  componentName: string,
  topN: number
): string {
  const matching = commits.filter((c) => c.componentName === componentName);
  if (matching.length === 0) {
    return `_Component \`${componentName}\` not found in commit data._`;
  }

  // Group by commitIndex
  const byCommit = new Map<number, DevToolsFiberCommit[]>();
  for (const c of matching) {
    let group = byCommit.get(c.commitIndex);
    if (!group) {
      group = [];
      byCommit.set(c.commitIndex, group);
    }
    group.push(c);
  }

  const sortedCommits = [...byCommit.entries()]
    .map(([idx, entries]) => ({
      commitIndex: idx,
      instances: entries.length,
      totalDuration: entries.reduce((s, e) => s + e.actualDuration, 0),
      commitDuration: entries[0]!.commitDuration,
      timestamp: entries[0]!.timestamp,
      reason: formatReason(entries[0]!),
      parentName: entries[0]!.parentName ?? "—",
    }))
    .sort((a, b) => b.totalDuration - a.totalDuration)
    .slice(0, topN);

  const lines: string[] = [
    `## Commits for \`${componentName}\``,
    "",
    `**Total occurrences:** ${matching.length} across ${byCommit.size} commits`,
    "",
    "| Commit | Instances | Duration (ms) | Commit Total (ms) | Time (ms) | Reason | Parent |",
    "|---|---|---|---|---|---|---|",
  ];

  for (const c of sortedCommits) {
    lines.push(
      `| #${c.commitIndex} | ${c.instances} | ${c.totalDuration.toFixed(1)} | ${c.commitDuration.toFixed(1)} | ${c.timestamp.toFixed(0)} | ${c.reason} | \`${c.parentName}\` |`
    );
  }

  return lines.join("\n");
}

function renderByTimeRange(
  commits: DevToolsFiberCommit[],
  start: number,
  end: number,
  topN: number
): string {
  const matching = commits.filter((c) => c.timestamp >= start && c.timestamp <= end);

  if (matching.length === 0) {
    return `_No commits found in the range ${start.toFixed(0)}ms → ${end.toFixed(0)}ms._`;
  }

  // Group by commitIndex
  const byCommit = new Map<number, DevToolsFiberCommit[]>();
  for (const c of matching) {
    let group = byCommit.get(c.commitIndex);
    if (!group) {
      group = [];
      byCommit.set(c.commitIndex, group);
    }
    group.push(c);
  }

  const summaries = [...byCommit.entries()]
    .map(([idx, entries]) => ({
      commitIndex: idx,
      componentCount: new Set(entries.map((e) => e.componentName)).size,
      commitDuration: entries[0]!.commitDuration,
      timestamp: entries[0]!.timestamp,
      topComponents: getTopComponents(entries, 5),
    }))
    .sort((a, b) => b.commitDuration - a.commitDuration)
    .slice(0, topN);

  const lines: string[] = [
    `## Commits in ${start.toFixed(0)}ms → ${end.toFixed(0)}ms`,
    "",
    `**Commits:** ${byCommit.size}  **Fiber renders:** ${matching.length}`,
    "",
  ];

  for (const s of summaries) {
    lines.push(
      `### Commit #${s.commitIndex} — ${s.commitDuration.toFixed(1)}ms (t=${s.timestamp.toFixed(0)}ms, ${s.componentCount} components)`
    );
    lines.push("");
    for (const comp of s.topComponents) {
      lines.push(
        `- \`${comp.name}\` ×${comp.count} ${comp.totalDuration.toFixed(1)}ms — ${comp.reason}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function renderByIndex(commits: DevToolsFiberCommit[], commitIndex: number): string {
  const matching = commits.filter((c) => c.commitIndex === commitIndex);
  if (matching.length === 0) {
    return `_Commit #${commitIndex} not found in stored data._`;
  }

  const commitDuration = matching[0]!.commitDuration;
  const timestamp = matching[0]!.timestamp;

  const lines: string[] = [
    `## Commit #${commitIndex} — Full Detail`,
    "",
    `**Time:** ${timestamp.toFixed(0)}ms  **Duration:** ${commitDuration.toFixed(1)}ms  **Fibers:** ${matching.length}`,
    "",
    "| Component | Duration (ms) | Self (ms) | Reason | Parent | Compiler |",
    "|---|---|---|---|---|---|",
  ];

  const sorted = [...matching].sort((a, b) => b.actualDuration - a.actualDuration);

  for (const c of sorted) {
    const reason = formatReason(c);
    const parent = c.parentName ?? "—";
    const compiler = c.isCompilerOptimized ? "✓" : "";
    lines.push(
      `| \`${c.componentName}\` | ${c.actualDuration.toFixed(1)} | ${c.selfDuration.toFixed(1)} | ${reason} | \`${parent}\` | ${compiler} |`
    );
  }

  // Root cause chain if available
  const withRootCause = matching.find((c) => c.rootCauseParent);
  if (withRootCause?.rootCauseChain && withRootCause.rootCauseChain.length > 0) {
    lines.push("");
    lines.push(
      `**Root cause chain:** ${withRootCause.rootCauseChain.map((n) => `\`${n}\``).join(" → ")} → \`${withRootCause.rootCauseParent}\``
    );
    if (withRootCause.rootCauseReason) {
      lines.push(`**Root cause reason:** ${withRootCause.rootCauseReason}`);
    }
  }

  return lines.join("\n");
}

function renderCascadeTree(commits: DevToolsFiberCommit[], commitIndex: number): string {
  const matching = commits.filter((c) => c.commitIndex === commitIndex);
  if (matching.length === 0) {
    return `_Commit #${commitIndex} not found in stored data._`;
  }

  // Build parent-child adjacency from parentName
  const children = new Map<string, DevToolsFiberCommit[]>();
  const roots: DevToolsFiberCommit[] = [];

  for (const c of matching) {
    const parentName = c.parentName;
    if (!parentName || !matching.some((m) => m.componentName === parentName)) {
      roots.push(c);
    } else {
      let list = children.get(parentName);
      if (!list) {
        list = [];
        children.set(parentName, list);
      }
      list.push(c);
    }
  }

  const lines: string[] = [`## Cascade Tree — Commit #${commitIndex}`, ""];

  // Deduplicate: group by component name at same level
  const rendered = new Set<string>();

  function renderNode(name: string, depth: number): void {
    if (rendered.has(`${name}:${depth}`)) return;
    rendered.add(`${name}:${depth}`);

    const instances = matching.filter((c) => c.componentName === name);
    const totalSelf = instances.reduce((s, c) => s + c.selfDuration, 0);
    const count = instances.length;
    const reason = instances[0] ? formatReason(instances[0]) : "";
    const indent = "  ".repeat(depth);
    const countStr = count > 1 ? ` ×${count}` : "";

    lines.push(`${indent}- \`${name}\`${countStr} self=${totalSelf.toFixed(1)}ms — ${reason}`);

    const childCommits = children.get(name) ?? [];
    const childNames = new Set(childCommits.map((c) => c.componentName));
    for (const childName of childNames) {
      renderNode(childName, depth + 1);
    }
  }

  // Deduplicate roots by name
  const rootNames = new Set(roots.map((r) => r.componentName));
  for (const name of rootNames) {
    renderNode(name, 0);
  }

  return lines.join("\n");
}

function getTopComponents(
  entries: DevToolsFiberCommit[],
  topN: number
): { name: string; count: number; totalDuration: number; reason: string }[] {
  const byName = new Map<
    string,
    { count: number; totalDuration: number; first: DevToolsFiberCommit }
  >();
  for (const e of entries) {
    const existing = byName.get(e.componentName);
    if (existing) {
      existing.count++;
      existing.totalDuration += e.actualDuration;
    } else {
      byName.set(e.componentName, { count: 1, totalDuration: e.actualDuration, first: e });
    }
  }

  return [...byName.entries()]
    .sort((a, b) => b[1].totalDuration - a[1].totalDuration)
    .slice(0, topN)
    .map(([name, { count, totalDuration, first }]) => ({
      name,
      count,
      totalDuration,
      reason: formatReason(first),
    }));
}

export const profilerCommitQueryTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "profiler-commit-query",
  description: `Query stored React commit data for deep-dive investigation of render performance after react-profiler-analyze has identified hot commits.
Use when you need to understand which specific renders occurred, what triggered them, or get full detail on a single commit.

Parameters: port (default 8081); mode — by_component (all commits for "ProductList"), by_time_range (commits in a ms window), by_index (full detail of commit #5), cascade_tree (parent-child cascade for commit #5); component_name, time_range_ms, commit_index — mode-specific inputs; top_n (default 20).
Example: { "port": 8081, "mode": "by_component", "component_name": "ProductList" }
Returns a markdown string with matching commits, causes, and durations. Requires react-profiler-stop to have been called first. Fails if no commit tree is stored — call react-profiler-stop then react-profiler-analyze first.`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.profilerSession as ReactProfilerSessionApi;
    const commitTree = await getCommitTree(api);

    switch (params.mode) {
      case "by_component": {
        if (!params.component_name) {
          throw new Error("by_component mode requires the component_name parameter.");
        }
        return renderByComponent(commitTree.commits, params.component_name, params.top_n);
      }

      case "by_time_range": {
        if (!params.time_range_ms) {
          throw new Error("by_time_range mode requires the time_range_ms parameter.");
        }
        return renderByTimeRange(
          commitTree.commits,
          params.time_range_ms.start,
          params.time_range_ms.end,
          params.top_n
        );
      }

      case "by_index": {
        if (params.commit_index == null) {
          throw new Error("by_index mode requires the commit_index parameter.");
        }
        return renderByIndex(commitTree.commits, params.commit_index);
      }

      case "cascade_tree": {
        if (params.commit_index == null) {
          throw new Error("cascade_tree mode requires the commit_index parameter.");
        }
        return renderCascadeTree(commitTree.commits, params.commit_index);
      }

      default:
        throw new Error(`Unknown mode: ${params.mode}`);
    }
  },
};
