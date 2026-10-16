import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
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
} from "../../utils/ios-launch-time/workflow";
import {
  cpuTableXpath,
  earliestDyldStartNs,
  launchEndNs,
  parseFirstFrameSignpostNs,
  parseLifecyclePhases,
  truncateCpuXml,
} from "../../utils/ios-launch-time/trace-exports";
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
} from "../../utils/ios-launch-time/results";
import { parseXcodeVersion } from "../../utils/ios-profiler/capture-strategy/select";
import { getDebugDir } from "../../utils/react-profiler/debug/dump";

const execFileAsync = promisify(execFile);

const schema = z.object({
  workspace_path: z.string().describe("Absolute path to the iOS app project root."),
  device_id: z
    .string()
    .optional()
    .describe("Connected iPhone UDID; required for a physical-device run."),
  scheme: z
    .string()
    .optional()
    .describe("App scheme; required when Xcode cannot select one unambiguously."),
  xcode_container: z
    .string()
    .optional()
    .describe("Workspace or project path, relative to workspace_path."),
  configuration: z
    .string()
    .min(1)
    .default("Release")
    .describe(
      "Xcode build configuration for the app. Set only when the project's Release configuration has another name, such as Production."
    ),
  allow_simulator: z
    .boolean()
    .default(false)
    .describe("Explicitly allow a booted simulator when no iPhone is selected."),
  duration_seconds: z
    .number()
    .int()
    .min(5)
    .max(60)
    .default(8)
    .describe("App Launch trace recording length."),
});

const fileInputs: FileInputSpec[] = [
  { target: "workspace_path", path: "${workspace_path}", kind: "directory" },
];

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

export const iosLaunchTimeProfileTool: ToolDefinition<z.infer<typeof schema>, unknown> = {
  id: "ios-launch-time-profile",
  longRunning: true,
  searchHint: "iOS iPhone app launch Instruments xctrace trace startup first frame",
  capability: { apple: { device: true, simulator: true } },
  interaction: {
    startedMsg: ({ params }) => `Recording iOS App Launch in ${params.configuration ?? "Release"}`,
    completedMsg: () => "Recorded iOS App Launch",
    failedMsg: ({ failureSignal }) =>
      `Failed to record iOS App Launch: ${failureSignal.error_code}`,
  },
  description:
    "Profile an iOS app launch with the Xcode Instruments App Launch template. Use when the launch is slow and you need to know which phases and functions run before the first frame, e.g. static initializers, dylib loading or didFinishLaunching work. Builds the app in Release and runs it once first, so the recorded launch is usually warm; iOS can still evict the app from memory. Set `allow_simulator` only when Mac-hardware timings are acceptable; on a simulator there are no phases or launchMs, the first frame comes from a system signpost, and simulatorLaunchEstimateMs is a rough estimate. On an iPhone, launchMs runs from the start of dyld to the end of the first frame (from the first lifecycle phase after Process Creation when the dyld export failed); phases keeps Process Creation, which under xctrace includes the recording's attach time, and warning says so. cpuSamples counts differ between runs because the sampling period varies from 1 to 5 ms. Returns { launchMs, simulatorLaunchEstimateMs (simulator only), firstFrameEndMs, phases, tracePath, exports, profilerSession: { sessionId, cpuXml, cpuSamples, next }, exportErrors (when an optional lifecycle, dyld or signpost export failed), warning (null when there is nothing to note) }. The .trace and XML exports go to <workspace>/.argent/traces/<datetime>; profilerSession holds the CPU samples up to the first frame for profiler-load and profiler-stack-query. Fails if no iPhone is connected by USB cable, the scheme cannot be resolved, the build fails, xctrace cannot record the launch, or xctrace cannot export the trace table of contents, the CPU samples or, on an iPhone, the lifecycle phases; that error names the recorded tracePath, which opens in Instruments. Argent runs each xctrace export up to 3 times when xctrace crashes, as Xcode 26.4.1 xctrace does in most attempts; a crashed dyld or signpost export is named in warning. With Xcode 26.4.x on a simulator it fails before the build, because that Xcode stalls recording launches on simulators.",
  zodSchema: schema,
  fileInputs,
  services: () => ({}),
  async execute(_services, params, ctx) {
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
          `${params.duration_seconds}s`,
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
            ? `xctrace stalled at "Starting recording" with ${await xcodeVersion()}. ` +
                "Recording an app launch on a simulator is a known issue with Xcode 26.4.x. " +
                "Use Xcode 27, or record on a physical iPhone. " +
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
      lifecycle: toc.includes('schema="life-cycle-period"')
        ? TABLE_XPATH("life-cycle-period")
        : null,
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
    // Optional on both targets: without it a device launch starts at the lifecycle phases.
    const dyldStartNs = exported.dyld
      ? earliestDyldStartNs(await fsp.readFile(exported.dyld, "utf8"))
      : null;
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
      ({ endNs, simulatorLaunchEstimateMs, signpostMissing } = simulatorLaunchWindow(
        signpostNs,
        dyldStartNs
      ));
    } else if (exported.lifecycle && endNs === null) {
      exportErrors.lifecycle =
        "Lifecycle export has no first-frame phase; CPU samples are not cut.";
    }
    const launch = context.simulator ? null : deviceLaunchWindow({ phases, dyldStartNs, endNs });
    const crashedOptional = [...crashedExports].filter((table) => table in exportErrors);
    const notes = [
      context.warning,
      context.simulator ? simulatorProfileNote(signpostMissing) : null,
      launch ? processCreationNote(launch.processCreation, launch.startSource) : null,
      crashedOptional.length > 0
        ? optionalExportCrashNote(crashedOptional, await xcodeVersion())
        : null,
    ].filter(Boolean);

    let sessionId: string | null = null;
    let cpuXmlPath: string | null = null;
    let cpuSamples: number | null = null;
    let laterRows = 0;
    if (exported.cpu) {
      const cpuXml = await fsp.readFile(exported.cpu, "utf8");
      const cut = endNs === null ? null : truncateCpuXml(cpuXml, endNs);
      ({ sessionId, cpuXmlPath } = await writeProfilerSession(cut?.xml ?? cpuXml));
      // The launch-window copy is the one to analyze; drop the full export.
      await fsp.rm(exported.cpu, { force: true });
      delete exported.cpu;
      cpuSamples = cut?.keptRows ?? null;
      laterRows = cut?.laterRows ?? 0;
    }

    const launchPhases = phases.filter((phase) => endNs === null || phase.startNs < endNs);
    ctx?.emitProgress?.({ type: "artifact", tracePath });
    return {
      // Start of dyld (else the first phase after Process Creation) to the end of the first frame. Null on simulators.
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
  },
};
