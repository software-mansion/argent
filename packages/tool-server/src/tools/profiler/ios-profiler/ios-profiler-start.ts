import { z } from "zod";
import { spawn, execSync } from "child_process";
import * as path from "path";
import type { ToolDefinition } from "@argent/registry";
import {
  IOS_PROFILER_SESSION_NAMESPACE,
  type IosProfilerSessionApi,
} from "../../../blueprints/ios-profiler-session";
import { getDebugDir } from "../../../utils/react-profiler/debug/dump";

const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, "Argent.tracetemplate");

const zodSchema = z.object({
  device_id: z.string().describe("iOS Simulator or device UDID"),
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

export const iosInstrumentsStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { status: "recording"; pid: number; traceFile: string }
> = {
  id: "ios-profiler-start",
  description: `Start iOS Instruments profiling via xctrace on a booted simulator or connected device.
Use when measuring native iOS CPU usage, UI hangs, or memory leaks — especially alongside react-profiler-start for a complete picture. Auto-detects the running app process unless app_process is provided.

Parameters: device_id — simulator or device UDID (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890); project_root — absolute path to project root (trace output saved to <project_root>/argent-profiler-cwd/); app_process — optional CFBundleExecutable name; template_path — optional .tracetemplate path.
Example: { "device_id": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "project_root": "/Users/dev/MyApp" }
Returns { status: "recording", pid, traceFile }. After starting, let the user interact with the app, then call ios-profiler-stop. Fails if no user app is running — call launch-app first.`,
  zodSchema,
  services: (params) => ({
    session: `${IOS_PROFILER_SESSION_NAMESPACE}:${params.device_id}`,
  }),
  async execute(services, params) {
    const api = services.session as IosProfilerSessionApi;

    if (api.profilingActive) {
      throw new Error(`An iOS profiling session is already running (PID: ${api.xctracePid}).`);
    }

    const templatePath = params.template_path ?? DEFAULT_TEMPLATE_PATH;
    const appProcess = params.app_process ?? detectRunningApp(params.device_id);

    const debugDir = await getDebugDir();
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
      .slice(0, 15);
    const outputFile = path.join(debugDir, `ios-profiler-${timestamp}.trace`);

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
          reject(new Error(`Failed to attach to iOS process: ${errorOutput}`));
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
