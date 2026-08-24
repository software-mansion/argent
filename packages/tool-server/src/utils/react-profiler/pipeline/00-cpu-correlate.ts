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
  /** End of each sample's interval, in ms since profiling started. */
  timestampsMs: Float64Array;
  /** Start of each sample's interval — `timestampsMs[i] - timeDeltas[i]`. */
  intervalStartsMs: Float64Array;
  /** Node ID for each sample. */
  sampleNodeIds: number[];
  /** Map from node ID to its HermesProfileNode. */
  nodeMap: Map<number, HermesProfileNode>;
  /** Total recording duration in ms. */
  durationMs: number;
  /** Parent lookup, built once — queryCpuWindow runs per commit window. */
  childToParent?: Map<number, number>;
}

/**
 * Build a pre-computed index of CPU sample timestamps for efficient windowed queries.
 * Aligns CPU profile microsecond clock to React commit performance.now() clock.
 */
export function buildCpuSampleIndex(cpuProfile: HermesCpuProfile): CpuSampleIndex {
  const { nodes, samples, timeDeltas, startTime, endTime } = cpuProfile;

  const nodeMap = new Map<number, HermesProfileNode>();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // Sample times are expressed as ms since profiling started, which is the same
  // frame React commit timestamps use: React DevTools reports every commit as
  // `performance.now() - profilingStartTime`, never an absolute clock.
  //
  // The previous code instead inferred an offset by assuming the first commit
  // coincided with the start of the CPU profile, and applied it whenever the two
  // numbers differed by more than a second. `startTime` is a since-boot
  // monotonic value (~1.28e12 µs on a device up two weeks), so that condition was
  // always true and the offset was always the first hot commit's timestamp —
  // displacing every sample by it. A session whose first hot commit landed 12.3s
  // in had its whole sample set shifted 12.3s later, which is why windows taken
  // from commit timestamps found nothing and a late window returned touch work
  // from much earlier (#619).
  const timestampsMs = new Float64Array(samples.length);
  // Per-sample weights: `timeDeltas[i]` is the time that elapsed *before* sample
  // i, so sample i stands for the interval (t[i-1], t[i]]. Keeping the real
  // deltas rather than an average matters because the sampler is not
  // isochronous — on a real Hermes profile they range from 0 to 36.6ms around a
  // 13.1ms median.
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

/**
 * For a given time window [startMs, endMs], collect CPU samples and aggregate
 * into a ranked list of hot functions.
 */
export interface CpuWindowResult {
  /** Named hotspots, ranked by self-time. Empty when nothing was executing. */
  hotspots: CpuCommitHotspot[];
  /** Samples whose interval overlapped the window at all. */
  samplesInWindow: number;
  /** How much of the window is covered by sampled intervals, in ms. */
  coveredMs: number;
  /** Covered time that belonged to idle/runtime frames rather than JS. */
  idleMs: number;
  /** Sampled span of the whole profile, for explaining an out-of-range window. */
  sampleRangeMs: { start: number; end: number };
  /** Typical gap between samples — the resolution any answer here is limited to. */
  medianIntervalMs: number;
  /** Longest single interval overlapping the window, when the sampler stalled. */
  maxIntervalMs: number;
}

const IDLE_FRAME_NAMES = new Set(["(idle)", "(program)", "(root)", "[idle]", "[root]"]);

function isIdleFrame(name: string | undefined): boolean {
  return !name || IDLE_FRAME_NAMES.has(name);
}

/**
 * CPU cost inside [startMs, endMs], attributed by integrating each sample's own
 * interval over the window.
 *
 * Each sample stands for the interval (t[i-1], t[i]], and a sample contributes
 * only the part of that interval lying inside the window. That is what makes the
 * numbers mean something: they are additive across adjoining windows, they never
 * exceed the window's own width, and — crucially — they do not change when the
 * caller widens the query.
 *
 * The previous implementation divided the REQUESTED window width by the number
 * of samples in it (`avgIntervalMs = (endMs - startMs) / totalSamples`), so
 * self-time was the window's duration apportioned by hit share. Asking about a
 * range twice as wide doubled every number without the sample data changing at
 * all (#619).
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

  // First sample whose interval could reach the window. Intervals are ordered
  // and non-overlapping, so a binary search on their end points is enough.
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
    // still contain no JS work, and saying so is the useful answer.
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

/**
 * Correlate CPU samples with hot commit time windows, attaching cpuHotspots
 * to each HotCommitSummary that has matching CPU activity.
 */
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
 * Serializable form of CpuSampleIndex for disk persistence.
 *
 * Versioned since #619: a v1 index on disk holds timestamps displaced by the old
 * clock heuristic and carries no interval starts, so reusing one would answer
 * every query with the numbers the fix exists to remove. Readers reject anything
 * that is not v2 and rebuild from the raw profile, which is always kept.
 */
interface SerializedCpuSampleIndex {
  version: 2;
  timestampsMs: number[];
  intervalStartsMs: number[];
  sampleNodeIds: number[];
  nodes: HermesProfileNode[];
  durationMs: number;
}

/** Convert a CpuSampleIndex to a plain object for JSON serialization. */
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

/** Reconstruct a CpuSampleIndex from its serialized form. */
export function deserializeCpuSampleIndex(raw: SerializedCpuSampleIndex): CpuSampleIndex {
  // Validate rather than coerce: `new Float64Array(undefined)` is a zero-length
  // array, so a truncated or stale index would otherwise deserialize into a
  // profile with no samples and answer every query with "no hotspots" forever.
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
