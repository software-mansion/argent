import type { CpuSample, RawHang, RawLeak, UiHang, MemoryLeak } from "../types";
import {
  TOOLING_LABEL,
  findDominantFunction,
  extractAppCallChain,
  isEntryPoint,
  isSystemCodeSample,
  toolingWork,
} from "./02-aggregate";
import { isSystemLibraryPath } from "./xml-parser";
import { normalizeThreadName } from "../../profiler-shared/thread";

/** What the report adds to a suspect when only system code did the work under it. */
const SYSTEM_CODE_LABEL = "the app's entry point, with only system code below it";
const SYSTEM_ONLY_LABEL = "system code, with no function of the app in its stacks";

const TOP_N_FUNCTIONS = 5;
const TOP_N_CHAINS = 3;
/** A hang's thread that ran for less than this share of the hang mostly waited during it. */
const MIN_HANG_THREAD_RUN_SHARE = 0.1;

interface CorrelationResult {
  uiHangs: UiHang[];
  hangSampleTimestamps: Set<number>;
}

/**
 * `excludedNs` is the time of each hang that is not the hang's own: when the app was
 * suspended, and Instruments' recorder (removeSuspendedTime). The report leaves it out of
 * the hang's length. `leakPausesUnknown`: the trace checked the app for leaks, and when
 * the app was suspended is not known, so a hang's length can hold a check's pause.
 */
export function correlateHangsWithCpu(
  hangs: RawHang[],
  cpuSamples: CpuSample[],
  excludedNs: readonly number[] = [],
  leakPausesUnknown = false
): CorrelationResult {
  const sortedSamples = [...cpuSamples].sort((a, b) => a.timestampNs - b.timestampNs);
  const sampleThreads = new Set(sortedSamples.map((s) => normalizeThreadName(s.threadFmt)));

  const hangSampleTimestamps = new Set<number>();

  const uiHangs = hangs.map((hang, hangIndex) => {
    const windowStart = hang.startNs;
    const windowEnd = hang.startNs + hang.durationNs;

    const allThreads = sortedSamples.filter(
      (s) => s.timestampNs >= windowStart && s.timestampNs <= windowEnd
    );

    for (const sample of allThreads) {
      hangSampleTimestamps.add(sample.timestampNs);
    }

    // A hang is a stall of one thread, the main thread in Instruments' hangs. Work on another
    // thread at the same time did not stall it, so the suspects and call chains come from the
    // samples of the hang's thread in the hang. A thread that ran for less than 10% of the
    // hang mostly waited, so then the suspects are what all threads ran. When other threads
    // ran, it possibly waited for a worker that it called with dispatch_sync. When no other
    // thread ran, it possibly waited in a sleep, for a lock or for I/O, and the suspects are
    // what it ran. The recorder's time is not the hang's, so its samples are no thread's run.
    const hangThread = normalizeThreadName(hang.threadFmt);
    const ownThread = allThreads.filter((s) => normalizeThreadName(s.threadFmt) === hangThread);
    const ownRunNs = ownThread.reduce(
      (sum, s) => (toolingWork(s.stack) === "instruments" ? sum : sum + s.weightNs),
      0
    );
    const ownLengthNs = hang.durationNs - (excludedNs[hangIndex] ?? 0);
    // A thread with no sample in the whole trace can have another name in the samples (the
    // hang's thread is then not the main thread), so how long it ran is not known.
    const waited =
      sampleThreads.has(hangThread) && ownRunNs < ownLengthNs * MIN_HANG_THREAD_RUN_SHARE;
    const otherThreadsRan = allThreads.some(
      (s) =>
        toolingWork(s.stack) !== "instruments" && normalizeThreadName(s.threadFmt) !== hangThread
    );
    const windowSamples = waited || ownThread.length === 0 ? allThreads : ownThread;

    const funcCounts = new Map<string, number>();
    const chainCounts = new Map<string, { chain: string[]; count: number }>();
    // Only the report shows the labels: profiler-stack-query matches the plain names.
    const toolingLabels: Record<string, string> = {};

    for (const sample of windowSamples) {
      // The recorder's time is the hang's recorderMs (recorder-hangs.ts), not a suspect: its
      // frames often have no symbol, so its dominant frame is the app function that allocated.
      if (toolingWork(sample.stack) === "instruments") continue;
      const dominant = findDominantFunction(sample.stack);
      if (dominant) {
        funcCounts.set(dominant, (funcCounts.get(dominant) ?? 0) + 1);
        if (isSystemCodeSample(sample.stack)) {
          toolingLabels[dominant] = isEntryPoint(dominant) ? SYSTEM_CODE_LABEL : SYSTEM_ONLY_LABEL;
        }
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
      ...(waited
        ? {
            hangThreadRanMs: Math.round(ownRunNs / 1_000_000),
            ...(otherThreadsRan ? { suspectsFromOtherThreads: true } : {}),
            ...(leakPausesUnknown ? { mayHoldLeakCheck: true } : {}),
          }
        : {}),
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
 * How xctrace spells "no responsible frame": it records the malloc-stack history
 * of objects allocated before the start only for a target cold-launched under
 * malloc_stack_logging, so an attached capture yields the `<Call stack limit
 * reached>` sentinel (or a missing attribute, parsed as "Unknown") for every leak
 * of such an object. A template with the Leaks instrument but no
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
