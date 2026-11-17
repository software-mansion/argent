/** Pure helpers that turn launch measurements and trace values into tool results. */
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

/** XCTApplicationLaunchMetric samples are in seconds. */
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

export function stalledAtRecordingStart(log: string): boolean {
  return (
    /starting recording/i.test(log) &&
    !/reached specified time limit|recording completed/i.test(log)
  );
}

/**
 * Xcode 26.4 stalls `xctrace record --launch` on a simulator; 27.0 does not.
 * Not the `--device` attach deadlock behind `isDegraded` in
 * capture-strategy/select.ts, so the version bounds differ.
 */
export function stallsSimulatorLaunchRecording(version: XcodeVersion | null): boolean {
  return version?.major === 26 && version.minor === 4;
}

/** Earliest dyld activity to the first-frame signpost. */
export function simulatorLaunchEstimateMs(
  signpostNs: number,
  dyldStartNs: number | null
): number | null {
  return dyldStartNs !== null && signpostNs >= dyldStartNs ? ms(signpostNs - dyldStartNs) : null;
}

function isProcessCreation(period: string): boolean {
  return /process creation\s*$/i.test(period);
}

/**
 * launchMs on an iPhone, skipping Process Creation: `xctrace record --launch`
 * spawns the app suspended while Instruments attaches, and Xcode 26.4 counts
 * that wait in Process Creation. Uses only the lifecycle export, which is
 * required on an iPhone, not the optional dyld export.
 */
export function deviceLaunchWindow(window: {
  phases: Array<{ startNs: number; period: string }>;
  endNs: number;
}): { launchMs: number | null; startNs: number | null; processCreation: boolean } {
  const { phases, endNs } = window;
  const processCreation = phases.some((phase) => isProcessCreation(phase.period));
  const startNs = phases.find((phase) => !isProcessCreation(phase.period))?.startNs;
  return startNs !== undefined && startNs <= endNs
    ? { launchMs: ms(endNs - startNs), startNs, processCreation }
    : { launchMs: null, startNs: null, processCreation };
}

export function processCreationNote(
  processCreation: boolean,
  launchMs: number | null
): string | null {
  if (!processCreation) return null;
  return (
    "Under xctrace the Initializing - Process Creation phase includes the time the recording takes to attach to the app, " +
    (launchMs !== null
      ? "so launchMs starts at the next lifecycle phase instead."
      : "so launchMs does not include it.")
  );
}

export const SIMULATOR_PROFILE_NOTE =
  "Lifecycle phases exist only on a physical iPhone; Instruments does not record them on simulators. " +
  "The first frame comes from the system ApplicationFirstFramePresentation signpost. " +
  "Timings under xctrace on a simulator run roughly 2x slower than an uninstrumented launch and reflect Mac hardware, " +
  "so use them for relative CPU analysis only.";

type CoreExport = "toc" | "cpu" | "lifecycle" | "signpost";

/**
 * The export a profile cannot do without, or null: the TOC, the CPU samples,
 * and the first-frame marker that cuts them (lifecycle phases on an iPhone, the
 * signpost on a simulator).
 */
export function failedCoreExport(
  exportErrors: Record<string, string>,
  exported: { cpu: boolean; lifecycle: boolean; signpost: boolean; simulator: boolean }
): CoreExport | null {
  if (exportErrors.toc !== undefined) return "toc";
  if (!exported.cpu) return "cpu";
  if (exported.simulator) return exported.signpost ? null : "signpost";
  return exported.lifecycle ? null : "lifecycle";
}

const CORE_EXPORT_NAMES: Record<CoreExport, string> = {
  toc: "table of contents",
  cpu: "CPU samples",
  lifecycle: "lifecycle phases",
  signpost: "first-frame signpost",
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

// Other Xcode versions were not tried.
const XCTRACE_EXPORT_CRASH_KNOWN =
  "Seen with Xcode 26.4.1, where xctrace export crashes in most attempts; " +
  "Xcode 27.0 exports the same traces without crashing.";

const NO_ESTIMATE_CONSEQUENCE =
  "so simulatorLaunchEstimateMs is null. The CPU session is complete.";

/**
 * Why simulatorLaunchEstimateMs is null when the dyld export did not crash; a
 * crash is explained by {@link optionalExportCrashNote} instead.
 */
export function noSimulatorEstimateNote(dyldExportFailed: boolean): string {
  return `${dyldExportFailed ? "The dyld export failed" : "No dyld activity for the app before the first frame"}, ${NO_ESTIMATE_CONSEQUENCE}`;
}

/**
 * Gives missing optional data a stated cause when its export crashed on every
 * retry. `noSimulatorEstimate` names the null estimate as what is missing, so
 * the result has one note for a crashed dyld export.
 */
export function optionalExportCrashNote(
  tables: string[],
  xcodeVersion: string,
  options: { noSimulatorEstimate?: boolean } = {}
): string | null {
  if (tables.length === 0) return null;
  const consequence = options.noSimulatorEstimate
    ? NO_ESTIMATE_CONSEQUENCE
    : "so that data is missing.";
  return (
    `xctrace export of ${tables.join(", ")} crashed with ${xcodeVersion}, ${consequence} ` +
    `${XCTRACE_EXPORT_CRASH_KNOWN} Run the tool again for a complete result.`
  );
}
