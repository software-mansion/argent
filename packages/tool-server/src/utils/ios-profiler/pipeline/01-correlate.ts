import type { CpuSample, RawHang, RawLeak, UiHang, MemoryLeak } from "../types";
import { findDominantFunction, extractAppCallChain } from "./02-aggregate";

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
  const sortedSamples = [...cpuSamples].sort((a, b) => a.timestampNs - b.timestampNs);

  const hangSampleTimestamps = new Set<number>();

  const uiHangs = hangs.map((hang) => {
    const windowStart = hang.startNs;
    const windowEnd = hang.startNs + hang.durationNs;

    const windowSamples = sortedSamples.filter(
      (s) => s.timestampNs >= windowStart && s.timestampNs <= windowEnd
    );

    for (const sample of windowSamples) {
      hangSampleTimestamps.add(sample.timestampNs);
    }

    const funcCounts = new Map<string, number>();
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

    const suspectedFunctions = [...funcCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N_FUNCTIONS)
      .map(([fn]) => fn);

    const appCallChains = [...chainCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_N_CHAINS)
      .map(({ chain, count }) => ({ chain, sampleCount: count }));

    const durationMs = Math.round(hang.durationNs / 1_000_000);
    const severity = classifyHangSeverity(hang.hangType);

    const totalMs = Math.round(hang.startNs / 1_000_000);
    const minutes = Math.floor(totalMs / 60_000);
    const seconds = Math.floor((totalMs % 60_000) / 1000);
    const ms = totalMs % 1000;
    const startTimeFormatted = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;

    return {
      type: "ui_hang" as const,
      platform: "ios" as const,
      hangType: hang.hangType,
      durationMs,
      startTimeFormatted,
      startNs: hang.startNs,
      endNs: hang.startNs + hang.durationNs,
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
  return "YELLOW";
}

/**
 * How xctrace spells "no responsible frame": it records malloc-stack history only
 * for a target cold-launched under malloc_stack_logging, so an attached capture
 * yields the `<Call stack limit reached>` sentinel (or a missing attribute,
 * parsed as "Unknown") for every leak.
 */
const UNATTRIBUTED_LEAK_FRAMES = new Set(["", "Unknown", "<Call stack limit reached>"]);

export function isLeakAttributed(responsibleFrame: string): boolean {
  return !UNATTRIBUTED_LEAK_FRAMES.has(responsibleFrame.trim());
}

export function aggregateLeaks(rawLeaks: RawLeak[]): MemoryLeak[] {
  const groups = new Map<
    string,
    { objectType: string; totalSize: number; count: number; frame: string; library: string }
  >();

  for (const leak of rawLeaks) {
    // Keyed on object type AND responsible frame: one type can leak from several
    // call sites, each its own finding. The frame is normalized the way
    // isLeakAttributed() matches it so an export mixing the unattributed spellings
    // for one type still yields a single unattributed group.
    // The NUL delimiter is written as the `\u0000` escape because a raw NUL byte
    // would make git treat this file as binary; types and frames never contain one.
    const frameKey = isLeakAttributed(leak.responsibleFrame) ? leak.responsibleFrame.trim() : "";
    const key = `${leak.objectType}\u0000${frameKey}`;
    const existing = groups.get(key);
    if (existing) {
      existing.totalSize += leak.sizeBytes * leak.count;
      existing.count += leak.count;
    } else {
      groups.set(key, {
        objectType: leak.objectType,
        totalSize: leak.sizeBytes * leak.count,
        count: leak.count,
        frame: leak.responsibleFrame,
        library: leak.responsibleLibrary,
      });
    }
  }

  return [...groups.values()]
    .map((g) => {
      const attributed = isLeakAttributed(g.frame);
      return {
        type: "memory_leak" as const,
        platform: "ios" as const,
        objectType: g.objectType,
        totalSizeBytes: g.totalSize,
        count: g.count,
        responsibleFrame: g.frame,
        responsibleLibrary: g.library,
        attributed,
        severity: (attributed ? "RED" : "YELLOW") as "RED" | "YELLOW",
      };
    })
    .sort((a, b) =>
      a.attributed === b.attributed ? b.totalSizeBytes - a.totalSizeBytes : a.attributed ? -1 : 1
    );
}
