import { z } from "zod";
import { spawn, execFileSync, type ChildProcess } from "child_process";
import { rmSync } from "fs";
import * as path from "path";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
  type NativeProfilerRecordingMode,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { getDebugDir } from "../../../utils/react-profiler/debug/dump";
import { listenForDarwinNotification, type NotifyHandle } from "../../../utils/ios-profiler/notify";
import { waitForXctraceReady } from "../../../utils/ios-profiler/startup";

const DEFAULT_TEMPLATE_PATH = path.resolve(__dirname, "Argent.tracetemplate");
// Built-in Instruments template used for the host-all-processes fallback. The
// bundled Argent template includes Leaks/Allocations instruments, which xctrace
// refuses to run against an "All Processes" target ("Leaks cannot handle a
// target type of 'All Processes'"). Time Profiler is the only CPU instrument
// that records host-wide, so the fallback is CPU-only by construction.
const HOST_FALLBACK_TEMPLATE = "Time Profiler";
const STARTUP_TIMEOUT_MS = 10_000;
const DETECT_RUNNING_APP_TIMEOUT_MS = 10_000;
const NOTIFY_REGISTER_TIMEOUT_MS = 2_000;
const RECORDING_CAP_MS = 10 * 60 * 1000;
const MAX_START_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_200;
// stderr prefix emitted by xctrace's own process resolver when the
// `--attach <name>` lookup misses.
const COLD_START_SIGNATURE = "Cannot find process matching name:";

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

/** The profiled app's executable name (for `--attach`) and its host PID. */
export interface DetectedApp {
  /** CFBundleExecutable — what xctrace `--attach` expects. */
  executable: string;
  /**
   * Host process id of the running app, parsed from `launchctl list`. On a
   * simulator the launchd PID equals the host PID that appears in a host
   * `--all-processes` trace, so it doubles as the `pid: N` filter for the
   * host-all-processes fallback. Null when the app is not currently running
   * (e.g. an explicit `app_process` that hasn't launched yet).
   */
  pid: string | null;
}

/**
 * Map every running `UIKitApplication:` entry in `launchctl list` to its host
 * PID. Format is `<pid>\t<status>\tUIKitApplication:<bundleId>[token][...]`.
 */
function readRunningBundlePids(udid: string): Map<string, string> {
  let launchctlOutput: string;
  try {
    launchctlOutput = execFileSync("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], {
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

  const pids = new Map<string, string>();
  for (const line of launchctlOutput.split("\n")) {
    // `52533\t0\tUIKitApplication:com.apple.mobilesafari[3658][rb-legacy]`
    const match = line.match(/^\s*(\d+)\s+\S+\s+UIKitApplication:([^[\s]+)/);
    if (match) pids.set(match[2], match[1]);
  }
  return pids;
}

function listInstalledApps(udid: string): Record<string, AppInfo> {
  let listAppsOutput: string;
  try {
    // Two stages, piped in code rather than by /bin/sh, so the udid is never
    // interpreted by a shell. Stage 1: ask simctl for the OpenStep plist of
    // installed apps. Stage 2: feed it to plutil over stdin to get JSON.
    const rawPlist = execFileSync("xcrun", ["simctl", "listapps", udid], {
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
    });
    listAppsOutput = execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      encoding: "utf-8",
      input: rawPlist,
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to list installed apps on simulator ${udid} within ${DETECT_RUNNING_APP_TIMEOUT_MS} ms. ` +
        `Verify the simulator is booted and responsive, then retry. Underlying error: ${msg}`
    );
  }
  return JSON.parse(listAppsOutput);
}

/**
 * Auto-detect the single running user app to profile, plus its host PID.
 * Errors if zero or many user apps are running — same contract as before, now
 * also returning the PID (used to scope a host-all-processes fallback trace).
 * Only called when `app_process` was not pinned, so the simulator enumeration
 * stays off the explicit-target path.
 */
function resolveRunningApp(udid: string): DetectedApp {
  const runningPids = readRunningBundlePids(udid);

  if (runningPids.size === 0) {
    throw new Error(
      "No running apps detected on the simulator. Launch the app first using `launch-app`, then retry."
    );
  }

  const installedApps = listInstalledApps(udid);
  const runningUserApps: AppInfo[] = [];
  for (const appInfo of Object.values(installedApps)) {
    if (appInfo.ApplicationType === "User" && runningPids.has(appInfo.CFBundleIdentifier)) {
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

  const app = runningUserApps[0];
  return {
    executable: app.CFBundleExecutable,
    pid: runningPids.get(app.CFBundleIdentifier) ?? null,
  };
}

/**
 * Best-effort host PID for an explicitly-pinned executable. Used lazily in the
 * host-all-processes fallback (the happy/explicit path never enumerates).
 * Returns null if the app isn't currently running or enumeration fails.
 */
function resolveAppPid(udid: string, executable: string): string | null {
  try {
    const runningPids = readRunningBundlePids(udid);
    const installedApps = listInstalledApps(udid);
    for (const app of Object.values(installedApps)) {
      if (app.ApplicationType === "User" && app.CFBundleExecutable === executable) {
        return runningPids.get(app.CFBundleIdentifier) ?? null;
      }
    }
  } catch {
    // fall through — fallback will report it could not resolve the PID
  }
  return null;
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
      `[native-profiler] failed to spawn notifyutil (${msg}); falling back to stdout substring match.\n`
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
    `[native-profiler] notifyutil did not register within ${NOTIFY_REGISTER_TIMEOUT_MS} ms; ` +
      `falling back to stdout substring match.\n`
  );
  return null;
}

function resetStartState(api: NativeProfilerSessionApi): void {
  api.xctracePid = null;
  api.xctraceProcess = null;
  api.traceFile = null;
  api.appProcess = null;
}

export function handleXctraceExit(
  api: NativeProfilerSessionApi,
  code: number | null,
  signal: string | null
): void {
  if (!api.profilingActive) return;
  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }
  api.xctracePid = null;
  api.xctraceProcess = null;
  api.profilingActive = false;
  if (!api.recordingTimedOut) {
    api.recordingExitedUnexpectedly = true;
  }
  api.lastExitInfo = { code, signal };
}

interface StartResult {
  status: "recording";
  pid: number;
  traceFile: string;
  /** Which capture path was used (see NativeProfilerRecordingMode). */
  mode: NativeProfilerRecordingMode;
  /** App host PID used to scope a host-all-processes trace; null otherwise. */
  processFilterPid: string | null;
}

export const nativeProfilerStartTool: ToolDefinition<z.infer<typeof zodSchema>, StartResult> = {
  id: "native-profiler-start",
  requires: ["xcrun"],
  capability: { apple: { simulator: true, device: true } },
  longRunning: true,
  description: `Start native profiling on a booted device. iOS: Instruments via xctrace (CPU, hangs, memory). Android: not yet supported.
Auto-detects the running app process unless app_process is explicitly provided.
After starting, let the user interact with the app, then call native-profiler-stop.
Use when you want to capture native CPU, hang, and memory data for a running app.
Returns { status, pid, traceFile, mode } confirming the recording has started.
On simulators where the Instruments device tap is broken (Xcode 26.x cannot package --device traces),
it transparently falls back to a host all-processes Time Profiler recording scoped to the app's PID — CPU-only (no hangs/leaks); mode is then "host-all-processes".
Fails if no app is running on the device, the platform is not supported yet, or the profiler cannot attach to the process.`,
  zodSchema,
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params) {
    const api = services.session as NativeProfilerSessionApi;

    if (api.profilingActive) {
      throw new Error(`A native profiling session is already running (PID: ${api.xctracePid}).`);
    }

    const templatePath = params.template_path ?? DEFAULT_TEMPLATE_PATH;
    // Pinned target: trust it, don't enumerate the simulator (PID is resolved
    // lazily only if the host fallback is actually needed). Otherwise auto-detect.
    const detected: DetectedApp = params.app_process
      ? { executable: params.app_process, pid: null }
      : resolveRunningApp(params.device_id);
    const appProcess = detected.executable;

    const debugDir = await getDebugDir();
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
      .slice(0, 15);
    const outputFile = path.join(debugDir, `native-profiler-${timestamp}.trace`);

    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;
    api.recordingMode = null;
    api.processFilterPid = null;

    // Generic spawn + ready-wait, shared by the device-attach and host
    // all-processes paths. `baseArgs` is the full xctrace argv minus the
    // optional `--notify-tracing-started` pair, which we add here.
    const attemptStart = async (
      baseArgs: string[]
    ): Promise<{ child: ChildProcess; pid: number }> => {
      api.traceFile = outputFile;

      // A previous failed attempt (a hung device-attach recording that had to be
      // killed, or a partial bundle from a cold-start miss) can leave the .trace
      // bundle on disk. xctrace refuses to record into an existing path
      // ("Trace file already exists"), so clear it before each attempt — the
      // path is uniquely timestamped per call, so this only ever removes our own
      // stale output, never a real prior recording.
      try {
        rmSync(outputFile, { recursive: true, force: true });
      } catch {
        // best-effort — if it can't be removed, xctrace will surface the error
      }

      const notifyName = `com.argent.ios-profiler.started.${process.pid}.${Date.now()}`;
      const notify = await registerStartupNotify(notifyName);

      const xctraceArgs = [...baseArgs];
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

      return { child: xctraceProcess, pid: xctraceProcess.pid };
    };

    // Preferred path: attach to the app on the simulator/device tap (full
    // fidelity — CPU, hangs, leaks). Bounded retry scoped to this single call:
    // xctrace's process resolver can miss a freshly cold-launched app even
    // after launchd has registered it.
    const deviceArgs = [
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
    const startMs = Date.now();
    const startDeviceAttach = async (): Promise<{ child: ChildProcess; pid: number }> => {
      for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
        try {
          return await attemptStart(deviceArgs);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isColdStart = msg.includes(COLD_START_SIGNATURE);
          if (!isColdStart) throw err;
          if (attempt >= MAX_START_ATTEMPTS) break;
          process.stderr.write(
            `[native-profiler] xctrace could not find "${appProcess}" on attempt ${attempt}/${MAX_START_ATTEMPTS}; ` +
              `waiting ${RETRY_DELAY_MS} ms for cold-start to settle, then retrying.\n`
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
      const totalMs = Date.now() - startMs;
      throw new Error(
        `xctrace could not find process "${appProcess}" after ${MAX_START_ATTEMPTS} attempts within ${totalMs} ms. ` +
          `The app appears to be cold-launching — its bundle is registered with launchd, but xctrace's process resolver hasn't seen it yet. ` +
          `Wait 1–2 seconds for the app to finish launching and retry. ` +
          `If the wrong app is being detected, pass app_process explicitly with the CFBundleExecutable.`
      );
    };

    let xctraceProcess: ChildProcess;
    let xctracePid: number;
    let mode: NativeProfilerRecordingMode;

    try {
      ({ child: xctraceProcess, pid: xctracePid } = await startDeviceAttach());
      mode = "device-attach";
    } catch (deviceErr) {
      const deviceMsg = deviceErr instanceof Error ? deviceErr.message : String(deviceErr);
      const isSimulator = resolveDevice(params.device_id).kind === "simulator";

      // The host all-processes fallback only makes sense for simulators: their
      // processes run on the host, so a host Time Profiler can see them. A
      // physical device's processes are not host processes — nothing to fall
      // back to. Surface the original error there.
      if (!isSimulator) throw deviceErr;

      // Resolve the app's host PID (needed to scope the host trace). Auto-detect
      // already has it; an explicit app_process resolves it lazily here.
      const appPid = detected.pid ?? resolveAppPid(params.device_id, appProcess);
      if (!appPid) {
        throw new Error(
          `${deviceMsg}\n\nThe simulator-targeted Instruments tap also could not be used, and the host ` +
            `all-processes fallback needs the app's host PID, which could not be resolved (is "${appProcess}" actually running?). ` +
            `Launch the app with launch-app and retry.`
        );
      }

      process.stderr.write(
        `[native-profiler] device-attach recording failed (${deviceMsg.split("\n")[0]}); ` +
          `falling back to host all-processes Time Profiler scoped to ${appProcess} (pid ${appPid}). ` +
          `This captures CPU only — hangs and leaks are unavailable in this mode.\n`
      );

      // Reset the flags the failed device attempts may have left set so the
      // host recording starts from a clean session state.
      api.recordingTimedOut = false;
      api.recordingExitedUnexpectedly = false;
      api.lastExitInfo = null;

      const hostArgs = [
        "record",
        "--template",
        HOST_FALLBACK_TEMPLATE,
        "--all-processes",
        "--output",
        outputFile,
        "--no-prompt",
      ];
      try {
        ({ child: xctraceProcess, pid: xctracePid } = await attemptStart(hostArgs));
      } catch (hostErr) {
        const hostMsg = hostErr instanceof Error ? hostErr.message : String(hostErr);
        throw new Error(
          `Native profiling could not start.\n` +
            `Device-attach failed: ${deviceMsg.split("\n")[0]}\n` +
            `Host all-processes fallback also failed: ${hostMsg}`
        );
      }
      mode = "host-all-processes";
      api.processFilterPid = appPid;
    }

    api.appProcess = appProcess;
    api.recordingMode = mode;
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

    xctraceProcess.on("exit", (code, signal) => handleXctraceExit(api, code, signal));

    return {
      status: "recording",
      pid: xctracePid,
      traceFile: outputFile,
      mode,
      processFilterPid: api.processFilterPid,
    };
  },
};
