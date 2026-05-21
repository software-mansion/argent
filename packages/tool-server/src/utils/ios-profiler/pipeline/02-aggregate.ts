import type { CpuSample, CpuHotspot, StackFrame } from "../types";
import { RN_FRAMEWORK_SIGNATURES } from "../config";
import {
  aggregateCpuHotspots as aggregateCpuHotspotsShared,
  type AggregatorInputRow,
} from "../../profiler-shared/aggregate";

/**
 * Find the dominant (most actionable) function in a stack.
 * Walks the stack from top (leaf) looking for user/third-party frames first,
 * then RN framework internals, skipping system library frames entirely.
 *
 * iOS-only: this 3-tier picker reads StackFrame.isSystemLibrary, which the
 * xctrace XML parser populates. The Android SQL already returns the leaf
 * function pre-picked at the SQL level, so this is iOS pre-pass code.
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

function normalizeThread(threadFmt: string): string {
  if (/main\s*thread/i.test(threadFmt)) return "Main Thread";
  if (/hermes/i.test(threadFmt) || /jsthread/i.test(threadFmt)) return "JS/Hermes";
  // Strip hex thread id and pid info: "AppName 0x1e4715 (AppName, pid: 55746)" -> "AppName"
  const shortMatch = threadFmt.match(/^(.+?)\s+0x/);
  if (shortMatch) return shortMatch[1];
  return threadFmt;
}

/**
 * iOS CPU hotspot aggregation. Pre-passes the raw CpuSample[] into the shared
 * AggregatorInputRow[] shape (one row per sample with the dominant function
 * picked and thread normalised), then delegates to the shared aggregator.
 *
 * Re-exports findDominantFunction / extractAppCallChain for the iOS correlator,
 * which uses them to pick per-hang suspected functions and chains.
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
    const thread = normalizeThread(sample.threadFmt);
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
