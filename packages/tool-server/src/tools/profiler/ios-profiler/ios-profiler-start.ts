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

const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, "Argent.tracetemplate");
const STARTUP_TIMEOUT_MS = 15_000;
const DETECT_RUNNING_APP_TIMEOUT_MS = 5_000;
const NOTIFY_REGISTER_TIMEOUT_MS = 2_000;

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

    // P2: subscribe-before-spawn for the locale-robust ready signal. Darwin
    // notifications are not queued, so the listener must be registered before
    // xctrace can fire `--notify-tracing-started`. The stdout substring match
    // remains as a fallback.
    const notifyName = `com.argent.ios-profiler.started.${process.pid}.${Date.now()}`;
    let notify: NotifyHandle | null = null;
    try {
      const handle = listenForDarwinNotification(notifyName);
      const ready = await Promise.race([
        handle.ready.then(() => true as const),
        new Promise<false>((r) => setTimeout(() => r(false), NOTIFY_REGISTER_TIMEOUT_MS)),
      ]);
      if (ready) {
        notify = handle;
      } else {
        handle.cancel();
        process.stderr.write(
          `[ios-profiler] notifyutil did not register within ${NOTIFY_REGISTER_TIMEOUT_MS} ms; ` +
            `falling back to stdout substring match.\n`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[ios-profiler] failed to spawn notifyutil (${msg}); falling back to stdout substring match.\n`
      );
    }

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

    return new Promise((resolve, reject) => {
      const xctraceProcess = spawn("xctrace", xctraceArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      api.xctracePid = xctraceProcess.pid ?? null;
      api.xctraceProcess = xctraceProcess;

      let settled = false;
      let stderrBuffer = "";

      const cleanupNotify = () => {
        if (notify) {
          notify.cancel();
          notify = null;
        }
      };

      let startupTimer: NodeJS.Timeout | null = null;

      const onReady = () => {
        if (settled) return;
        settled = true;
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        cleanupNotify();
        api.profilingActive = true;
        api.wallClockStartMs = Date.now();
        if (!api.xctracePid) {
          // Should not happen — pid is set synchronously after spawn — but
          // guard anyway so we don't resolve with `pid: 0`.
          reject(new Error("xctrace process has no pid; cannot resolve start."));
          return;
        }
        api.recordingTimeout = setTimeout(
          () => {
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
          },
          10 * 60 * 1000
        );
        resolve({
          status: "recording",
          pid: api.xctracePid,
          traceFile: outputFile,
        });
      };

      const clearStartupTimer = () => {
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
      };

      startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        startupTimer = null;
        cleanupNotify();
        try {
          xctraceProcess.kill("SIGKILL");
        } catch {
          // already dead
        }
        api.xctracePid = null;
        api.xctraceProcess = null;
        api.traceFile = null;
        api.appProcess = null;
        reject(
          new Error(
            `xctrace record did not start within ${STARTUP_TIMEOUT_MS} ms. ` +
              `Last stderr: ${stderrBuffer.trim() || "<empty>"}`
          )
        );
      }, STARTUP_TIMEOUT_MS);

      if (notify) {
        notify.fired.then(onReady).catch(() => {
          // notify failures fall through to stdout substring match
        });
      }

      xctraceProcess.stdout.on("data", (data: Buffer) => {
        const output = data.toString();
        if (
          !settled &&
          (output.includes("Ctrl-C to stop") || output.includes("Starting recording"))
        ) {
          onReady();
        }
      });

      xctraceProcess.stderr.on("data", (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      xctraceProcess.on("exit", (code, signal) => {
        if (settled) {
          // Recording was already live (or already failed); clean up if it exits.
          if (api.profilingActive) {
            if (api.recordingTimeout) {
              clearTimeout(api.recordingTimeout);
              api.recordingTimeout = null;
            }
            api.xctracePid = null;
            api.xctraceProcess = null;
            api.profilingActive = false;
          }
          return;
        }
        settled = true;
        clearStartupTimer();
        cleanupNotify();
        api.xctracePid = null;
        api.xctraceProcess = null;
        api.traceFile = null;
        api.appProcess = null;
        reject(
          new Error(
            `xctrace record exited before recording started (code=${code}, signal=${signal}). ` +
              `stderr: ${stderrBuffer.trim() || "<empty>"}`
          )
        );
      });

      xctraceProcess.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearStartupTimer();
        cleanupNotify();
        api.xctracePid = null;
        api.xctraceProcess = null;
        api.traceFile = null;
        api.appProcess = null;
        reject(new Error(`Failed to start xctrace: ${err.message}`));
      });
    });
  },
};
