import { z } from "zod";
import { spawn, execSync } from "child_process";
import * as path from "path";
import type { ToolDefinition } from "@argent/registry";
import {
  NATIVE_PROFILER_SESSION_NAMESPACE,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { getDebugDir } from "../../../utils/react-profiler/debug/dump";

const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, "Argent.tracetemplate");

const zodSchema = z.object({
  device_id: z.string().describe("Target device id from `list-devices`. Currently iOS-only."),
  app_process: z
    .string()
    .optional()
    .describe(
      "The exact CFBundleExecutable of the app to profile. If omitted, auto-detects the currently running foreground app on the simulator. Only provide this if auto-detection picks the wrong app (e.g. multiple apps running)."
    ),
  template_path: z
    .string()
    .optional()
    .describe("Path to an Instruments .tracetemplate file (defaults to bundled Argent template)"),
});

interface AppInfo {
  CFBundleExecutable: string;
  CFBundleIdentifier: string;
  CFBundleDisplayName?: string;
  ApplicationType: string;
}

function detectRunningApp(udid: string): string {
  // 1. Get running UIKitApplication processes
  const launchctlOutput = execSync(`xcrun simctl spawn ${udid} launchctl list`, {
    encoding: "utf-8",
  });

  const runningBundleIds = new Set<string>();
  for (const line of launchctlOutput.split("\n")) {
    const match = line.match(/UIKitApplication:([^\[]+)/);
    if (match) {
      runningBundleIds.add(match[1]);
    }
  }

  if (runningBundleIds.size === 0) {
    throw new Error(
      "No running apps detected on the simulator. Launch the app first using `launch-app`, then retry."
    );
  }

  // 2. Get installed app metadata
  const listAppsOutput = execSync(`xcrun simctl listapps ${udid} | plutil -convert json -o - -`, {
    encoding: "utf-8",
  });

  const installedApps: Record<string, AppInfo> = JSON.parse(listAppsOutput);

  // 3. Cross-reference: running user apps
  const runningUserApps: AppInfo[] = [];
  for (const [, appInfo] of Object.entries(installedApps)) {
    if (appInfo.ApplicationType === "User" && runningBundleIds.has(appInfo.CFBundleIdentifier)) {
      runningUserApps.push(appInfo);
    }
  }

  if (runningUserApps.length === 0) {
    throw new Error(
      "No running user apps detected on the simulator (only system apps are running). Launch the app first using `launch-app`, then retry."
    );
  }

  if (runningUserApps.length > 1) {
    const appList = runningUserApps
      .map(
        (a) =>
          `  - ${a.CFBundleExecutable} (${a.CFBundleIdentifier}${a.CFBundleDisplayName ? `, "${a.CFBundleDisplayName}"` : ""})`
      )
      .join("\n");
    throw new Error(
      `Multiple user apps are running on the simulator:\n${appList}\nSpecify \`app_process\` with the CFBundleExecutable of the app you want to profile.`
    );
  }

  return runningUserApps[0].CFBundleExecutable;
}

export const nativeProfilerStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { status: "recording"; pid: number; traceFile: string }
> = {
  id: "native-profiler-start",
  requires: ["xcrun"],
  description: `Start native profiling on a booted device. iOS: Instruments via xctrace (CPU, hangs, memory). Android: not yet supported.
Auto-detects the running app process unless app_process is explicitly provided.
After starting, let the user interact with the app, then call native-profiler-stop.
Use when you want to capture native CPU, hang, and memory data for a running app.
Returns { status, pid, traceFile } confirming the recording has started.
Fails if no app is running on the device, the platform is not supported yet, or the profiler cannot attach to the process.`,
  zodSchema,
  services: (params) => ({
    session: `${NATIVE_PROFILER_SESSION_NAMESPACE}:${params.device_id}`,
  }),
  async execute(services, params) {
    const api = services.session as NativeProfilerSessionApi;

    if (api.profilingActive) {
      throw new Error(`A native profiling session is already running (PID: ${api.xctracePid}).`);
    }

    const templatePath = params.template_path ?? DEFAULT_TEMPLATE_PATH;
    const appProcess = params.app_process ?? detectRunningApp(params.device_id);

    const debugDir = await getDebugDir();
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
      .slice(0, 15);
    const outputFile = path.join(debugDir, `native-profiler-${timestamp}.trace`);

    api.appProcess = appProcess;
    api.traceFile = outputFile;

    return new Promise((resolve, reject) => {
      const xctraceProcess = spawn("xctrace", [
        "record",
        "--template",
        templatePath,
        "--device",
        params.device_id,
        "--attach",
        appProcess,
        "--output",
        outputFile,
      ]);

      api.xctracePid = xctraceProcess.pid ?? null;

      xctraceProcess.stdout.on("data", (data: Buffer) => {
        const output = data.toString();

        if (output.includes("Ctrl-C to stop") || output.includes("Starting recording")) {
          api.profilingActive = true;
          api.wallClockStartMs = Date.now();
          if (api.xctracePid) {
            api.recordingTimeout = setTimeout(
              () => {
                xctraceProcess.kill("SIGINT");
                api.profilingActive = false;
                api.xctracePid = null;
                api.recordingTimeout = null;
              },
              10 * 60 * 1000
            );
            resolve({
              status: "recording",
              pid: api.xctracePid,
              traceFile: outputFile,
            });
          }
        }
      });

      xctraceProcess.stderr.on("data", (data: Buffer) => {
        const errorOutput = data.toString();
        if (
          errorOutput.includes("Target failed to run") ||
          errorOutput.includes("failed with errors")
        ) {
          api.xctracePid = null;
          if (api.recordingTimeout) {
            clearTimeout(api.recordingTimeout);
            api.recordingTimeout = null;
          }
          reject(new Error(`Failed to attach to the target process: ${errorOutput}`));
        }
      });

      xctraceProcess.on("error", (err: Error) => {
        api.xctracePid = null;
        if (api.recordingTimeout) {
          clearTimeout(api.recordingTimeout);
          api.recordingTimeout = null;
        }
        reject(new Error(`Failed to start xctrace: ${err.message}`));
      });
    });
  },
};
