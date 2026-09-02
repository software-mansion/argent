/**
 * Stage 00-cpu-correlate: rank the JS functions sampled inside each hot commit's
 * [timestamp, timestamp + commitDuration] window.
 */
import type { HermesCpuProfile, HermesProfileNode } from "../types/input";
import type { CpuCommitHotspot } from "../types/output";

/** Prefix on argent's injected profiler functions, which are kept out of hotspots. */
const ARGENT_PROFILER_PREFIX = "__argent_";

export function isArgentProfilerFunction(name: string): boolean {
  return name.startsWith(ARGENT_PROFILER_PREFIX);
}

export interface CpuSampleIndex {
  /** End of each sample's interval, in ms since profiling started. */
  timestampsMs: Float64Array;
  /** Start of each sample's interval — `timestampsMs[i] - timeDeltas[i]`. */
  intervalStartsMs: Float64Array;
  sampleNodeIds: number[];
  nodeMap: Map<number, HermesProfileNode>;
  /** Whole recording, from the profile's startTime/endTime — may exceed the sampled span. */
  durationMs: number;
  /** Parent lookup, built once — queryCpuWindow runs per commit window. */
  childToParent?: Map<number, number>;
}

/** Pre-compute sample timestamps so windowed queries are a binary search. */
export function buildCpuSampleIndex(cpuProfile: HermesCpuProfile): CpuSampleIndex {
  const { nodes, samples, timeDeltas, startTime, endTime } = cpuProfile;

  const nodeMap = new Map<number, HermesProfileNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // Sample times are ms since profiling started, the same frame React commit
  // timestamps use (`performance.now() - profilingStartTime`), so no offset is
  // applied. Deriving one from `startTime` — a since-boot monotonic value —
  // displaced every sample by the first hot commit's timestamp (#619).
  const timestampsMs = new Float64Array(samples.length);
  // `timeDeltas[i]` is the time elapsed *before* sample i, so sample i stands for
  // the interval (t[i-1], t[i]]. The real deltas are kept rather than an average
  // because the sampler is not isochronous.
  const intervalStartsMs = new Float64Array(samples.length);
  let accumulatedUs = 0;
  for (let i = 0; i < samples.length; i++) {
    const raw = timeDeltas[i];
    const delta = Number.isFinite(raw) && (raw ?? 0) >= 0 ? (raw as number) : 0;
    intervalStartsMs[i] = accumulatedUs / 1000;
    accumulatedUs += delta;
    timestampsMs[i] = accumulatedUs / 1000;
  }

  return {
    childToParent: buildChildToParent(nodeMap),
    timestampsMs,
    intervalStartsMs,
    sampleNodeIds: samples,
    nodeMap,
    durationMs: (endTime - startTime) / 1000,
  };
}

export interface CpuWindowResult {
  /** Ranked by self-time; idle and argent-injected frames are excluded. */
  hotspots: CpuCommitHotspot[];
  /** Samples whose interval overlapped the window at all. */
  samplesInWindow: number;
  /** How much of the window is covered by sampled intervals, in ms. */
  coveredMs: number;
  /** Covered time that belonged to idle/runtime frames rather than JS. */
  idleMs: number;
  /** Sampled span of the whole profile, for explaining an out-of-range window. */
  sampleRangeMs: { start: number; end: number };
  /** Median sample interval in the window — the resolution of any answer here. */
  medianIntervalMs: number;
  /** Longest single interval overlapping the window, when the sampler stalled. */
  maxIntervalMs: number;
}

const IDLE_FRAME_NAMES = new Set(["(idle)", "(program)", "(root)", "[idle]", "[root]"]);

function isIdleFrame(name: string | undefined): boolean {
  return !name || IDLE_FRAME_NAMES.has(name);
}

/**
 * CPU cost inside [startMs, endMs], each sample contributing only the part of its
 * own interval that lies inside the window. This keeps the numbers additive across
 * adjoining windows and independent of how wide the caller made the query —
 * apportioning the requested width by hit share did not (#619).
 */
export function queryCpuWindow(
  index: CpuSampleIndex,
  startMs: number,
  endMs: number,
  topN: number = 5
): CpuWindowResult {
  const { timestampsMs, intervalStartsMs, sampleNodeIds, nodeMap } = index;
  const n = timestampsMs.length;
  const sampleRangeMs = {
    start: n > 0 ? intervalStartsMs[0]! : 0,
    end: n > 0 ? timestampsMs[n - 1]! : 0,
  };
  const empty: CpuWindowResult = {
    hotspots: [],
    samplesInWindow: 0,
    coveredMs: 0,
    idleMs: 0,
    sampleRangeMs,
    medianIntervalMs: 0,
    maxIntervalMs: 0,
  };
  if (n === 0) return empty;

  // First sample whose interval could reach the window; intervals are ordered and
  // non-overlapping, so a binary search on their end points is enough.
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestampsMs[mid]! < startMs) lo = mid + 1;
    else hi = mid;
  }

  const selfMsByNode = new Map<number, number>();
  const intervals: number[] = [];
  let samplesInWindow = 0;
  let coveredMs = 0;
  let idleMs = 0;
  let maxIntervalMs = 0;

  for (let i = lo; i < n; i++) {
    const from = intervalStartsMs[i]!;
    if (from > endMs) break;
    const overlap = Math.min(endMs, timestampsMs[i]!) - Math.max(startMs, from);
    if (overlap <= 0) continue;

    samplesInWindow++;
    coveredMs += overlap;
    intervals.push(timestampsMs[i]! - from);
    if (timestampsMs[i]! - from > maxIntervalMs) maxIntervalMs = timestampsMs[i]! - from;

    const nodeId = sampleNodeIds[i]!;
    const node = nodeMap.get(nodeId);
    // Idle time is measured but never ranked: a window can be fully covered and
    // still contain no JS work.
    if (isIdleFrame(node?.callFrame.functionName)) {
      idleMs += overlap;
      continue;
    }
    selfMsByNode.set(nodeId, (selfMsByNode.get(nodeId) ?? 0) + overlap);
  }

  if (samplesInWindow === 0) return { ...empty, sampleRangeMs };

  intervals.sort((a, b) => a - b);
  const medianIntervalMs = intervals[Math.floor(intervals.length / 2)] ?? 0;

  // Total time = self time plus everything attributed to descendants.
  const childToParent = index.childToParent ?? buildChildToParent(nodeMap);
  const totalMsByNode = new Map<number, number>();
  for (const [nodeId, ms] of selfMsByNode) {
    totalMsByNode.set(nodeId, (totalMsByNode.get(nodeId) ?? 0) + ms);
    let current = nodeId;
    const seen = new Set<number>([current]);
    while (childToParent.has(current)) {
      const parent = childToParent.get(current)!;
      if (seen.has(parent)) break;
      seen.add(parent);
      totalMsByNode.set(parent, (totalMsByNode.get(parent) ?? 0) + ms);
      current = parent;
    }
  }

  const entries: CpuCommitHotspot[] = [];
  for (const [nodeId, ms] of selfMsByNode) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;
    const name = node.callFrame.functionName;
    if (isArgentProfilerFunction(name)) continue;

    entries.push({
      name,
      selfMs: Math.round(ms * 100) / 100,
      totalMs: Math.round((totalMsByNode.get(nodeId) ?? ms) * 100) / 100,
      url: node.callFrame.url || undefined,
      lineNumber: node.callFrame.lineNumber >= 0 ? node.callFrame.lineNumber : undefined,
    });
  }
  entries.sort((a, b) => b.selfMs - a.selfMs);

  return {
    hotspots: entries.slice(0, topN),
    samplesInWindow,
    coveredMs,
    idleMs,
    sampleRangeMs,
    medianIntervalMs,
    maxIntervalMs,
  };
}

function buildChildToParent(nodeMap: Map<number, HermesProfileNode>): Map<number, number> {
  const childToParent = new Map<number, number>();
  for (const node of nodeMap.values()) {
    for (const childId of node.children ?? []) childToParent.set(childId, node.id);
  }
  return childToParent;
}

/** Attaches cpuHotspots to every non-margin summary that had CPU activity. */
export function correlateCpuWithCommits<
  T extends { commitIndex: number; timestampMs: number; totalRenderMs: number; isMargin: boolean },
>(
  summaries: T[],
  index: CpuSampleIndex | null,
  topNPerCommit: number = 5
): (T & { cpuHotspots?: CpuCommitHotspot[] })[] {
  if (!index) return summaries;

  return summaries.map((summary) => {
    if (summary.isMargin) return summary;

    const startMs = summary.timestampMs;
    const endMs = summary.timestampMs + summary.totalRenderMs;
    const { hotspots } = queryCpuWindow(index, startMs, endMs, topNPerCommit);

    if (hotspots.length === 0) return summary;
    return { ...summary, cpuHotspots: hotspots };
  });
}

/**
 * On-disk form of CpuSampleIndex. Versioned since #619: a v1 index holds
 * timestamps displaced by the old clock heuristic and no interval starts, so
 * readers reject it and rebuild from the raw profile, which is always kept.
 */
interface SerializedCpuSampleIndex {
  version: 2;
  timestampsMs: number[];
  intervalStartsMs: number[];
  sampleNodeIds: number[];
  nodes: HermesProfileNode[];
  durationMs: number;
}

export function serializeCpuSampleIndex(index: CpuSampleIndex): SerializedCpuSampleIndex {
  return {
    version: 2,
    timestampsMs: Array.from(index.timestampsMs),
    intervalStartsMs: Array.from(index.intervalStartsMs),
    sampleNodeIds: index.sampleNodeIds,
    nodes: [...index.nodeMap.values()],
    durationMs: index.durationMs,
  };
}

export function deserializeCpuSampleIndex(raw: SerializedCpuSampleIndex): CpuSampleIndex {
  // Validate rather than coerce: `new Float64Array(undefined)` is zero-length, so a
  // truncated or stale index would deserialize into a profile with no samples and
  // answer every query with "no hotspots".
  if (raw?.version !== 2 || !Array.isArray(raw.timestampsMs) || !Array.isArray(raw.nodes)) {
    throw new Error("unsupported CPU sample index format");
  }
  const nodeMap = new Map<number, HermesProfileNode>();
  for (const node of raw.nodes) {
    nodeMap.set(node.id, node);
  }
  return {
    timestampsMs: new Float64Array(raw.timestampsMs),
    intervalStartsMs: new Float64Array(raw.intervalStartsMs ?? []),
    sampleNodeIds: raw.sampleNodeIds,
    nodeMap,
    childToParent: buildChildToParent(nodeMap),
    durationMs: raw.durationMs,
  };
}
