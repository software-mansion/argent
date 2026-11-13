import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ToolContext } from "@argent/registry";
import {
  CommandTimeoutError,
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
  parseFirstFrameSignpostNs,
  parseLifecyclePhases,
  keepRunningRows,
  truncateCpuXml,
} from "../../../../utils/ios-launch-time/trace-exports";
import {
  coreExportFailureMessage,
  deviceLaunchWindow,
  failedCoreExport,
  simulatorLaunchWindow,
  optionalExportCrashNote,
  processCreationNote,
  simulatorProfileNote,
  stalledAtRecordingStart,
  stallsSimulatorLaunchRecording,
} from "../../../../utils/ios-launch-time/results";
import { parseXcodeVersion } from "../../../../utils/ios-profiler/capture-strategy/select";
import { getDebugDir } from "../../../../utils/react-profiler/debug/dump";
import type { NativeProfilerLaunchAnalysisParams } from "../native-profiler-launch-analysis";

const execFileAsync = promisify(execFile);

const TABLE_XPATH = (schema: string) =>
  `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`;

function profilerSessionId(): string {
  // Same shape as native-profiler-start, so profiler-load lists and loads it.
  return new Date()
    .toISOString()
    .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
    .slice(0, 15);
}

// The ID has one-second resolution, so a session started in the same second
// would share it. Write exclusively and take the next second's ID on a clash.
async function writeProfilerSession(
  xml: string
): Promise<{ sessionId: string; cpuXmlPath: string }> {
  const debugDir = await getDebugDir();
  for (;;) {
    const sessionId = profilerSessionId();
    const cpuXmlPath = path.join(debugDir, `native-profiler-${sessionId}_raw_cpu.xml`);
    try {
      await fsp.writeFile(cpuXmlPath, xml, { flag: "wx" });
      return { sessionId, cpuXmlPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

const RECORD_TIMEOUT_MS = 180_000;

const ms = (ns: number) => Math.round(ns / 100_000) / 10;

// Recording length when duration_seconds is not set.
export const DEFAULT_PROFILE_SECONDS = 8;

/** mode "profile": one Instruments App Launch recording, cut at the first frame. */
export async function profileLaunch(params: NativeProfilerLaunchAnalysisParams, ctx?: ToolContext) {
  const context = await prepareLaunch(
    {
      workspacePath: params.workspace_path,
      deviceId: params.device_id,
      scheme: params.scheme,
      xcodeContainer: params.xcode_container,
      allowSimulator: params.allow_simulator,
      configuration: params.configuration,
      checkDevice: async ({ simulator }) => {
        if (!simulator) return;
        const version = await xcodeVersion();
        if (stallsSimulatorLaunchRecording(parseXcodeVersion(version))) {
          throw new Error(
            `${version} stalls \`xctrace record --launch\` on a simulator after "Starting recording", ` +
              "so Argent does not record. This is a known issue with Xcode 26.4.x. " +
              "Use Xcode 27, or record on a physical iPhone."
          );
        }
      },
    },
    (message) => ctx?.emitProgress?.({ type: "device-action", message }),
    ctx?.signal
  );
  await terminateForWarmLaunch(context, ctx?.signal);
  await ensureLaunchDeviceReady(
    context,
    (message) => ctx?.emitProgress?.({ type: "device-action", message }),
    ctx?.signal
  );
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
        `${params.duration_seconds ?? DEFAULT_PROFILE_SECONDS}s`,
        "--no-prompt",
        "--launch",
        "--",
        context.bundleId,
      ],
      {
        cwd: params.workspace_path,
        logPath: recordLog,
        timeoutMs: RECORD_TIMEOUT_MS,
        signal: ctx?.signal,
      }
    );
  } catch (error) {
    // A stalled or aborted recording leaves the launched app suspended.
    // The cleanup is bounded, so a cancel still returns quickly.
    await terminateLaunchedApp(context);
    if (
      error instanceof CommandTimeoutError &&
      stalledAtRecordingStart(await fsp.readFile(recordLog, "utf8").catch(() => ""))
    ) {
      throw new Error(
        context.simulator
          ? // Xcode 26.4.x never gets here: checkDevice stops it before the build.
            `xctrace stalled at "Starting recording" with ${await xcodeVersion()} and was stopped after ${RECORD_TIMEOUT_MS / 1000} s. ` +
              "It can stall on the first recording after the simulator boots; run the tool again, or record on a physical iPhone. " +
              `Record log: ${recordLog}`
          : `xctrace stalled after "Starting recording" and was stopped after ${RECORD_TIMEOUT_MS / 1000} s. ` +
              `Record log: ${recordLog}`,
        { cause: error }
      );
    }
    throw error;
  }
  if (!(await fsp.stat(tracePath).catch(() => null))?.isDirectory()) {
    throw new Error(`xctrace finished without a trace at ${tracePath}; see ${recordLog}.`);
  }
  const exportErrors: Record<string, string> = {};
  const crashedExports = new Set<string>();
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
    if (isCrash(error)) crashedExports.add("toc");
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
              cwd: params.workspace_path,
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
      if (isCrash(error)) crashedExports.add(key);
      exportErrors[key] = error instanceof Error ? error.message : String(error);
    }
  }
  ctx?.signal?.throwIfAborted();

  // Without the TOC or the CPU samples the result has no launch data. Fail so
  // the agent does not read an empty result as "nothing ran at launch".
  // Lifecycle, dyld and signpost stay optional and are reported in exportErrors.
  const failedExport = failedCoreExport(exportErrors, {
    cpu: Boolean(exported.cpu),
    lifecycle: Boolean(exported.lifecycle),
    simulator: context.simulator,
  });
  if (failedExport) {
    throw new Error(
      coreExportFailureMessage({
        table: failedExport,
        reason: exportErrors[failedExport] ?? "",
        crashed: crashedExports.has(failedExport),
        attempts: XCTRACE_EXPORT_ATTEMPTS,
        xcodeVersion: await xcodeVersion(),
        tracePath,
      })
    );
  }

  // Instruments never fills life-cycle-period on a simulator, so that is not an export error.
  if (context.simulator) delete exportErrors.lifecycle;
  const phases = exported.lifecycle
    ? parseLifecyclePhases(await fsp.readFile(exported.lifecycle, "utf8"))
    : [];
  let endNs = launchEndNs(phases);
  let simulatorLaunchEstimateMs: number | null = null;
  let signpostMissing = false;
  if (context.simulator) {
    const signpostNs = exported.signpost
      ? parseFirstFrameSignpostNs(
          await fsp.readFile(exported.signpost, "utf8"),
          context.executableName
        )
      : null;
    // Optional: the simulator estimate starts at dyld.
    const dyldStartNs = exported.dyld
      ? earliestDyldStartNs(await fsp.readFile(exported.dyld, "utf8"))
      : null;
    ({ endNs, simulatorLaunchEstimateMs, signpostMissing } = simulatorLaunchWindow(
      signpostNs,
      dyldStartNs
    ));
  } else if (exported.lifecycle && endNs === null) {
    exportErrors.lifecycle = "Lifecycle export has no first-frame phase; CPU samples are not cut.";
  }
  const launch = context.simulator ? null : deviceLaunchWindow({ phases, endNs });
  const crashedOptional = [...crashedExports].filter((table) => table in exportErrors);
  const notes = [
    context.warning,
    context.simulator ? simulatorProfileNote(signpostMissing) : null,
    launch ? processCreationNote(launch.processCreation, launch.launchMs) : null,
    crashedOptional.length > 0
      ? optionalExportCrashNote(crashedOptional, await xcodeVersion())
      : null,
  ].filter(Boolean);

  let sessionId: string | null = null;
  let cpuXmlPath: string | null = null;
  let cpuSamples: number | null = null;
  let laterRows = 0;
  if (exported.cpu) {
    const running = keepRunningRows(await fsp.readFile(exported.cpu, "utf8"));
    // Without a first-frame end the session keeps the whole recording.
    const cut = truncateCpuXml(running.xml, endNs ?? Infinity);
    ({ sessionId, cpuXmlPath } = await writeProfilerSession(cut.xml));
    // The launch-window copy is the one to analyze; drop the full export.
    await fsp.rm(exported.cpu, { force: true });
    delete exported.cpu;
    cpuSamples = cut.keptRows;
    laterRows = cut.laterRows;
  }

  const launchPhases = phases.filter((phase) => endNs === null || phase.startNs < endNs);
  ctx?.emitProgress?.({ type: "artifact", tracePath });
  return {
    // First lifecycle phase after Process Creation to the end of the first frame. Null on simulators.
    launchMs: launch?.launchMs ?? null,
    // Simulator only: earliest dyld activity to the first-frame signpost.
    ...(context.simulator && { simulatorLaunchEstimateMs }),
    device: { id: context.deviceId, name: context.deviceName, simulator: context.simulator },
    bundleId: context.bundleId,
    // Trace-relative ms, the same clock as CPU sample times.
    firstFrameEndMs: endNs === null ? null : ms(endNs),
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
        ...(laterRows > 0 && { postLaunchSamplesKept: laterRows }),
        next: `profiler-load mode=load_native session_id=${sessionId} device_id=${context.deviceId}, then profiler-stack-query mode=thread_breakdown thread="Main Thread" device_id=${context.deviceId}`,
      },
    }),
    ...(Object.keys(exportErrors).length > 0 && { exportErrors }),
    warning: notes.length > 0 ? notes.join(" ") : null,
  };
}
