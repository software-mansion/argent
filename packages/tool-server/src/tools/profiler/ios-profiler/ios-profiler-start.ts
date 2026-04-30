import { z } from "zod";
import { spawn, execSync } from "child_process";
import * as path from "path";
import type { ToolDefinition } from "@argent/registry";
import {
  IOS_PROFILER_SESSION_NAMESPACE,
  type IosProfilerSessionApi,
} from "../../../blueprints/ios-profiler-session";
import { getDebugDir } from "../../../utils/react-profiler/debug/dump";
import { listenForDarwinNotification, type NotifyHandle } from "../../../utils/ios-profiler/notify";
import { waitForXctraceReady } from "../../../utils/ios-profiler/startup";

const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, "Argent.tracetemplate");
const STARTUP_TIMEOUT_MS = 10_000;
const DETECT_RUNNING_APP_TIMEOUT_MS = 5_000;
const NOTIFY_REGISTER_TIMEOUT_MS = 2_000;
const RECORDING_CAP_MS = 10 * 60 * 1000;

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
  let launchctlOutput: string;
  try {
    launchctlOutput = execSync(`xcrun simctl spawn ${udid} launchctl list`, {
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to enumerate running processes on simulator ${udid} within ${DETECT_RUNNING_APP_TIMEOUT_MS} ms. ` +
        `Verify the simulator is booted and responsive, then retry. Underlying error: ${msg}`
    );
  }

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

  let listAppsOutput: string;
  try {
    listAppsOutput = execSync(`xcrun simctl listapps ${udid} | plutil -convert json -o - -`, {
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to list installed apps on simulator ${udid} within ${DETECT_RUNNING_APP_TIMEOUT_MS} ms. ` +
        `Verify the simulator is booted and responsive, then retry. Underlying error: ${msg}`
    );
  }

  const installedApps: Record<string, AppInfo> = JSON.parse(listAppsOutput);

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

/**
 * Subscribe-before-spawn for the locale-robust ready signal. Darwin
 * notifications are not queued, so the listener must be registered before
 * xctrace can fire `--notify-tracing-started`. Returns null if notifyutil
 * fails to register in time — the caller falls back to the stdout substring
 * match that `waitForXctraceReady` always listens for.
 */
async function registerStartupNotify(name: string): Promise<NotifyHandle | null> {
  let handle: NotifyHandle;
  try {
    handle = listenForDarwinNotification(name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[ios-profiler] failed to spawn notifyutil (${msg}); falling back to stdout substring match.\n`
    );
    return null;
  }

  const ready = await Promise.race([
    handle.ready.then(() => true as const),
    new Promise<false>((r) => setTimeout(() => r(false), NOTIFY_REGISTER_TIMEOUT_MS)),
  ]);
  if (ready) return handle;

  handle.cancel();
  process.stderr.write(
    `[ios-profiler] notifyutil did not register within ${NOTIFY_REGISTER_TIMEOUT_MS} ms; ` +
      `falling back to stdout substring match.\n`
  );
  return null;
}

function resetStartState(api: IosProfilerSessionApi): void {
  api.xctracePid = null;
  api.xctraceProcess = null;
  api.traceFile = null;
  api.appProcess = null;
}

export const iosInstrumentsStartTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { status: "recording"; pid: number; traceFile: string }
> = {
  id: "ios-profiler-start",
  description: `Start iOS Instruments profiling via xctrace on a booted simulator or connected device.
Auto-detects the running app process unless app_process is explicitly provided.
After starting, let the user interact with the app, then call ios-profiler-stop.
Use when you want to capture native CPU, hang, and memory data for a running iOS app.
Returns { status, pid, traceFile } confirming the recording has started.
Fails if no app is running on the simulator or xctrace cannot attach to the process.`,
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
    api.recordingTimedOut = false;

    const notifyName = `com.argent.ios-profiler.started.${process.pid}.${Date.now()}`;
    const notify = await registerStartupNotify(notifyName);

    const xctraceArgs = [
      "record",
      "--template",
      templatePath,
      "--device",
      params.device_id,
      "--attach",
      appProcess,
      "--output",
      outputFile,
      "--no-prompt",
    ];
    if (notify) {
      xctraceArgs.push("--notify-tracing-started", notifyName);
    }

    const xctraceProcess = spawn("xctrace", xctraceArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    api.xctracePid = xctraceProcess.pid ?? null;
    api.xctraceProcess = xctraceProcess;

    try {
      await waitForXctraceReady(xctraceProcess, { notify, timeoutMs: STARTUP_TIMEOUT_MS });
    } catch (err) {
      resetStartState(api);
      throw err;
    }

    if (!xctraceProcess.pid) {
      // pid is set synchronously after spawn — guard so we never resolve
      // with `pid: 0` if Node ever changes that contract.
      try {
        xctraceProcess.kill("SIGKILL");
      } catch {
        // already dead
      }
      resetStartState(api);
      throw new Error("xctrace process has no pid; cannot resolve start.");
    }

    api.profilingActive = true;
    api.wallClockStartMs = Date.now();
    api.recordingTimeout = setTimeout(() => {
      try {
        xctraceProcess.kill("SIGINT");
      } catch {
        // already dead
      }
      api.profilingActive = false;
      api.xctracePid = null;
      api.xctraceProcess = null;
      api.recordingTimeout = null;
      api.recordingTimedOut = true;
    }, RECORDING_CAP_MS);

    xctraceProcess.on("exit", () => {
      if (!api.profilingActive) return;
      if (api.recordingTimeout) {
        clearTimeout(api.recordingTimeout);
        api.recordingTimeout = null;
      }
      api.xctracePid = null;
      api.xctraceProcess = null;
      api.profilingActive = false;
    });

    return {
      status: "recording",
      pid: xctraceProcess.pid,
      traceFile: outputFile,
    };
  },
};
