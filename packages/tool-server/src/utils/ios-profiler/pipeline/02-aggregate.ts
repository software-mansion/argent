import type { CpuSample, CpuHotspot, StackFrame } from "../types";
import { RN_FRAMEWORK_SIGNATURES, type ToolingOwner } from "../config";
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
function findDominantFrame(stack: StackFrame[]): StackFrame | null {
  if (!stack || stack.length === 0) return null;

  for (const frame of stack) {
    if (frame.isSystemLibrary) continue;
    if (isHexAddress(frame.name)) continue;
    if (RN_FRAMEWORK_SIGNATURES.some((sig) => frame.name.includes(sig))) continue;
    return frame;
  }

  for (const frame of stack) {
    if (!frame.isSystemLibrary && !isHexAddress(frame.name)) {
      return frame;
    }
  }

  for (const frame of stack) {
    if (!isHexAddress(frame.name)) return frame;
  }

  return stack[0] ?? null;
}

export function findDominantFunction(stack: StackFrame[]): string | null {
  return findDominantFrame(stack)?.name ?? null;
}

/**
 * The tool that runs in the sample, or null for the app's own work: the tool of
 * a frame from the leaf up to the most actionable frame. A sample of argent's
 * describe or tap, or of the recorder that Instruments injects (its frames often
 * have no symbol, below an allocation of the app), is not a cost of the app.
 */
export function toolingWork(stack: StackFrame[]): ToolingOwner | null {
  const dominant = findDominantFrame(stack);
  for (const frame of stack) {
    if (frame.tooling) return frame.tooling;
    if (frame === dominant) break;
  }
  return null;
}

/** What the report adds to the name of a function in a tool's library. */
export const TOOLING_LABEL: Record<ToolingOwner, string> = {
  argent: "argent's own library",
  instruments: "Instruments' own library",
};

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
  let toolingNs = 0;
  for (const sample of samples) {
    // A tool's work is reported once, as a total (see toolingWeightNs), but it
    // stays in the CPU time that each hotspot is a share of.
    if (toolingWork(sample.stack)) {
      toolingNs += sample.weightNs;
      continue;
    }
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
    excludedWeightNs: toolingNs,
  });
}

/** CPU weight of the samples that are a tool's work (toolingWork), by tool. */
export function toolingWeightNs(samples: CpuSample[]): Record<ToolingOwner, number> {
  const total: Record<ToolingOwner, number> = { argent: 0, instruments: 0 };
  for (const sample of samples) {
    const owner = toolingWork(sample.stack);
    if (owner) total[owner] += sample.weightNs;
  }
  return total;
}
