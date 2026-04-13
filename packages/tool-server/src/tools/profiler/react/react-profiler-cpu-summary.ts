import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  REACT_PROFILER_SESSION_NAMESPACE,
  type ReactProfilerSessionApi,
  getCachedProfilerPaths,
} from "../../../blueprints/react-profiler-session";
import type {
  HermesProfileNode,
  HermesCpuProfile,
} from "../../../utils/react-profiler/types/input";
import { readCpuProfile } from "../../../utils/react-profiler/debug/dump";
import { isArgentProfilerFunction } from "../../../utils/react-profiler/pipeline/00-cpu-correlate";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port"),
  top_n: z.coerce
    .number()
    .int()
    .positive()
    .default(20)
    .describe("Number of top hotspot functions to return (default 20)"),
  react_only: z
    .boolean()
    .default(false)
    .describe("If true, only show React component functions (PascalCase names)"),
});

interface HotspotEntry {
  function: string;
  url: string;
  self_ms: number;
  total_ms: number;
  self_pct: string;
}

function isReactComponent(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function buildHotspots(
  nodes: HermesProfileNode[],
  samples: number[],
  timeDeltas: number[],
  topN: number,
  reactOnly: boolean
): HotspotEntry[] {
  const nodeMap = new Map<number, HermesProfileNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const totalDeltaUs = timeDeltas.reduce((a, b) => a + b, 0);
  const avgIntervalUs = samples.length > 0 ? totalDeltaUs / samples.length : 0;

  const selfHits = new Map<number, number>();
  for (const sampleId of samples) {
    selfHits.set(sampleId, (selfHits.get(sampleId) ?? 0) + 1);
  }

  const childToParent = new Map<number, number>();
  for (const node of nodes) {
    for (const childId of node.children ?? []) {
      childToParent.set(childId, node.id);
    }
  }

  const totalHits = new Map<number, number>();
  for (const [id, hits] of selfHits) {
    totalHits.set(id, (totalHits.get(id) ?? 0) + hits);
    let current = id;
    while (childToParent.has(current)) {
      const parent = childToParent.get(current)!;
      totalHits.set(parent, (totalHits.get(parent) ?? 0) + hits);
      current = parent;
    }
  }

  const totalSelfMs = totalDeltaUs / 1000;
  const entries: HotspotEntry[] = [];

  for (const node of nodes) {
    const name = node.callFrame.functionName || "(anonymous)";
    if (isArgentProfilerFunction(name)) continue;
    if (reactOnly && !isReactComponent(name)) continue;

    const self = selfHits.get(node.id) ?? 0;
    if (self === 0 && reactOnly) continue;

    const selfUs = self * avgIntervalUs;
    const totalUs = (totalHits.get(node.id) ?? 0) * avgIntervalUs;

    entries.push({
      function: name,
      url: node.callFrame.url ? `${node.callFrame.url}:${node.callFrame.lineNumber}` : "",
      self_ms: Math.round(selfUs / 10) / 100,
      total_ms: Math.round(totalUs / 10) / 100,
      self_pct: totalSelfMs > 0 ? `${((selfUs / 1000 / totalSelfMs) * 100).toFixed(1)}%` : "0.0%",
    });
  }

  entries.sort((a, b) => b.self_ms - a.self_ms);
  return entries.slice(0, topN);
}

function renderMarkdownTable(entries: HotspotEntry[]): string {
  if (entries.length === 0) return "_No hotspots found._";
  const header = "| Function | Location | Self (ms) | Total (ms) | Self % |";
  const sep = "|---|---|---|---|---|";
  const rows = entries.map(
    (e) => `| \`${e.function}\` | ${e.url || "—"} | ${e.self_ms} | ${e.total_ms} | ${e.self_pct} |`
  );
  return [header, sep, ...rows].join("\n");
}

export const reactProfilerCpuSummaryTool: ToolDefinition<z.infer<typeof zodSchema>, string> = {
  id: "react-profiler-cpu-summary",
  description: `Return a raw Hermes CPU flamegraph summary (top hotspot functions by self-time).
FOR DEDICATED CPU INVESTIGATION ONLY — do NOT call this as part of a normal profiling session.
Use react-profiler-analyze instead; it covers all React rendering performance analysis.
Use when you specifically need to investigate JS CPU hotspots that are NOT tied to React rendering (e.g. regex slowness, cryptography, heavy computations).
Call react-profiler-stop first. Reads directly from the stored cpuProfile.
Returns a markdown table of the top hotspot functions with self-time, total-time, and location.
Fails if react-profiler-stop has not been called or no CPU profile is stored.`,
  zodSchema,
  services: (params) => ({
    profilerSession: `${REACT_PROFILER_SESSION_NAMESPACE}:${params.port}`,
  }),
  async execute(services, params) {
    const api = services.profilerSession as ReactProfilerSessionApi;

    const sessionPaths = api.sessionPaths ?? getCachedProfilerPaths(api.port);
    if (!sessionPaths?.cpuProfilePath) {
      throw new Error(
        "No CPU profile stored. Call react-profiler-start, exercise the app, then react-profiler-stop."
      );
    }

    const cpuProfile: HermesCpuProfile = await readCpuProfile(sessionPaths.cpuProfilePath);

    const { nodes, samples, timeDeltas, startTime, endTime } = cpuProfile;
    const duration_ms = Math.round((endTime - startTime) / 1000);
    const entries = buildHotspots(nodes, samples, timeDeltas, params.top_n, params.react_only);
    const table = renderMarkdownTable(entries);

    return (
      `## CPU Profile Summary\n\n` +
      `**Duration:** ${duration_ms} ms  **Samples:** ${samples.length}  ` +
      `**Filter:** ${params.react_only ? "React components only" : "all functions"}\n\n` +
      `### Top ${params.top_n} Hotspots\n\n` +
      table
    );
  },
};
