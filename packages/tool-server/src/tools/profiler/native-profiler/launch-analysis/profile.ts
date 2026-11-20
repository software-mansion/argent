import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  wrapFailure,
  type ToolContext,
} from "@argent/registry";
import {
  CommandTimeoutError,
  commandFailureKind,
  ensureLaunchDeviceReady,
  isCrash,
  prepareLaunch,
  runLogged,
  terminateForWarmLaunch,
  terminateLaunchedApp,
  withXctraceCrashRetry,
  XCTRACE_EXPORT_ATTEMPTS,
  xcodeVersion,
} from "../../../../utils/ios-launch-time/workflow";
import {
  cpuTableXpath,
  earliestDyldStartNs,
  launchEndNs,
  launchedProcess,
  parseFirstFrameSignpostNs,
  parseLifecyclePhases,
  keepRunningRows,
  truncateCpuXml,
  weighSamplesByPeriod,
} from "../../../../utils/ios-launch-time/trace-exports";
import {
  coreExportFailureMessage,
  deviceLaunchWindow,
  failedCoreExport,
  noSimulatorEstimateNote,
  optionalExportCrashNote,
  processCreationNote,
  simulatorLaunchEstimateMs,
  SIMULATOR_PROFILE_NOTE,
  stalledAtRecordingStart,
  stallsSimulatorLaunchRecording,
} from "../../../../utils/ios-launch-time/results";
import { parseXcodeVersion } from "../../../../utils/ios-profiler/capture-strategy/select";
import { reserveLaunchAnalysis } from "../../../../utils/ios-device/runner-reservation";
import { getDebugDir } from "../../../../utils/react-profiler/debug/dump";
import type { NativeProfilerLaunchAnalysisParams } from "../native-profiler-launch-analysis";

const execFileAsync = promisify(execFile);

const TABLE_XPATH = (schema: string) =>
  `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`;

/** A launch export can finish while a regular capture with the same timestamp is still running. */
async function writeProfilerSession(
  xml: string
): Promise<{ sessionId: string; cpuXmlPath: string }> {
  const debugDir = await getDebugDir();
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const sessionId = `${timestamp}-launch-${randomUUID()}`;
  const cpuXmlPath = path.join(debugDir, `native-profiler-${sessionId}_raw_cpu.xml`);
  await fsp.writeFile(cpuXmlPath, xml, { flag: "wx" });
  return { sessionId, cpuXmlPath };
}

const RECORD_TIMEOUT_MS = 180_000;

const ms = (ns: number) => Math.round(ns / 100_000) / 10;

export const DEFAULT_PROFILE_SECONDS = 8;

/** mode "profile": one Instruments App Launch recording, cut at the first frame. */
export async function profileLaunch(params: NativeProfilerLaunchAnalysisParams, ctx?: ToolContext) {
  let release: (() => void) | undefined;
  try {
    const context = await prepareLaunch(
      {
        bundleId: params.bundle_id,
        deviceId: params.device_id,
        allowSimulator: params.allow_simulator,
        checkDevice: ({ id, simulator }) => {
          release = reserveLaunchAnalysis(id, "profile");
          return simulator ? refuseStallingSimulatorRecording() : undefined;
        },
      },
      (message) => ctx?.emitProgress?.({ type: "device-action", message }),
      ctx?.signal
    );
    return await profilePreparedLaunch(context, params, ctx);
  } finally {
    release?.();
  }
}

async function refuseStallingSimulatorRecording(): Promise<void> {
  const version = await xcodeVersion();
  if (stallsSimulatorLaunchRecording(parseXcodeVersion(version))) {
    throw new FailureError(
      `${version} stalls \`xctrace record --launch\` on a simulator after "Starting recording", ` +
        "so Argent does not record. This is a known issue with Xcode 26.4.x. " +
        "Use Xcode 27, or record on a physical iPhone.",
      {
        error_code: FAILURE_CODES.LAUNCH_ANALYSIS_UNSUPPORTED_HOST,
        failure_stage: "launch_analysis_record_precheck",
        failure_area: "tool_server",
        error_kind: "unsupported",
      }
    );
  }
}

async function profilePreparedLaunch(
  context: Awaited<ReturnType<typeof prepareLaunch>>,
  params: NativeProfilerLaunchAnalysisParams,
  ctx?: ToolContext
) {
  await terminateForWarmLaunch(context, ctx?.signal);
  await ensureLaunchDeviceReady(
    context,
    (message) => ctx?.emitProgress?.({ type: "device-action", message }),
    ctx?.signal
  );
  const durationSeconds = params.duration_seconds ?? DEFAULT_PROFILE_SECONDS;
  const tracePath = path.join(context.runDir, "app-launch.trace");
  const recordLog = path.join(context.runDir, "xctrace-record.log");
  try {
    await runLogged(
      "xcrun",
      [
        "xctrace",
        "record",
        "--template",
        "App Launch",
        // The system's first-frame signpost is the only launch marker on a simulator.
        ...(context.simulator ? ["--instrument", "os_signpost"] : []),
        "--device",
        context.deviceId,
        "--output",
        tracePath,
        "--time-limit",
        `${durationSeconds}s`,
        "--no-prompt",
        "--launch",
        "--",
        context.bundleId,
      ],
      {
        cwd: context.runDir,
        logPath: recordLog,
        timeoutMs: RECORD_TIMEOUT_MS,
        signal: ctx?.signal,
      }
    );
  } catch (error) {
    // A stalled or aborted recording leaves the launched app suspended; the cleanup is bounded.
    await terminateLaunchedApp(context);
    ctx?.signal?.throwIfAborted();
    const recordFailure = {
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_RECORD_FAILED,
      failure_stage: "launch_analysis_record",
      failure_area: "tool_server",
      error_kind: commandFailureKind(error),
      ...subprocessFailureMetadata(error, "xctrace"),
    } as const;
    if (
      error instanceof CommandTimeoutError &&
      stalledAtRecordingStart(await fsp.readFile(recordLog, "utf8").catch(() => ""))
    ) {
      throw new FailureError(
        context.simulator
          ? // Xcode 26.4.x never gets here: checkDevice stops it before the app launches.
            `xctrace stalled at "Starting recording" with ${await xcodeVersion()} and was stopped after ${RECORD_TIMEOUT_MS / 1000} s. ` +
              "It can stall on the first recording after the simulator boots; run the tool again, or record on a physical iPhone. " +
              `Record log: ${recordLog}`
          : `xctrace stalled after "Starting recording" and was stopped after ${RECORD_TIMEOUT_MS / 1000} s. ` +
              `Record log: ${recordLog}`,
        recordFailure,
        { cause: error }
      );
    }
    throw wrapFailure(error, recordFailure);
  }
  if (!(await fsp.stat(tracePath).catch(() => null))?.isDirectory()) {
    throw new FailureError(`xctrace finished without a trace at ${tracePath}; see ${recordLog}.`, {
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_RECORD_FAILED,
      failure_stage: "launch_analysis_record",
      failure_area: "tool_server",
      error_kind: "not_found",
      failure_command: "xctrace",
    });
  }
  const exportErrors: Record<string, string> = {};
  // For crash detection and telemetry.
  const exportFailures: Record<string, unknown> = {};
  const exported: Partial<Record<"lifecycle" | "dyld" | "cpu" | "signpost", string>> = {};
  let toc = "";
  try {
    const { stdout } = await withXctraceCrashRetry(
      () =>
        execFileAsync("xcrun", ["xctrace", "export", "--input", tracePath, "--toc"], {
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
          signal: ctx?.signal,
        }),
      ctx?.signal
    );
    await fsp.writeFile(path.join(context.runDir, "toc.xml"), stdout);
    toc = stdout;
  } catch (error) {
    ctx?.signal?.throwIfAborted();
    exportFailures.toc = error;
    exportErrors.toc = error instanceof Error ? error.message : String(error);
  }
  const xpaths = {
    lifecycle: toc.includes('schema="life-cycle-period"') ? TABLE_XPATH("life-cycle-period") : null,
    dyld: toc.includes('schema="dyld-activity-interval"')
      ? TABLE_XPATH("dyld-activity-interval")
      : null,
    cpu: cpuTableXpath(toc),
    // Recorded on simulators only.
    ...(context.simulator && {
      signpost: toc.includes('schema="os-signpost"') ? TABLE_XPATH("os-signpost") : null,
    }),
  };
  for (const [key, xpath] of Object.entries(xpaths) as Array<
    [keyof typeof xpaths, string | null]
  >) {
    ctx?.signal?.throwIfAborted();
    if (!xpath) {
      exportErrors[key] = "Trace TOC has no table for this export.";
      continue;
    }
    const output = path.join(context.runDir, `${key}.xml`);
    try {
      await withXctraceCrashRetry(
        () =>
          runLogged(
            "xcrun",
            ["xctrace", "export", "--input", tracePath, "--output", output, "--xpath", xpath],
            {
              cwd: context.runDir,
              logPath: path.join(context.runDir, `xctrace-export-${key}.log`),
              timeoutMs: 120_000,
              signal: ctx?.signal,
            }
          ),
        ctx?.signal
      );
      exported[key] = output;
    } catch (error) {
      ctx?.signal?.throwIfAborted();
      exportFailures[key] = error;
      exportErrors[key] = error instanceof Error ? error.message : String(error);
    }
  }
  ctx?.signal?.throwIfAborted();

  // Fail so the agent does not read a result without launch data as "nothing ran at launch".
  const failedExport = failedCoreExport(exportErrors, {
    cpu: Boolean(exported.cpu),
    lifecycle: Boolean(exported.lifecycle),
    signpost: Boolean(exported.signpost),
    simulator: context.simulator,
  });
  if (failedExport) {
    // Undefined when the TOC has no table for the export.
    const failure = exportFailures[failedExport];
    throw new FailureError(
      coreExportFailureMessage({
        table: failedExport,
        reason: exportErrors[failedExport] ?? "",
        crashed: isCrash(failure),
        attempts: XCTRACE_EXPORT_ATTEMPTS,
        xcodeVersion: await xcodeVersion(),
        tracePath,
      }),
      {
        error_code: FAILURE_CODES.LAUNCH_ANALYSIS_EXPORT_FAILED,
        failure_stage: "launch_analysis_export",
        failure_area: "tool_server",
        error_kind: failure === undefined ? "not_found" : commandFailureKind(failure),
        ...subprocessFailureMetadata(failure ?? {}, "xctrace"),
      }
    );
  }

  // Instruments never fills life-cycle-period on a simulator, so that is not an export error.
  if (context.simulator) delete exportErrors.lifecycle;
  const phases = exported.lifecycle
    ? parseLifecyclePhases(await fsp.readFile(exported.lifecycle, "utf8"))
    : [];
  const launched = launchedProcess(toc) ?? undefined;
  // failedCoreExport guarantees the signpost export on a simulator.
  const endNs = context.simulator
    ? parseFirstFrameSignpostNs(await fsp.readFile(exported.signpost!, "utf8"), launched)
    : launchEndNs(phases);
  if (endNs === null) {
    throw new FailureError(
      `The recording has no first frame of ${context.bundleId}. ` +
        `The app may have crashed, or the launch took longer than duration_seconds (${durationSeconds} s). ` +
        `Check that the app starts, or raise duration_seconds. Trace: ${tracePath}`,
      {
        error_code: FAILURE_CODES.LAUNCH_ANALYSIS_NO_FIRST_FRAME,
        failure_stage: "launch_analysis_read_trace",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  const simulatorEstimateMs =
    context.simulator && exported.dyld
      ? simulatorLaunchEstimateMs(
          endNs,
          earliestDyldStartNs(await fsp.readFile(exported.dyld, "utf8"), launched)
        )
      : null;
  const noSimulatorEstimate = context.simulator && simulatorEstimateMs === null;
  const launch = context.simulator ? null : deviceLaunchWindow({ phases, endNs });
  const crashedOptional = Object.keys(exportFailures).filter(
    (table) => isCrash(exportFailures[table]) && table in exportErrors
  );
  const dyldCrashed = crashedOptional.includes("dyld");
  const notes = [
    context.warning,
    context.simulator ? SIMULATOR_PROFILE_NOTE : null,
    launch ? processCreationNote(launch.processCreation, launch.launchMs) : null,
    noSimulatorEstimate && !dyldCrashed
      ? noSimulatorEstimateNote(exportFailures.dyld !== undefined)
      : null,
    crashedOptional.length > 0
      ? optionalExportCrashNote(crashedOptional, await xcodeVersion(), {
          noSimulatorEstimate: noSimulatorEstimate && dyldCrashed,
        })
      : null,
  ].filter(Boolean);

  let sessionId: string | null = null;
  let cpuXmlPath: string | null = null;
  let cpuSamples: number | null = null;
  if (exported.cpu) {
    const running = keepRunningRows(await fsp.readFile(exported.cpu, "utf8"));
    // Short launches may have too few samples to establish the period on their own.
    const weighed = weighSamplesByPeriod(running.xml, await fsp.readFile(recordLog, "utf8"));
    if (weighed.periodNs !== null && weighed.periodNs > 1_000_000) {
      const period = weighed.periodNs / 1_000_000;
      notes.push(
        `xctrace sampled the CPU every ${period} ms in this recording, not every 1 ms, ` +
          `so work shorter than ${period} ms can be missing from the samples. Run again for 1 ms samples.`
      );
    }
    const cut = truncateCpuXml(weighed.xml, endNs);
    ({ sessionId, cpuXmlPath } = await writeProfilerSession(cut.xml));
    // The launch-window copy is the one to analyze; drop the full export.
    await fsp.rm(exported.cpu, { force: true });
    delete exported.cpu;
    cpuSamples = cut.keptRows;
  }

  const launchPhases = phases.filter((phase) => phase.startNs < endNs);
  ctx?.emitProgress?.({ type: "artifact", tracePath });
  return {
    launchMs: launch?.launchMs ?? null,
    ...(context.simulator && { simulatorLaunchEstimateMs: simulatorEstimateMs }),
    device: { id: context.deviceId, name: context.deviceName, simulator: context.simulator },
    bundleId: context.bundleId,
    // Trace-relative ms, the same clock as CPU sample times.
    firstFrameEndMs: ms(endNs),
    phases: launchPhases.map(
      (phase) => `${ms(phase.startNs)}–${ms(phase.startNs + phase.durationNs)} ms ${phase.period}`
    ),
    tracePath,
    exports: exported,
    ...(sessionId && {
      profilerSession: {
        sessionId,
        cpuXml: cpuXmlPath,
        cpuSamples,
        next: `profiler-load mode=load_native session_id=${sessionId} device_id=${context.deviceId}, then profiler-stack-query mode=thread_breakdown thread="Main Thread" device_id=${context.deviceId}`,
      },
    }),
    ...(Object.keys(exportErrors).length > 0 && { exportErrors }),
    warning: notes.length > 0 ? notes.join(" ") : null,
  };
}
