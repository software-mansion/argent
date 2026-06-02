import type { CpuSample, CpuHotspot, StackFrame } from "../types";
import { RN_FRAMEWORK_SIGNATURES } from "../config";
import {
  aggregateCpuHotspots as aggregateCpuHotspotsShared,
  type AggregatorInputRow,
} from "../../profiler-shared/aggregate";
import { normalizeThreadName } from "../../profiler-shared/thread";

/**
 * Find the dominant (most actionable) function in a stack: walk from the leaf,
 * preferring user/third-party frames, then RN framework internals, skipping
 * system libraries. iOS-only pre-pass — Android SQL returns the leaf pre-picked.
 */
export function findDominantFunction(stack: StackFrame[]): string | null {
  if (!stack || stack.length === 0) return null;

  // First pass: prefer user/third-party code (non-system, non-hex, non-RN-framework)
  for (const frame of stack) {
    if (frame.isSystemLibrary) continue;
    if (isHexAddress(frame.name)) continue;
    if (RN_FRAMEWORK_SIGNATURES.some((sig) => frame.name.includes(sig))) continue;
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
  return stack.filter((f) => !f.isSystemLibrary && !isHexAddress(f.name)).map((f) => f.name);
}

/**
 * iOS CPU hotspot aggregation: pre-pass raw CpuSample[] into the shared
 * AggregatorInputRow[] shape (one row per sample, dominant function picked,
 * thread normalised), then delegate to the shared aggregator.
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
