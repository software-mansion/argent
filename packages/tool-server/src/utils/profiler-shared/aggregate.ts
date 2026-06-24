import type { CpuHotspot } from "./types";

const MIN_WEIGHT_PERCENTAGE = 3;
/**
 * Gap (ms) separating two activity bursts of the same (thread, function).
 * Single source of truth for both paths: iOS consumes it here (timestamp-derived
 * bursts below); Android injects `BURST_GAP_MS × 1e6` into cpu-hotspots.sql as
 * the `BURST_GAP_NS` token (pipeline/index.ts) so the two can't drift.
 */
export const BURST_GAP_MS = 500;

/**
 * Generic aggregator input — one row per (thread, leaf-function) cluster.
 *
 * iOS path: a pre-pass over CpuSample[] picks `dominantFunction`, normalises the
 * thread, and emits one row per sample (weightNs = the sample's weight); rows
 * sharing (dominantFunction, thread) are grouped here.
 *
 * Android path: PerfettoSQL returns one row per (thread, leaf_function) with
 * sample_count + SQL-computed bursts, expanded into one row with precomputed
 * burst/first/last/count and an empty `timestampsNs`. When the `precomputed*`
 * fields are set the aggregator skips the timestamp-derived block entirely.
 * rationale: utils/android-profiler/PIPELINE_DESIGN.md "2. The shared aggregator hoist"
 */
export interface AggregatorInputRow {
  /** Pre-picked dominant function. Caller is responsible for selecting it. */
  dominantFunction: string;
  /**
   * Android-only: the mapping (loaded object) the dominant leaf lives in
   * (`/kernel`, `/system/lib64/*.so`, …). Carried through to the emitted
   * CpuHotspot for classifyNativeFrame. iOS leaves this undefined.
   */
  dominantMapping?: string;
  /** Pre-normalised thread name (Main Thread / JS/Hermes / ...). */
  thread: string;
  /** CPU weight in nanoseconds. */
  weightNs: number;
  /** Timestamps of the underlying samples (for burst windowing + hang overlap). */
  timestampsNs: number[];
  /** App-level call chains observed in this group, with sample counts. */
  callChains: { chain: string[]; count: number }[];
  /**
   * Precomputed burst windows (Android, SQL-side), trace-relative ms. When set,
   * the aggregator uses these instead of deriving bursts from `timestampsNs`.
   */
  precomputedBursts?: { startMs: number; endMs: number; sampleCount: number }[];
  /** Precomputed first-sample time (trace-relative ms). Pairs with precomputedBursts. */
  firstMs?: number;
  /** Precomputed last-sample time (trace-relative ms). Pairs with precomputedBursts. */
  lastMs?: number;
  /** Precomputed sample count. Pairs with precomputedBursts. */
  sampleCount?: number;
}

export interface AggregatorOptions {
  platform: "ios" | "android";
  /** Timestamps that fell inside a UI hang window — used to set `duringHang`. */
  hangSampleTimestamps?: Set<number>;
}

/**
 * Group AggregatorInputRow[] by (dominantFunction, thread), apply severity
 * banding (>15% RED, 3-15% YELLOW), drop everything below MIN_WEIGHT_PERCENTAGE,
 * and emit one CpuHotspot per surviving group. Burst windowing operates on the
 * union of all rows in the group.
 */
export function aggregateCpuHotspots(
  rows: AggregatorInputRow[],
  options: AggregatorOptions
): CpuHotspot[] {
  if (rows.length === 0) return [];
  const { platform, hangSampleTimestamps = new Set<number>() } = options;

  interface Acc {
    sampleCount: number;
    totalWeightNs: number;
    timestamps: number[];
    chainCounts: Map<string, { chain: string[]; count: number }>;
    thread: string;
    /**
     * Mapping of the group's dominant leaf (Android). Invariant per
     * dominantFunction (which is part of the group key), so the first row's
     * value is the group's value. Undefined on iOS.
     */
    dominantMapping?: string;
    /** True once any contributing row carried precomputed bursts (Android). */
    precomputed: boolean;
    precomputedBursts: { startMs: number; endMs: number; sampleCount: number }[];
    firstMs: number;
    lastMs: number;
  }

  const groups = new Map<string, Acc>();
  let totalWeightNs = 0;

  for (const row of rows) {
    const key = `${row.dominantFunction}|||${row.thread}`;
    const isPre = row.precomputedBursts !== undefined;
    const existing = groups.get(key);
    if (existing) {
      existing.totalWeightNs += row.weightNs;
      if (isPre) {
        existing.precomputed = true;
        existing.sampleCount += row.sampleCount ?? 0;
        existing.precomputedBursts.push(...(row.precomputedBursts ?? []));
        if (row.firstMs !== undefined) existing.firstMs = Math.min(existing.firstMs, row.firstMs);
        if (row.lastMs !== undefined) existing.lastMs = Math.max(existing.lastMs, row.lastMs);
      } else {
        existing.sampleCount += row.timestampsNs.length;
        existing.timestamps.push(...row.timestampsNs);
      }
      for (const { chain, count } of row.callChains) {
        const chainKey = chain.join(" > ");
        const cc = existing.chainCounts.get(chainKey);
        if (cc) {
          cc.count += count;
        } else {
          existing.chainCounts.set(chainKey, { chain, count });
        }
      }
    } else {
      const chainCounts = new Map<string, { chain: string[]; count: number }>();
      for (const { chain, count } of row.callChains) {
        chainCounts.set(chain.join(" > "), { chain, count });
      }
      groups.set(key, {
        sampleCount: isPre ? (row.sampleCount ?? 0) : row.timestampsNs.length,
        totalWeightNs: row.weightNs,
        timestamps: isPre ? [] : [...row.timestampsNs],
        chainCounts,
        thread: row.thread,
        dominantMapping: row.dominantMapping,
        precomputed: isPre,
        precomputedBursts: isPre ? [...(row.precomputedBursts ?? [])] : [],
        firstMs: isPre ? (row.firstMs ?? 0) : 0,
        lastMs: isPre ? (row.lastMs ?? 0) : 0,
      });
    }
    totalWeightNs += row.weightNs;
  }

  if (totalWeightNs === 0) return [];

  const results: CpuHotspot[] = [];
  for (const [key, acc] of groups) {
    const weightPercentage = (acc.totalWeightNs / totalWeightNs) * 100;
    if (weightPercentage < MIN_WEIGHT_PERCENTAGE) continue;

    const [dominantFunction] = key.split("|||");

    const sortedChains = [...acc.chainCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    const topCallChain = sortedChains[0]?.chain ?? [];
    const topCallChains = sortedChains.map(({ chain, count }) => ({ chain, count }));

    const duringHang =
      hangSampleTimestamps.size > 0 && acc.timestamps.some((ts) => hangSampleTimestamps.has(ts));

    let firstMs: number;
    let lastMs: number;
    let burstWindows: { startMs: number; endMs: number; sampleCount: number }[];

    if (acc.precomputed) {
      // Android: bursts/first/last were computed SQL-side. Sort by start so
      // the display order matches the timestamp-derived path.
      firstMs = acc.firstMs;
      lastMs = acc.lastMs;
      burstWindows = [...acc.precomputedBursts].sort((a, b) => a.startMs - b.startMs);
    } else {
      // iOS: derive bursts from the raw sample timestamps.
      const sortedTs = [...acc.timestamps].sort((a, b) => a - b);
      firstMs = sortedTs.length > 0 ? Math.round(sortedTs[0]! / 1_000_000) : 0;
      lastMs = sortedTs.length > 0 ? Math.round(sortedTs[sortedTs.length - 1]! / 1_000_000) : 0;

      burstWindows = [];
      if (sortedTs.length > 0) {
        let burstStartNs = sortedTs[0]!;
        let burstEndNs = sortedTs[0]!;
        let burstCount = 1;
        for (let i = 1; i < sortedTs.length; i++) {
          const gapMs = (sortedTs[i]! - burstEndNs) / 1_000_000;
          if (gapMs > BURST_GAP_MS) {
            burstWindows.push({
              startMs: Math.round(burstStartNs / 1_000_000),
              endMs: Math.round(burstEndNs / 1_000_000),
              sampleCount: burstCount,
            });
            burstStartNs = sortedTs[i]!;
            burstEndNs = sortedTs[i]!;
            burstCount = 1;
          } else {
            burstEndNs = sortedTs[i]!;
            burstCount++;
          }
        }
        burstWindows.push({
          startMs: Math.round(burstStartNs / 1_000_000),
          endMs: Math.round(burstEndNs / 1_000_000),
          sampleCount: burstCount,
        });
      }
    }

    results.push({
      type: "cpu_hotspot",
      platform,
      dominantFunction: dominantFunction!,
      totalWeightMs: Math.round(acc.totalWeightNs / 1_000_000),
      weightPercentage: parseFloat(weightPercentage.toFixed(2)),
      sampleCount: acc.sampleCount,
      thread: acc.thread,
      severity: weightPercentage > 15 ? "RED" : "YELLOW",
      topCallChain,
      topCallChains,
      duringHang,
      timeRangeMs: { first: firstMs, last: lastMs },
      burstWindows,
      // Only emit when present (Android). Omitting the key on iOS keeps the iOS
      // hotspot object shape byte-identical to before this change.
      ...(acc.dominantMapping !== undefined ? { dominantMapping: acc.dominantMapping } : {}),
    });
  }

  return results.sort((a, b) => b.weightPercentage - a.weightPercentage);
}
