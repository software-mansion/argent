import type { CpuSample, CpuHotspot, StackFrame } from "../types";
import { RN_FRAMEWORK_SIGNATURES } from "../config";

const MIN_WEIGHT_PERCENTAGE = 3;

/**
 * Find the dominant (most actionable) function in a stack.
 * Walks the stack from top (leaf) looking for user/third-party frames first,
 * then RN framework internals, skipping system library frames entirely.
 */
export function findDominantFunction(stack: StackFrame[]): string | null {
  if (!stack || stack.length === 0) return null;

  // First pass: prefer user/third-party code (non-system, non-hex, non-RN-framework)
  for (const frame of stack) {
    if (frame.isSystemLibrary) continue;
    if (isHexAddress(frame.name)) continue;
    if (RN_FRAMEWORK_SIGNATURES.some((sig) => frame.name.includes(sig)))
      continue;
    return frame.name;
  }

  // Second pass: RN framework internals (non-system, non-hex)
  for (const frame of stack) {
    if (!frame.isSystemLibrary && !isHexAddress(frame.name)) {
      return frame.name;
    }
  }

  // Fallback: first named frame
  for (const frame of stack) {
    if (!isHexAddress(frame.name)) return frame.name;
  }

  return stack[0]?.name ?? null;
}

function isHexAddress(name: string): boolean {
  return /^0x[0-9a-f]+$/i.test(name);
}

/**
 * Extract all app-level frame names from a stack (like Instruments' "Hide System Libraries").
 */
export function extractAppCallChain(stack: StackFrame[]): string[] {
  return stack
    .filter((f) => !f.isSystemLibrary && !isHexAddress(f.name))
    .map((f) => f.name);
}

// ---------------------------------------------------------------------------
// CPU hotspot aggregation
// ---------------------------------------------------------------------------

interface HotspotAccumulator {
  sampleCount: number;
  totalWeightNs: number;
  /** Track timestamps to check hang overlap */
  timestamps: number[];
  /** Track call chains to find the most common one */
  chainCounts: Map<string, { chain: string[]; count: number }>;
}

export function aggregateCpuHotspots(
  samples: CpuSample[],
  hangSampleTimestamps: Set<number> = new Set(),
): CpuHotspot[] {
  if (samples.length === 0) return [];

  // Group by (dominantFunction, thread)
  const groups = new Map<string, HotspotAccumulator>();
  const threadMap = new Map<string, string>(); // key -> threadFmt
  let totalWeightNs = 0;

  for (const sample of samples) {
    const dominant = findDominantFunction(sample.stack);
    if (!dominant) continue;

    const thread = normalizeThread(sample.threadFmt);
    const key = `${dominant}|||${thread}`;

    const chain = extractAppCallChain(sample.stack);
    const chainKey = chain.join(" > ");

    const existing = groups.get(key);
    if (existing) {
      existing.sampleCount++;
      existing.totalWeightNs += sample.weightNs;
      existing.timestamps.push(sample.timestampNs);
      const chainEntry = existing.chainCounts.get(chainKey);
      if (chainEntry) {
        chainEntry.count++;
      } else {
        existing.chainCounts.set(chainKey, { chain, count: 1 });
      }
    } else {
      const chainCounts = new Map<string, { chain: string[]; count: number }>();
      chainCounts.set(chainKey, { chain, count: 1 });
      groups.set(key, {
        sampleCount: 1,
        totalWeightNs: sample.weightNs,
        timestamps: [sample.timestampNs],
        chainCounts,
      });
      threadMap.set(key, thread);
    }
    totalWeightNs += sample.weightNs;
  }

  if (totalWeightNs === 0) return [];

  const results: CpuHotspot[] = [];
  for (const [key, acc] of groups) {
    const weightPercentage = (acc.totalWeightNs / totalWeightNs) * 100;
    if (weightPercentage < MIN_WEIGHT_PERCENTAGE) continue;

    const [dominantFunction, thread] = key.split("|||");

    // Find top 3 most common call chains
    const sortedChains = [...acc.chainCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    const topCallChain = sortedChains[0]?.chain ?? [];
    const topCallChains = sortedChains.map(({ chain, count }) => ({ chain, count }));

    // Check if any sample in this group occurred during a hang
    const duringHang = acc.timestamps.some((ts) =>
      hangSampleTimestamps.has(ts),
    );

    // Compute time range and burst windows from timestamps
    const sortedTs = [...acc.timestamps].sort((a, b) => a - b);
    const firstMs = sortedTs.length > 0 ? Math.round(sortedTs[0]! / 1_000_000) : 0;
    const lastMs = sortedTs.length > 0 ? Math.round(sortedTs[sortedTs.length - 1]! / 1_000_000) : 0;

    const BURST_GAP_MS = 500;
    const burstWindows: { startMs: number; endMs: number; sampleCount: number }[] = [];
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

    results.push({
      type: "ios_cpu_hotspot",
      dominantFunction: dominantFunction!,
      totalWeightMs: Math.round(acc.totalWeightNs / 1_000_000),
      weightPercentage: parseFloat(weightPercentage.toFixed(2)),
      sampleCount: acc.sampleCount,
      thread: thread!,
      severity: weightPercentage > 15 ? "RED" : "YELLOW",
      topCallChain,
      topCallChains,
      duringHang,
      timeRangeMs: { first: firstMs, last: lastMs },
      burstWindows,
    });
  }

  return results.sort((a, b) => b.weightPercentage - a.weightPercentage);
}

function normalizeThread(threadFmt: string): string {
  if (/main\s*thread/i.test(threadFmt)) return "Main Thread";
  if (/hermes/i.test(threadFmt) || /jsthread/i.test(threadFmt))
    return "JS/Hermes";
  // Strip hex thread id and pid info: "AppName 0x1e4715 (AppName, pid: 55746)" -> "AppName"
  const shortMatch = threadFmt.match(/^(.+?)\s+0x/);
  if (shortMatch) return shortMatch[1];
  return threadFmt;
}
