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

/**
 * The app's entry point: `main`, the `$main()` of a Swift `@main` type, or the stub that
 * calls it in a debug build. The main run loop runs under it, so it is in every stack of
 * the main thread, also when only system code (drawing, layout, animation) runs.
 */
export function isEntryPoint(name: string): boolean {
  return (
    name === "main" ||
    name === "__debug_main_executable_dylib_entry_point" ||
    /(^|\.)\$main\(\)/.test(name)
  );
}

/**
 * A frame of the app: outside the system, with a symbol or at least a binary. A frame with
 * neither is not known to be the app's.
 */
function isAppFrame(frame: StackFrame): boolean {
  return !frame.isSystemLibrary && (!isHexAddress(frame.name) || frame.library !== undefined);
}

/**
 * The frame that a sample's CPU time is reported under: findDominantFrame, but the app's
 * entry point only when no other app frame is below it (a frame of React Native there is
 * more actionable than `main`), and the root of the stack (such as `start_wqthread`) when
 * no frame is the app's, not a system function picked from the middle of it.
 *
 * `systemCode` is, for a sample of system code, the named system frames that did the work,
 * and null for any other sample. No function of the app did the work of such a sample:
 * either the app's entry point is the only app frame, with a named system frame below it,
 * or no frame is the app's.
 */
function reportedFrame(
  stack: StackFrame[]
): { frame: StackFrame; systemCode: StackFrame[] | null } | null {
  const dominant = findDominantFrame(stack);
  if (dominant === null) return null;
  if (!stack.some(isAppFrame)) {
    const named = stack.filter((f) => !isHexAddress(f.name));
    return {
      frame: named[named.length - 1] ?? dominant,
      systemCode: named.length > 0 ? named : null,
    };
  }
  if (!isEntryPoint(dominant.name)) return { frame: dominant, systemCode: null };
  const below = stack.slice(0, stack.indexOf(dominant));
  const appBelow = below.find(
    (f) => !f.isSystemLibrary && !isHexAddress(f.name) && !isEntryPoint(f.name)
  );
  if (appBelow) return { frame: appBelow, systemCode: null };
  const named = below.filter((f) => !isHexAddress(f.name));
  const systemCode = !below.some(isAppFrame) && named.some((f) => f.isSystemLibrary);
  return { frame: dominant, systemCode: systemCode ? named : null };
}

export function findDominantFunction(stack: StackFrame[]): string | null {
  return reportedFrame(stack)?.frame.name ?? null;
}

/** Whether only system code did the work of the sample (see reportedFrame). */
export function isSystemCodeSample(stack: StackFrame[]): boolean {
  return reportedFrame(stack)?.systemCode != null;
}

/**
 * The system framework that a sample of system code ran in: the first framework from the
 * leaf, so that a runtime library (libobjc, libsystem_*, libswiftCore) counts for the
 * framework that called it. The leaf's library when no frame is in a framework.
 */
function systemFrameworkOf(below: StackFrame[]): string {
  const isFramework = (lib: string | undefined) => lib !== undefined && !/^lib.*\.dylib$/.test(lib);
  return (
    below.find((f) => f.isSystemLibrary && isFramework(f.library))?.library ??
    below[0]?.library ??
    "unknown library"
  );
}

/** At most this many frameworks are named for a hotspot of system code. */
const MAX_SYSTEM_FRAMEWORKS = 5;

/**
 * The tool that runs in the sample, or null for the app's own work: the tool of
 * a frame from the leaf up to the most actionable frame. A sample of argent's
 * describe or tap, or of the recorder that Instruments injects (its frames often
 * have no symbol, below an allocation of the app), is not a cost of the app.
 * In a stack with no named frame outside the system, such as one on a thread of
 * the system or of the recorder, a tool's frame anywhere names the tool.
 */
export function toolingWork(stack: StackFrame[]): ToolingOwner | null {
  const dominant = findDominantFrame(stack);
  const named = dominant !== null && !dominant.isSystemLibrary && !isHexAddress(dominant.name);
  for (const frame of stack) {
    if (frame.tooling) return frame.tooling;
    if (frame === dominant && named) break;
  }
  return null;
}

/**
 * argent's library replaces some methods of the system with its own, which call the
 * original (window ordering is one). When the app calls such a method, the work that
 * argent's frame calls is the app's. argent's own work, such as describe and taps, is a
 * block or function that the run loop, a dispatch queue or an event monitor calls, or runs
 * on a thread with no app frame.
 *
 * Returns the stack with argent's frames marked as system frames when the app called
 * through them, else the same stack.
 */
export function withAppCallsThroughArgent(stack: StackFrame[]): StackFrame[] {
  let outermost = -1;
  stack.forEach((frame, i) => {
    if (frame.tooling === "argent") outermost = i;
  });
  if (outermost === -1) return stack;
  const callers = stack.slice(outermost + 1).filter((frame) => !isHexAddress(frame.name));
  const isApp = (frame: StackFrame) => !frame.isSystemLibrary && !frame.tooling;
  // A method of the app or the system called argent's frame, as it calls a method.
  const caller = callers[0];
  const calledAsMethod = caller !== undefined && (isApp(caller) || /^[-+]\[/.test(caller.name));
  if (!calledAsMethod || !callers.some(isApp)) return stack;
  return stack.map((frame) =>
    frame.tooling === "argent" ? { name: frame.name, isSystemLibrary: true } : frame
  );
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
  // By hotspot key: the weight of its samples of system code, in all and by framework.
  const systemCode = new Map<string, { weightNs: number; byFramework: Map<string, number> }>();
  for (const sample of samples) {
    // A tool's work is reported once, as a total (see toolingWeightNs), but it
    // stays in the CPU time that each hotspot is a share of.
    if (toolingWork(sample.stack)) {
      toolingNs += sample.weightNs;
      continue;
    }
    const reported = reportedFrame(sample.stack);
    if (!reported?.frame.name) continue;
    const dominant = reported.frame.name;
    const thread = normalizeThreadName(sample.threadFmt);
    const chain = extractAppCallChain(sample.stack);
    rows.push({
      dominantFunction: dominant,
      thread,
      weightNs: sample.weightNs,
      timestampsNs: [sample.timestampNs],
      callChains: chain.length > 0 ? [{ chain, count: 1 }] : [],
    });
    const below = reported.systemCode;
    if (below) {
      const key = `${dominant}|||${thread}`;
      const acc = systemCode.get(key) ?? { weightNs: 0, byFramework: new Map<string, number>() };
      const framework = systemFrameworkOf(below);
      acc.weightNs += sample.weightNs;
      acc.byFramework.set(framework, (acc.byFramework.get(framework) ?? 0) + sample.weightNs);
      systemCode.set(key, acc);
    }
  }

  const hotspots = aggregateCpuHotspotsShared(rows, {
    platform: "ios",
    hangSampleTimestamps,
    excludedWeightNs: toolingNs,
  });
  return hotspots.map((hotspot) => {
    const acc = systemCode.get(`${hotspot.dominantFunction}|||${hotspot.thread}`);
    // Most of the hotspot, not a rare sample of work in the entry point itself.
    if (!acc || acc.weightNs * 2 <= hotspot.totalWeightMs * 1_000_000) return hotspot;
    const frameworks = [...acc.byFramework.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SYSTEM_FRAMEWORKS)
      .map(([name, ns]) => ({
        name,
        weightPercentage: Math.round((ns / acc.weightNs) * 100),
      }));
    return { ...hotspot, systemCode: { frameworks } };
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
