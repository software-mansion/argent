/**
 * Stage 00-cpu-correlate: Map Hermes CPU samples to React commit time windows.
 *
 * For each hot commit, finds CPU samples whose timestamps fall within the
 * commit's [timestamp, timestamp + commitDuration] window, then aggregates
 * by function name to produce a ranked list of JS functions executing during
 * that commit.
 *
 * Clock alignment: The Hermes CPU profile uses microsecond monotonic timestamps
 * (Profiler.start/stop), while React commits use performance.now() milliseconds.
 * Both originate from the same Hermes runtime monotonic clock. We compute an
 * offset by comparing the CPU profile's startTime with the earliest commit
 * timestamp and build a sample-index-to-ms lookup for efficient windowed queries.
 */
import type { HermesCpuProfile, HermesProfileNode } from "../types/input";
import type { CpuCommitHotspot } from "../types/output";

/** Prefix used to name profiler-injected hook functions in the Hermes runtime. */
export const ARGENT_PROFILER_PREFIX = "__argent_";

/** Returns true if `name` is an argent-injected profiler function. */
export function isArgentProfilerFunction(name: string): boolean {
  return name.startsWith(ARGENT_PROFILER_PREFIX);
}

export interface CpuSampleIndex {
  /** Absolute timestamp in ms for each sample (aligned to performance.now clock). */
  timestampsMs: Float64Array;
  /** Node ID for each sample. */
  sampleNodeIds: number[];
  /** Map from node ID to its HermesProfileNode. */
  nodeMap: Map<number, HermesProfileNode>;
  /** Total recording duration in ms. */
  durationMs: number;
}

/**
 * Build a pre-computed index of CPU sample timestamps for efficient windowed queries.
 * Aligns CPU profile microsecond clock to React commit performance.now() clock.
 */
export function buildCpuSampleIndex(
  cpuProfile: HermesCpuProfile,
  firstCommitTimestampMs: number | null,
): CpuSampleIndex {
  const { nodes, samples, timeDeltas, startTime, endTime } = cpuProfile;

  const nodeMap = new Map<number, HermesProfileNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  const cpuStartMs = startTime / 1000;

  // Compute clock offset: if we have commit data, align CPU clock to commit clock.
  // Both are monotonic from the same Hermes runtime, but may have different epochs.
  // The offset is typically near zero but can drift on some Hermes versions.
  let clockOffsetMs = 0;
  if (firstCommitTimestampMs !== null && firstCommitTimestampMs > 0) {
    // The first commit typically happens shortly after profiling starts.
    // If the first commit timestamp is vastly different from cpuStartMs,
    // they use different epoch bases and we need to offset.
    const diff = firstCommitTimestampMs - cpuStartMs;
    // Only apply offset if clocks are clearly on different bases (>1s apart)
    if (Math.abs(diff) > 1000) {
      clockOffsetMs = diff;
    }
  }

  // Build absolute timestamps for each sample
  const timestampsMs = new Float64Array(samples.length);
  let accumulatedUs = startTime;
  for (let i = 0; i < samples.length; i++) {
    if (i > 0) accumulatedUs += timeDeltas[i]!;
    timestampsMs[i] = accumulatedUs / 1000 + clockOffsetMs;
  }

  return {
    timestampsMs,
    sampleNodeIds: samples,
    nodeMap,
    durationMs: (endTime - startTime) / 1000,
  };
}

/**
 * For a given time window [startMs, endMs], collect CPU samples and aggregate
 * into a ranked list of hot functions.
 */
export function queryCpuWindow(
  index: CpuSampleIndex,
  startMs: number,
  endMs: number,
  topN: number = 5,
): CpuCommitHotspot[] {
  const { timestampsMs, sampleNodeIds, nodeMap } = index;

  // Binary search for the first sample >= startMs
  let lo = 0;
  let hi = timestampsMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestampsMs[mid]! < startMs) lo = mid + 1;
    else hi = mid;
  }

  // Accumulate self-time hits per node
  const selfHits = new Map<number, number>();
  let totalSamples = 0;

  for (let i = lo; i < timestampsMs.length; i++) {
    if (timestampsMs[i]! > endMs) break;
    const nodeId = sampleNodeIds[i]!;
    selfHits.set(nodeId, (selfHits.get(nodeId) ?? 0) + 1);
    totalSamples++;
  }

  if (totalSamples === 0) return [];

  // Compute interval: average time between samples in this window
  const windowDurationMs = endMs - startMs;
  const avgIntervalMs = totalSamples > 1 ? windowDurationMs / totalSamples : 1;

  // Build total-time by propagating hits up the call tree
  const childToParent = new Map<number, number>();
  for (const node of nodeMap.values()) {
    for (const childId of node.children ?? []) {
      childToParent.set(childId, node.id);
    }
  }

  const totalHits = new Map<number, number>();
  for (const [nodeId, hits] of selfHits) {
    totalHits.set(nodeId, (totalHits.get(nodeId) ?? 0) + hits);
    let current = nodeId;
    while (childToParent.has(current)) {
      const parent = childToParent.get(current)!;
      totalHits.set(parent, (totalHits.get(parent) ?? 0) + hits);
      current = parent;
    }
  }

  // Build entries, filter out anonymous/idle nodes
  const entries: CpuCommitHotspot[] = [];
  for (const [nodeId, hits] of selfHits) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    const name = node.callFrame.functionName;
    if (!name || name === "(idle)" || name === "(program)" || name === "(root)") continue;
    if (isArgentProfilerFunction(name)) continue;

    const selfMs = Math.round(hits * avgIntervalMs * 100) / 100;
    const totalMs = Math.round((totalHits.get(nodeId) ?? hits) * avgIntervalMs * 100) / 100;

    entries.push({
      name,
      selfMs,
      totalMs,
      url: node.callFrame.url || undefined,
      lineNumber: node.callFrame.lineNumber >= 0 ? node.callFrame.lineNumber : undefined,
    });
  }

  entries.sort((a, b) => b.selfMs - a.selfMs);
  return entries.slice(0, topN);
}

/**
 * Correlate CPU samples with hot commit time windows, attaching cpuHotspots
 * to each HotCommitSummary that has matching CPU activity.
 */
export function correlateCpuWithCommits<
  T extends { commitIndex: number; timestampMs: number; totalRenderMs: number; isMargin: boolean },
>(
  summaries: T[],
  index: CpuSampleIndex | null,
  topNPerCommit: number = 5,
): (T & { cpuHotspots?: CpuCommitHotspot[] })[] {
  if (!index) return summaries;

  return summaries.map((summary) => {
    if (summary.isMargin) return summary;

    const startMs = summary.timestampMs;
    const endMs = summary.timestampMs + summary.totalRenderMs;
    const hotspots = queryCpuWindow(index, startMs, endMs, topNPerCommit);

    if (hotspots.length === 0) return summary;
    return { ...summary, cpuHotspots: hotspots };
  });
}

/** Serializable form of CpuSampleIndex for disk persistence. */
interface SerializedCpuSampleIndex {
  timestampsMs: number[];
  sampleNodeIds: number[];
  nodes: HermesProfileNode[];
  durationMs: number;
}

/** Convert a CpuSampleIndex to a plain object for JSON serialization. */
export function serializeCpuSampleIndex(index: CpuSampleIndex): SerializedCpuSampleIndex {
  return {
    timestampsMs: Array.from(index.timestampsMs),
    sampleNodeIds: index.sampleNodeIds,
    nodes: [...index.nodeMap.values()],
    durationMs: index.durationMs,
  };
}

/** Reconstruct a CpuSampleIndex from its serialized form. */
export function deserializeCpuSampleIndex(raw: SerializedCpuSampleIndex): CpuSampleIndex {
  const nodeMap = new Map<number, HermesProfileNode>();
  for (const node of raw.nodes) {
    nodeMap.set(node.id, node);
  }
  return {
    timestampsMs: new Float64Array(raw.timestampsMs),
    sampleNodeIds: raw.sampleNodeIds,
    nodeMap,
    durationMs: raw.durationMs,
  };
}
