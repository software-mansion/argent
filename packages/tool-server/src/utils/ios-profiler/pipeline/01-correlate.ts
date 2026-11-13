import type { CpuSample, RawHang, RawLeak, UiHang, MemoryLeak } from "../types";
import { TOOLING_LABEL, findDominantFunction, extractAppCallChain } from "./02-aggregate";
import { isSystemLibraryPath } from "./xml-parser";

const TOP_N_FUNCTIONS = 5;
const TOP_N_CHAINS = 3;

interface CorrelationResult {
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
    // Only the report shows the labels: profiler-stack-query matches the plain names.
    const toolingLabels: Record<string, string> = {};

    for (const sample of windowSamples) {
      const dominant = findDominantFunction(sample.stack);
      if (dominant) {
        funcCounts.set(dominant, (funcCounts.get(dominant) ?? 0) + 1);
      }
      for (const frame of sample.stack) {
        if (frame.tooling) toolingLabels[frame.name] = TOOLING_LABEL[frame.tooling];
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
      ...(Object.keys(toolingLabels).length > 0 ? { toolingLabels } : {}),
      severity,
    };
  });

  return { uiHangs, hangSampleTimestamps };
}

export function classifyHangSeverity(hangType: string): "RED" | "YELLOW" {
  const lower = hangType.toLowerCase();
  if (lower.includes("severe") || lower === "hang") return "RED";
  return "YELLOW";
}

/**
 * How xctrace spells "no responsible frame": it records malloc-stack history only
 * for a target cold-launched under malloc_stack_logging, so an attached capture
 * yields the `<Call stack limit reached>` sentinel (or a missing attribute,
 * parsed as "Unknown") for every leak. A template with the Leaks instrument but no
 * Allocations instrument gives `(null)` as the frame and the library of every leak
 * (measured: `Time Profiler` plus `--instrument Leaks` on a Mac app, 817 of 817 rows).
 */
const UNATTRIBUTED_LEAK_FRAMES = new Set(["", "Unknown", "<Call stack limit reached>", "(null)"]);

export function isLeakAttributed(responsibleFrame: string): boolean {
  return !UNATTRIBUTED_LEAK_FRAMES.has(responsibleFrame.trim());
}

/**
 * Instruments gives the Swift runtime's allocator (`swift_slowAllocTyped` in
 * libswiftCore.dylib) as the responsible frame of a leaked Swift object, also
 * one that the app's own code made, so this library tells nothing about who
 * leaked the object.
 */
const ALLOCATOR_LIBRARIES = new Set(["libswiftCore.dylib"]);

/**
 * Whether the responsible frame of a leak is in a system library: macOS or iOS
 * leaks it by itself, not the app's code. `libraryPaths` gives the path of each
 * binary the trace sampled, by name; a library not in it counts as the app's.
 */
function inSystemLibrary(library: string, libraryPaths: ReadonlyMap<string, string>): boolean {
  if (ALLOCATOR_LIBRARIES.has(library)) return false;
  const libraryPath = libraryPaths.get(library);
  return libraryPath !== undefined && isSystemLibraryPath(libraryPath);
}

/** App leaks first, then the system's own leaks, then the unattributed ones. */
export function leakRank(leak: Pick<MemoryLeak, "attributed" | "systemLibrary">): number {
  if (!leak.attributed) return 2;
  return leak.systemLibrary ? 1 : 0;
}

export function aggregateLeaks(
  rawLeaks: RawLeak[],
  libraryPaths: ReadonlyMap<string, string> = new Map()
): MemoryLeak[] {
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
    .map((g): MemoryLeak => {
      const attributed = isLeakAttributed(g.frame);
      const systemLibrary = attributed && inSystemLibrary(g.library, libraryPaths);
      return {
        type: "memory_leak",
        platform: "ios",
        objectType: g.objectType,
        totalSizeBytes: g.totalSize,
        count: g.count,
        responsibleFrame: g.frame,
        responsibleLibrary: g.library,
        attributed,
        ...(systemLibrary ? { systemLibrary } : {}),
        severity: attributed && !systemLibrary ? "RED" : "YELLOW",
      };
    })
    .sort((a, b) => leakRank(a) - leakRank(b) || b.totalSizeBytes - a.totalSizeBytes);
}
