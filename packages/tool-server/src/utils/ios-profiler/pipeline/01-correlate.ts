import type { CpuSample, RawHang, RawLeak, UiHang, MemoryLeak } from "../types";
import { findDominantFunction, extractAppCallChain } from "./02-aggregate";

// ---------------------------------------------------------------------------
// Hang <-> CPU correlation
// ---------------------------------------------------------------------------

const TOP_N_FUNCTIONS = 5;
const TOP_N_CHAINS = 3;

export interface CorrelationResult {
  uiHangs: UiHang[];
  hangSampleTimestamps: Set<number>;
}

export function correlateHangsWithCpu(
  hangs: RawHang[],
  cpuSamples: CpuSample[]
): CorrelationResult {
  // Sort samples by timestamp for efficient windowing
  const sortedSamples = [...cpuSamples].sort((a, b) => a.timestampNs - b.timestampNs);

  const hangSampleTimestamps = new Set<number>();

  const uiHangs = hangs.map((hang) => {
    const windowStart = hang.startNs;
    const windowEnd = hang.startNs + hang.durationNs;

    // Find CPU samples within the hang window
    const windowSamples = sortedSamples.filter(
      (s) => s.timestampNs >= windowStart && s.timestampNs <= windowEnd
    );

    // Track all sample timestamps that fell in hang windows
    for (const sample of windowSamples) {
      hangSampleTimestamps.add(sample.timestampNs);
    }

    // Count function frequency across all threads in the window
    const funcCounts = new Map<string, number>();
    // Count call chain frequency
    const chainCounts = new Map<string, { chain: string[]; count: number }>();

    for (const sample of windowSamples) {
      const dominant = findDominantFunction(sample.stack);
      if (dominant) {
        funcCounts.set(dominant, (funcCounts.get(dominant) ?? 0) + 1);
      }

      const chain = extractAppCallChain(sample.stack);
      if (chain.length > 0) {
        const chainKey = chain.join(" > ");
        const existing = chainCounts.get(chainKey);
        if (existing) {
          existing.count++;
        } else {
          chainCounts.set(chainKey, { chain, count: 1 });
        }
      }
    }

    // Sort by frequency, take top N
    const suspectedFunctions = [...funcCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N_FUNCTIONS)
      .map(([fn]) => fn);

    // Top call chains by frequency
    const appCallChains = [...chainCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_N_CHAINS)
      .map(({ chain, count }) => ({ chain, sampleCount: count }));

    const durationMs = Math.round(hang.durationNs / 1_000_000);
    const severity = classifyHangSeverity(hang.hangType);

    // Format start time from nanoseconds
    const totalMs = Math.round(hang.startNs / 1_000_000);
    const minutes = Math.floor(totalMs / 60_000);
    const seconds = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;
    const startTimeFormatted = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;

    return {
      type: "ios_ui_hang" as const,
      hangType: hang.hangType,
      durationMs,
      startTimeFormatted,
      suspectedFunctions,
      appCallChains,
      severity,
    };
  });

  return { uiHangs, hangSampleTimestamps };
}

function classifyHangSeverity(hangType: string): "RED" | "YELLOW" {
  const lower = hangType.toLowerCase();
  if (lower.includes("severe") || lower === "hang") return "RED";
  return "YELLOW"; // Microhang
}

// ---------------------------------------------------------------------------
// Leak aggregation
// ---------------------------------------------------------------------------

export function aggregateLeaks(rawLeaks: RawLeak[]): MemoryLeak[] {
  const groups = new Map<
    string,
    { totalSize: number; count: number; frame: string; library: string }
  >();

  for (const leak of rawLeaks) {
    const key = leak.objectType;
    const existing = groups.get(key);
    if (existing) {
      existing.totalSize += leak.sizeBytes * leak.count;
      existing.count += leak.count;
    } else {
      groups.set(key, {
        totalSize: leak.sizeBytes * leak.count,
        count: leak.count,
        frame: leak.responsibleFrame,
        library: leak.responsibleLibrary,
      });
    }
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].totalSize - a[1].totalSize)
    .map(([objectType, g]) => ({
      type: "ios_memory_leak" as const,
      objectType,
      totalSizeBytes: g.totalSize,
      count: g.count,
      responsibleFrame: g.frame,
      responsibleLibrary: g.library,
      severity: "RED" as const,
    }));
}
