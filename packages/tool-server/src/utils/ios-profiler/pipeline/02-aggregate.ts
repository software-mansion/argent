import type { CpuSample, CpuHotspot, StackFrame } from "../types";
import { RN_FRAMEWORK_SIGNATURES } from "../config";
import {
  aggregateCpuHotspots as aggregateCpuHotspotsShared,
  type AggregatorInputRow,
} from "../../profiler-shared/aggregate";
import { normalizeThreadName } from "../../profiler-shared/thread";

/**
 * Most actionable frame in a leaf-first stack: user/third-party code, then RN
 * framework internals, then any named frame. iOS-only pre-pass — the Android
 * SQL path returns the leaf pre-picked.
 */
export function findDominantFunction(stack: StackFrame[]): string | null {
  if (!stack || stack.length === 0) return null;

  for (const frame of stack) {
    if (frame.isSystemLibrary) continue;
    if (isHexAddress(frame.name)) continue;
    if (RN_FRAMEWORK_SIGNATURES.some((sig) => frame.name.includes(sig))) continue;
    return frame.name;
  }

  for (const frame of stack) {
    if (!frame.isSystemLibrary && !isHexAddress(frame.name)) {
      return frame.name;
    }
  }

  for (const frame of stack) {
    if (!isHexAddress(frame.name)) return frame.name;
  }

  return stack[0]?.name ?? null;
}

function isHexAddress(name: string): boolean {
  return /^0x[0-9a-f]+$/i.test(name);
}

/** App-level frames only, like Instruments' "Hide System Libraries". */
export function extractAppCallChain(stack: StackFrame[]): string[] {
  return stack.filter((f) => !f.isSystemLibrary && !isHexAddress(f.name)).map((f) => f.name);
}

/**
 * One AggregatorInputRow per sample (dominant function picked, thread
 * normalised), then delegate to the shared aggregator.
 */
export function aggregateCpuHotspots(
  samples: CpuSample[],
  hangSampleTimestamps: Set<number> = new Set()
): CpuHotspot[] {
  if (samples.length === 0) return [];

  const rows: AggregatorInputRow[] = [];
  for (const sample of samples) {
    const dominant = findDominantFunction(sample.stack);
    if (!dominant) continue;
    const thread = normalizeThreadName(sample.threadFmt);
    const chain = extractAppCallChain(sample.stack);
    rows.push({
      dominantFunction: dominant,
      thread,
      weightNs: sample.weightNs,
      timestampsNs: [sample.timestampNs],
      callChains: chain.length > 0 ? [{ chain, count: 1 }] : [],
    });
  }

  return aggregateCpuHotspotsShared(rows, {
    platform: "ios",
    hangSampleTimestamps,
  });
}
