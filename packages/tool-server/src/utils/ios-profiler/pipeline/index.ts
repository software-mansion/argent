import { promises as fs } from "fs";
import type { Bottleneck, CpuSample, UiHang, CpuHotspot, MemoryLeak, RawLeak } from "../types";
import { isSystemLibraryPath, parseCpuFile, parseHangsFile, parseLeaksFile } from "./xml-parser";
import { correlateHangsWithCpu, aggregateLeaks, isLeakAttributed } from "./01-correlate";
import { aggregateCpuHotspots, toolingWeightNs, withAppCallsThroughArgent } from "./02-aggregate";
import { SIMULATOR_RUNTIME_PATH_SEGMENT } from "../config";
import {
  removeSuspendedTime,
  withoutSuspendedTime,
  type AppSuspensionSpan,
  type SuspensionAdjustment,
} from "../app-suspensions";
import { recorderNsIn, type RecorderAdjustment } from "../recorder-hangs";

interface PipelineOutput {
  bottlenecks: Bottleneck[];
  cpuSamples: CpuSample[];
  uiHangs: UiHang[];
  cpuHotspots: CpuHotspot[];
  memoryLeaks: MemoryLeak[];
  /** Whether the leaks export holds the trace's Leaks detail, also when it has no row. */
  leaksDetailExported?: boolean;
  /** CPU time of the libraries argent and Instruments load into the app, which the hotspots leave out. */
  toolingCpuMs: { argent: number; instruments: number };
  /** CPU time of the samples with a stack, the tools' included: what the hotspot shares are of. */
  totalCpuMs: number;
  /** What the app's suspensions changed in the hangs. Null when none were passed. */
  suspensionAdjustment?: SuspensionAdjustment | null;
  /** What Instruments' recorder changed in the hangs. */
  recorderAdjustment?: RecorderAdjustment;
}

interface PipelineOptions {
  /**
   * Keep only the CPU samples and hangs of this PID. Set by the all-processes strategy,
   * whose capture is host-wide; null for the device strategy, already scoped by `--attach`.
   */
  cpuFilterPid?: number | null;
  /**
   * Mac apps and iOS simulator apps: when macOS held the app suspended, on the
   * trace's timeline. Their time is taken out of the hangs. Null or absent takes
   * no suspended time out.
   */
  appSuspensions?: AppSuspensionSpan[] | null;
  /**
   * The trace is of a Mac app: the libraries of its OS are those of this Mac, also when
   * the trace sampled none of them (a template without Time Profiler, or no CPU export).
   */
  macApp?: boolean;
}

/** Where an app keeps its frameworks: a Mac app in `Contents/Frameworks`, an iOS app in `Frameworks`. */
const APP_FRAMEWORK_DIRS = ["/Contents/Frameworks/", "/Frameworks/"];
const OS_FRAMEWORK_DIRS = ["/System/Library/Frameworks/", "/System/Library/PrivateFrameworks/"];
/** The bundle of an app's binary: its executable or one of its frameworks. */
const APP_BUNDLE_BINARY = /^(.+?\.app)\/(?:Contents\/(?:MacOS|Frameworks)\/|Frameworks\/|[^/]+$)/;
/** Where a simulator runtime keeps the file system of its OS. */
const RUNTIME_ROOT = "/Contents/Resources/RuntimeRoot";

/**
 * The path of each responsible library of the attributed leaks, by name. A leak
 * names only the library: its path is that of the binary in the CPU samples. A
 * framework that the trace did not sample is the app's when the app's bundle has
 * it, and the OS's when the OS of the trace has it. Measured on a Mac app:
 * AppIntents and LinkServices leaked objects, and the CPU export had neither.
 */
async function leakLibraryPaths(
  rawLeaks: RawLeak[],
  cpuSamples: CpuSample[],
  macApp: boolean
): Promise<Map<string, string>> {
  const libraries = new Set(
    rawLeaks
      .filter((leak) => isLeakAttributed(leak.responsibleFrame))
      .map((leak) => leak.responsibleLibrary)
      .filter((name) => /^[^/]+$/.test(name) && !name.startsWith("."))
  );
  if (libraries.size === 0) return new Map();
  const paths = new Map<string, string>();
  for (const sample of cpuSamples) {
    for (const frame of sample.stack) {
      if (frame.library && frame.libraryPath && !paths.has(frame.library)) {
        paths.set(frame.library, frame.libraryPath);
      }
    }
  }
  const bundles = new Set<string>();
  for (const path of paths.values()) {
    const bundle = isSystemLibraryPath(path) ? null : APP_BUNDLE_BINARY.exec(path)?.[1];
    if (bundle) bundles.add(bundle);
  }
  const osRoot = traceOsRoot(paths.values()) ?? (macApp ? "" : null);
  // The app's bundles first: a framework of the app can have the name of one of the OS.
  const frameworkDirs = [
    ...[...bundles].flatMap((bundle) => APP_FRAMEWORK_DIRS.map((dir) => bundle + dir)),
    ...(osRoot === null ? [] : OS_FRAMEWORK_DIRS.map((dir) => osRoot + dir)),
  ];
  for (const name of libraries) {
    if (paths.has(name)) continue;
    for (const dir of frameworkDirs) {
      if (await exists(`${dir}${name}.framework`)) {
        paths.set(name, `${dir}${name}.framework`);
        break;
      }
    }
  }
  return paths;
}

/**
 * The root of the OS whose libraries the trace sampled: the simulator runtime's
 * for an iOS app, "" (this Mac) for a Mac app. Null when the trace sampled no
 * library of either: for an iOS app, the frameworks of this Mac are not those of its OS.
 */
function traceOsRoot(binaryPaths: Iterable<string>): string | null {
  let onThisMac = false;
  for (const path of binaryPaths) {
    const runtime = path.indexOf(SIMULATOR_RUNTIME_PATH_SEGMENT);
    const root = runtime === -1 ? -1 : path.indexOf(`${RUNTIME_ROOT}/`, runtime);
    if (root !== -1) return path.slice(0, root + RUNTIME_ROOT.length);
    if (path.startsWith("/System/Library/")) onThisMac = true;
  }
  return onThisMac ? "" : null;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runIosProfilerPipeline(
  files: Record<string, string | null>,
  options: PipelineOptions = {}
): Promise<PipelineOutput> {
  const [cpuSamples, rawHangs, { leaks: rawLeaks, detailExported }] = await Promise.all([
    parseCpuFile(files.cpu ?? null, options.cpuFilterPid ?? null),
    parseHangsFile(files.hangs ?? null, options.cpuFilterPid ?? null),
    parseLeaksFile(files.leaks ?? null),
  ]);
  for (const sample of cpuSamples) sample.stack = withAppCallsThroughArgent(sample.stack);

  // Before the CPU correlation: the samples of a hang left out must not mark hotspots as during a hang.
  const kept = removeSuspendedTime(
    rawHangs,
    options.appSuspensions ?? [],
    recorderNsIn(rawHangs, cpuSamples)
  );
  // A trace with leak data checked the app for leaks. Without the app's suspensions, the
  // length of a hang can hold the pause of a check.
  const leakPausesUnknown =
    options.appSuspensions == null && (rawLeaks.length > 0 || detailExported);
  const correlated = correlateHangsWithCpu(
    kept.hangs,
    cpuSamples,
    kept.hangs.map((_, i) => kept.suspendedNs[i]! + kept.recorderNs[i]!),
    leakPausesUnknown
  );
  const { hangSampleTimestamps } = correlated;
  const uiHangs = correlated.uiHangs.map((hang, i) =>
    withoutSuspendedTime(hang, kept.suspendedNs[i]!, kept.recorderNs[i]!)
  );

  const cpuHotspots = aggregateCpuHotspots(cpuSamples, hangSampleTimestamps);
  const memoryLeaks = aggregateLeaks(
    rawLeaks,
    await leakLibraryPaths(rawLeaks, cpuSamples, options.macApp ?? false)
  );

  const bottlenecks: Bottleneck[] = [...cpuHotspots, ...uiHangs, ...memoryLeaks];

  const totalNs = cpuSamples.reduce((sum, s) => sum + (s.stack.length > 0 ? s.weightNs : 0), 0);
  const tooling = toolingWeightNs(cpuSamples);
  return {
    bottlenecks,
    cpuSamples,
    uiHangs,
    cpuHotspots,
    memoryLeaks,
    leaksDetailExported: detailExported,
    toolingCpuMs: {
      argent: Math.round(tooling.argent / 1_000_000),
      instruments: Math.round(tooling.instruments / 1_000_000),
    },
    totalCpuMs: Math.round(totalNs / 1_000_000),
    suspensionAdjustment: options.appSuspensions != null ? kept.summary : null,
    recorderAdjustment: kept.recorderSummary,
  };
}
