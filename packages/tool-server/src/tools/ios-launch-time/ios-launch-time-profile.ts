import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import {
  ensureLaunchDeviceReady,
  prepareLaunch,
  runLogged,
  terminateForWarmLaunch,
} from "../../utils/ios-launch-time/workflow";
import {
  cpuTableXpath,
  launchEndNs,
  parseLifecyclePhases,
  truncateCpuXml,
} from "../../utils/ios-launch-time/trace-exports";
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
    "Build an iOS app in Release, run it once, then relaunch it on a physical iPhone under Xcode Instruments' App Launch template (usually a warm launch; iOS can still evict the app from memory), and return the launch phases up to the first frame. Saves the .trace and XML exports (lifecycle, dyld) under <workspace>/.argent/traces/<datetime>, and the CPU samples up to the first frame as a native profiler session for profiler-load and profiler-stack-query. A simulator requires explicit allow_simulator=true.",
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
    await runLogged(
      "xcrun",
      [
        "xctrace",
        "record",
        "--template",
        "App Launch",
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
      { cwd: params.workspace_path, logPath: recordLog, timeoutMs: 180_000, signal: ctx?.signal }
    );
    if (!(await fsp.stat(tracePath).catch(() => null))?.isDirectory()) {
      throw new Error(`xctrace finished without a trace at ${tracePath}; see ${recordLog}.`);
    }
    const exportErrors: Record<string, string> = {};
    const exported: Partial<Record<"lifecycle" | "dyld" | "cpu", string>> = {};
    let toc = "";
    try {
      const { stdout } = await execFileAsync(
        "xcrun",
        ["xctrace", "export", "--input", tracePath, "--toc"],
        { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal: ctx?.signal }
      );
      await fsp.writeFile(path.join(context.runDir, "toc.xml"), stdout);
      toc = stdout;
    } catch (error) {
      ctx?.signal?.throwIfAborted();
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
        await runLogged(
          "xcrun",
          ["xctrace", "export", "--input", tracePath, "--output", output, "--xpath", xpath],
          {
            cwd: params.workspace_path,
            logPath: path.join(context.runDir, `xctrace-export-${key}.log`),
            timeoutMs: 120_000,
            signal: ctx?.signal,
          }
        );
        exported[key] = output;
      } catch (error) {
        ctx?.signal?.throwIfAborted();
        exportErrors[key] = error instanceof Error ? error.message : String(error);
      }
    }
    ctx?.signal?.throwIfAborted();

    const phases = exported.lifecycle
      ? parseLifecyclePhases(await fsp.readFile(exported.lifecycle, "utf8"))
      : [];
    const endNs = launchEndNs(phases);
    if (exported.lifecycle && endNs === null) {
      exportErrors.lifecycle =
        "Lifecycle export has no first-frame phase; CPU samples are not cut.";
    }

    let sessionId: string | null = null;
    let cpuXmlPath: string | null = null;
    let cpuSamples: number | null = null;
    let laterRows = 0;
    if (exported.cpu) {
      const cpuXml = await fsp.readFile(exported.cpu, "utf8");
      const cut = endNs === null ? null : truncateCpuXml(cpuXml, endNs);
      sessionId = profilerSessionId();
      cpuXmlPath = path.join(await getDebugDir(), `native-profiler-${sessionId}_raw_cpu.xml`);
      await fsp.writeFile(cpuXmlPath, cut?.xml ?? cpuXml);
      // The launch-window copy is the one to analyze; drop the full export.
      await fsp.rm(exported.cpu, { force: true });
      delete exported.cpu;
      cpuSamples = cut?.keptRows ?? null;
      laterRows = cut?.laterRows ?? 0;
    }

    const launchPhases = phases.filter((phase) => endNs === null || phase.startNs < endNs);
    ctx?.emitProgress?.({ type: "artifact", tracePath });
    return {
      // Process start (first lifecycle phase) to the end of the first frame.
      launchMs: endNs === null || phases.length === 0 ? null : ms(endNs - phases[0]!.startNs),
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
      ...(context.warning && { warning: context.warning }),
    };
  },
};
