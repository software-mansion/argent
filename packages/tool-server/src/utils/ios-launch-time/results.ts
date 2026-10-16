/**
 * Pure helpers that turn launch measurements and trace values into the tool
 * results, kept apart from the tools so they test without a device.
 */
import type { XcodeVersion } from "../ios-profiler/capture-strategy/select";

const ms = (ns: number) => Math.round(ns / 100_000) / 10;

interface LaunchSampleStats {
  averageMs: number;
  medianMs: number;
  samplesMs: number[];
  samplesCollected: number;
  dropped: number;
  warning: string | null;
}

/**
 * Average, median and drop count of XCTApplicationLaunchMetric samples, which
 * XCTest reports in seconds. Null without samples.
 */
export function launchSampleStats(
  measurements: number[],
  options: { expected: number; simulator: boolean }
): LaunchSampleStats | null {
  if (measurements.length === 0) return null;
  const samplesCollected = measurements.length;
  const dropped = Math.max(0, options.expected - samplesCollected);
  const sorted = [...measurements].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    averageMs: Math.round(
      (measurements.reduce((sum, value) => sum + value, 0) / samplesCollected) * 1000
    ),
    medianMs: Math.round(median * 1000),
    samplesMs: measurements.map((value) => Math.round(value * 1000)),
    samplesCollected,
    dropped,
    warning:
      dropped > 0
        ? `XCTest dropped ${dropped} of ${options.expected} launch measurements (XCTApplicationLaunchMetric returned no value for some iterations${options.simulator ? "" : "; seen on iOS 18 devices"}). The average uses the remaining samples; rerun for a full set.`
        : null,
  };
}

/**
 * True when an xctrace record log shows the recording started but never
 * finished: "Starting recording" is present and no completion marker follows.
 */
export function stalledAtRecordingStart(log: string): boolean {
  return (
    /starting recording/i.test(log) &&
    !/reached specified time limit|recording completed/i.test(log)
  );
}

/**
 * True for the Xcode versions where `xctrace record --launch` on a simulator
 * stalls after "Starting recording". Verified on 26.4.1 only; Xcode 27.0
 * records normally. This is not the `--device` attach deadlock that
 * `isDegraded` in capture-strategy/select.ts assumes for every version from
 * 26.4 up: that is a different capture mode, so the two bounds differ.
 */
export function stallsSimulatorLaunchRecording(version: XcodeVersion | null): boolean {
  return version?.major === 26 && version.minor === 4;
}

/**
 * Launch end and estimate on a simulator: the first-frame signpost ends the
 * launch, and the estimate runs from the earliest dyld activity to it.
 */
export function simulatorLaunchWindow(
  signpostNs: number | null,
  dyldStartNs: number | null
): { endNs: number | null; simulatorLaunchEstimateMs: number | null; signpostMissing: boolean } {
  return {
    endNs: signpostNs,
    simulatorLaunchEstimateMs:
      signpostNs !== null && dyldStartNs !== null && signpostNs >= dyldStartNs
        ? ms(signpostNs - dyldStartNs)
        : null,
    signpostMissing: signpostNs === null,
  };
}

/**
 * True for the "Initializing - Process Creation" lifecycle phase. The app-period
 * value uses "-" and the narrative "–", so only the suffix is matched.
 */
function isProcessCreation(period: string): boolean {
  return /process creation\s*$/i.test(period);
}

/**
 * launchMs on an iPhone: from the start of dyld to the end of the first frame.
 * `xctrace record --launch` spawns the app suspended while Instruments attaches,
 * and Xcode 26.4 counts that wait in Process Creation, so that phase is skipped.
 * The start is the earliest dyld activity, else the first lifecycle phase that
 * is not Process Creation; a start after `endNs` is not used.
 */
export function deviceLaunchWindow(window: {
  phases: Array<{ startNs: number; period: string }>;
  dyldStartNs: number | null;
  endNs: number | null;
}): {
  launchMs: number | null;
  startNs: number | null;
  startSource: "dyld" | "lifecycle" | null;
  processCreation: boolean;
} {
  const { phases, dyldStartNs, endNs } = window;
  const processCreation = phases.some((phase) => isProcessCreation(phase.period));
  const candidates: Array<[number | null | undefined, "dyld" | "lifecycle"]> = [
    [dyldStartNs, "dyld"],
    [phases.find((phase) => !isProcessCreation(phase.period))?.startNs, "lifecycle"],
  ];
  for (const [startNs, startSource] of candidates) {
    if (endNs !== null && startNs !== null && startNs !== undefined && startNs <= endNs) {
      return { launchMs: ms(endNs - startNs), startNs, startSource, processCreation };
    }
  }
  return { launchMs: null, startNs: null, startSource: null, processCreation };
}

/**
 * The note a device profile adds when the trace has a Process Creation phase,
 * which launchMs leaves out. Null without that phase.
 */
export function processCreationNote(
  processCreation: boolean,
  startSource: "dyld" | "lifecycle" | null
): string | null {
  if (!processCreation) return null;
  return (
    "Under xctrace the Initializing - Process Creation phase includes the time the recording takes to attach to the app, " +
    (startSource === "dyld"
      ? "so launchMs starts at dyld instead."
      : startSource === "lifecycle"
        ? "so launchMs starts at the next lifecycle phase instead (the dyld export is missing)."
        : "so launchMs does not include it.")
  );
}

/** The note a simulator profile adds to its warning. */
export function simulatorProfileNote(signpostMissing: boolean): string {
  return (
    "Lifecycle phases exist only on a physical iPhone; Instruments does not record them on simulators. " +
    "The first frame comes from the system ApplicationFirstFramePresentation signpost. " +
    "Timings under xctrace on a simulator run roughly 2x slower than an uninstrumented launch and reflect Mac hardware, " +
    "so use them for relative CPU analysis only." +
    (signpostMissing
      ? " The signpost is missing, so the CPU session covers the whole recording and is not cut."
      : "")
  );
}

type CoreExport = "toc" | "cpu" | "lifecycle";

/**
 * The export a profile cannot do without, or null when all exported: the TOC,
 * which locates every table; the CPU samples, which are the main output on an
 * iPhone and the only launch data on a simulator; and on an iPhone the
 * lifecycle phases, which give launchMs and the first-frame cut of the CPU
 * samples. Without them the session would cover the whole recording.
 */
export function failedCoreExport(
  exportErrors: Record<string, string>,
  exported: { cpu: boolean; lifecycle: boolean; simulator: boolean }
): CoreExport | null {
  if (exportErrors.toc !== undefined) return "toc";
  if (!exported.cpu) return "cpu";
  return exported.simulator || exported.lifecycle ? null : "lifecycle";
}

const CORE_EXPORT_NAMES: Record<CoreExport, string> = {
  toc: "table of contents",
  cpu: "CPU samples",
  lifecycle: "lifecycle phases",
};

/** The error a profile throws when {@link failedCoreExport} names an export. */
export function coreExportFailureMessage(failure: {
  table: CoreExport;
  reason: string;
  crashed: boolean;
  attempts: number;
  xcodeVersion: string;
  tracePath: string;
}): string {
  const what = CORE_EXPORT_NAMES[failure.table];
  return failure.crashed
    ? `xctrace export of the ${what} crashed ${failure.attempts} times in a row with ${failure.xcodeVersion}. ` +
        `The trace was recorded: ${failure.tracePath}. Open it in Instruments to inspect the launch. ` +
        `${XCTRACE_EXPORT_CRASH_KNOWN} Run the tool again, or profile with Xcode 27.`
    : `xctrace could not export the ${what}, so there is no launch data. ` +
        `The trace was recorded: ${failure.tracePath}. Open it in Instruments to inspect the launch.\n` +
        failure.reason;
}

// Only what was verified: other Xcode versions were not tried.
const XCTRACE_EXPORT_CRASH_KNOWN =
  "Seen with Xcode 26.4.1, where xctrace export crashes in most attempts; " +
  "Xcode 27.0 exports the same traces without crashing.";

/**
 * The note a profile adds when an optional export (lifecycle, dyld, signpost)
 * still crashed after its retries, so the missing data has a stated cause.
 */
export function optionalExportCrashNote(tables: string[], xcodeVersion: string): string | null {
  if (tables.length === 0) return null;
  return (
    `xctrace export of ${tables.join(", ")} crashed with ${xcodeVersion}, so that data is missing. ` +
    `${XCTRACE_EXPORT_CRASH_KNOWN} Run the tool again for a complete result.`
  );
}
