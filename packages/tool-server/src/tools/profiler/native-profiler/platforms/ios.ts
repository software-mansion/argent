import { spawn, execSync, execFileSync, type ChildProcess } from "child_process";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { promises as fs } from "fs";
import { existsSync } from "node:fs";
import * as path from "path";
import type { NativeProfilerSessionApi } from "../../../../blueprints/native-profiler-session";
import { getDebugDir } from "../../../../utils/react-profiler/debug/dump";
import {
  listenForDarwinNotification,
  type NotifyHandle,
} from "../../../../utils/ios-profiler/notify";
import { waitForXctraceReady } from "../../../../utils/ios-profiler/startup";
import { exportIosTraceData } from "../../../../utils/ios-profiler/export";
import type { ExportDiagnostics } from "../../../../utils/ios-profiler/export";
import { shutdownChild } from "../../../../utils/profiler-shared/lifecycle";
import { runIosProfilerPipeline } from "../../../../utils/ios-profiler/pipeline/index";
import {
  selectIosCaptureStrategy,
  resolveIosCaptureStrategy,
  warnIfInvalidCaptureOverride,
  type IosCaptureStrategy,
  type CaptureStrategyReason,
} from "../../../../utils/ios-profiler/capture-strategy";
import type { NativeProfilerAnalyzeResult } from "../../../../utils/ios-profiler/types";
import { renderNativeProfilerReport } from "../../../../utils/ios-profiler/render";
import { formatTraceFreshness } from "../../../../utils/profiler-shared/freshness";
import { RECORDING_CAP_MS } from "../../../../utils/profiler-shared/types";

// Two candidates because __dirname differs by runtime: bundled it's argent/dist/
// (template in argent/assets/); in dev it's tool-server/dist/tools/profiler/
// native-profiler/platforms/, four levels above dist/utils/ios-profiler/. Throw
// if neither exists so a wrong depth can't silently break recording.
function resolveDefaultTemplatePath(): string {
  const candidates = [
    path.resolve(__dirname, "..", "assets", "Argent.tracetemplate"),
    path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "utils",
      "ios-profiler",
      "Argent.tracetemplate"
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Argent.tracetemplate not found. Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      `Pass template_path explicitly, or rebuild so the template is copied into place.`
  );
}
const STARTUP_TIMEOUT_MS = 10_000;
const DETECT_RUNNING_APP_TIMEOUT_MS = 10_000;
const NOTIFY_REGISTER_TIMEOUT_MS = 2_000;
const MAX_START_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_200;
const COLD_START_SIGNATURE = "Cannot find process matching name:";

const STOP_GRACE_MS = 30_000;
const STOP_TERM_MS = 5_000;
const STOP_KILL_MS = 5_000;

interface AppInfo {
  CFBundleExecutable: string;
  CFBundleIdentifier: string;
  CFBundleDisplayName?: string;
  ApplicationType: string;
}

interface DetectedApp {
  /** CFBundleExecutable — used for human-readable messages and api.appProcess. */
  executable: string;
  /**
   * Host PID of the running app, parsed from `launchctl list`. We attach by PID
   * rather than by name because Xcode 26.5's `xctrace --attach` matches the app
   * display name (not CFBundleExecutable, as Xcode <= 26.3 did), so passing the
   * executable name fails with "Cannot find process matching name". A PID is
   * unambiguous and works across Xcode versions. For simulator apps the launchd
   * PID is also the host PID xctrace attaches to. Null when the target is not
   * currently running (then we fall back to attaching by name).
   */
  pid: number | null;
}

/**
 * Enumerate the user apps currently running on the simulator, each paired with
 * its host PID. The PID is the leading column of `launchctl list`; apps that are
 * registered but not running carry `-` there and are skipped.
 */
function enumerateRunningUserApps(udid: string): { info: AppInfo; pid: number }[] {
  let launchctlOutput: string;
  try {
    launchctlOutput = execSync(`xcrun simctl spawn ${udid} launchctl list`, {
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FailureError(
      `Failed to enumerate running processes on simulator ${udid} within ${DETECT_RUNNING_APP_TIMEOUT_MS} ms. ` +
        `Verify the simulator is booted and responsive, then retry. Underlying error: ${msg}`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_APP_PROCESS_LIST_FAILED,
        failure_stage: "native_profiler_detect_running_processes",
        failure_area: "tool_server",
        error_kind: "subprocess",
        ...subprocessFailureMetadata(err, "xcrun_simctl"),
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }

  // Lines look like: `19967\t0\tUIKitApplication:com.apple.Preferences[183a][rb-legacy]`
  // (PID, status, label). Only lines with a numeric PID are actually running.
  const runningPids = new Map<string, number>();
  for (const line of launchctlOutput.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+\S+\s+UIKitApplication:([^[]+)/);
    if (match) {
      runningPids.set(match[2], Number(match[1]));
    }
  }

  if (runningPids.size === 0) {
    throw new FailureError(
      "No running apps detected on the simulator. Launch the app first using `launch-app`, then retry.",
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_NO_RUNNING_APPS,
        failure_stage: "native_profiler_detect_running_processes",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  const installedApps = getInstalledApps(udid);

  const runningUserApps: { info: AppInfo; pid: number }[] = [];
  for (const [, info] of Object.entries(installedApps)) {
    const pid = runningPids.get(info.CFBundleIdentifier);
    if (info.ApplicationType === "User" && pid !== undefined) {
      runningUserApps.push({ info, pid });
    }
  }

  if (runningUserApps.length === 0) {
    throw new FailureError(
      "No running user apps detected on the simulator (only system apps are running). Launch the app first using `launch-app`, then retry.",
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_NO_RUNNING_USER_APPS,
        failure_stage: "native_profiler_detect_running_user_app",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  return runningUserApps;
}

/**
 * Both the auto-detect (attach) and the malloc_stack_logging launch paths bail the
 * same way when several user apps are running and no `app_process` disambiguates
 * them — only the failure_stage differs. One builder keeps the message and app-list
 * formatting in a single place.
 */
function multipleRunningUserAppsError(
  runningUserApps: { info: AppInfo }[],
  failureStage: string
): FailureError {
  const appList = runningUserApps
    .map(
      ({ info }) =>
        `  - ${info.CFBundleExecutable} (${info.CFBundleIdentifier}${info.CFBundleDisplayName ? `, "${info.CFBundleDisplayName}"` : ""})`
    )
    .join("\n");
  return new FailureError(
    `Multiple user apps are running on the simulator:\n${appList}\nSpecify \`app_process\` with the CFBundleExecutable or display name of the app you want to profile.`,
    {
      error_code: FAILURE_CODES.NATIVE_PROFILER_MULTIPLE_RUNNING_USER_APPS,
      failure_stage: failureStage,
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

/** Auto-detect the single running user app to profile, with its host PID. */
function detectRunningApp(udid: string): DetectedApp {
  const runningUserApps = enumerateRunningUserApps(udid);

  if (runningUserApps.length > 1) {
    throw multipleRunningUserAppsError(runningUserApps, "native_profiler_detect_running_user_app");
  }

  const { info, pid } = runningUserApps[0];
  return { executable: info.CFBundleExecutable, pid };
}

/**
 * Resolve an explicitly-provided `app_process` to a host PID by matching it
 * against the CFBundleExecutable or CFBundleDisplayName of a running user app.
 * Falls back to attaching by the given name (pid: null) when nothing matches —
 * e.g. the app isn't running yet — so the cold-start retry can still kick in.
 */
function resolveExplicitApp(udid: string, name: string): DetectedApp {
  let runningUserApps: { info: AppInfo; pid: number }[];
  try {
    runningUserApps = enumerateRunningUserApps(udid);
  } catch {
    return { executable: name, pid: null };
  }
  const matched = runningUserApps.find(
    ({ info }) => info.CFBundleExecutable === name || info.CFBundleDisplayName === name
  );
  if (matched) {
    return { executable: matched.info.CFBundleExecutable, pid: matched.pid };
  }
  return { executable: name, pid: null };
}

function getInstalledApps(udid: string): Record<string, AppInfo> {
  let listAppsOutput: string;
  try {
    // `simctl listapps` emits a plist; plutil converts it to JSON, reading the plist
    // from stdin (the trailing `-`). Two discrete-argv execFileSync calls instead of a
    // piped `execSync` shell string — matching getAppBundlePath / terminate / relaunch,
    // so no value (device_id included) is ever interpolated into a shell.
    const listAppsPlist = execFileSync("xcrun", ["simctl", "listapps", udid], {
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
    });
    listAppsOutput = execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
      input: listAppsPlist,
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FailureError(
      `Failed to list installed apps on simulator ${udid} within ${DETECT_RUNNING_APP_TIMEOUT_MS} ms. ` +
        `Verify the simulator is booted and responsive, then retry. Underlying error: ${msg}`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_APP_LIST_FAILED,
        failure_stage: "native_profiler_list_installed_apps",
        failure_area: "tool_server",
        error_kind: "subprocess",
        ...subprocessFailureMetadata(err, "xcrun_simctl"),
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  return JSON.parse(listAppsOutput);
}

/** Resolve the .app bundle path xctrace's `--launch` needs (malloc_stack_logging mode). */
function getAppBundlePath(udid: string, bundleId: string): string {
  let appPath: string;
  try {
    appPath = execFileSync("xcrun", ["simctl", "get_app_container", udid, bundleId, "app"], {
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FailureError(
      `Failed to resolve the .app bundle path for "${bundleId}" on simulator ${udid} ` +
        `(required to cold-launch with malloc_stack_logging). Underlying error: ${msg}`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_APP_BUNDLE_PATH_FAILED,
        failure_stage: "native_profiler_resolve_app_bundle_path",
        failure_area: "tool_server",
        error_kind: "subprocess",
        ...subprocessFailureMetadata(err, "xcrun_simctl"),
      },
      { cause: err instanceof Error ? err : new Error(String(err)) }
    );
  }
  if (!appPath) {
    throw new FailureError(
      `simctl resolved an empty .app bundle path for "${bundleId}" on simulator ${udid} ` +
        `(required to cold-launch with malloc_stack_logging). Verify the app is installed.`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_APP_BUNDLE_PATH_FAILED,
        failure_stage: "native_profiler_resolve_app_bundle_path",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  return appPath;
}

/**
 * malloc_stack_logging cold-launches the app by .app path, which needs the bundle
 * id. Resolve the target AppInfo: an explicit app_process is matched against
 * installed user apps by CFBundleExecutable or display name; otherwise fall back
 * to the single running user app (same disambiguation as detectRunningApp).
 */
function resolveAppForLaunch(udid: string, appProcess?: string): AppInfo {
  if (appProcess) {
    const installed = getInstalledApps(udid);
    for (const [, info] of Object.entries(installed)) {
      if (
        info.ApplicationType === "User" &&
        (info.CFBundleExecutable === appProcess || info.CFBundleDisplayName === appProcess)
      ) {
        return info;
      }
    }
    throw new FailureError(
      `No installed user app matching "${appProcess}" found on simulator ${udid}. ` +
        `Pass the exact CFBundleExecutable or display name, or omit app_process to auto-detect the running app.`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_LAUNCH_APP_NOT_FOUND,
        failure_stage: "native_profiler_resolve_app_for_launch",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  const runningUserApps = enumerateRunningUserApps(udid);
  if (runningUserApps.length > 1) {
    throw multipleRunningUserAppsError(runningUserApps, "native_profiler_resolve_app_for_launch");
  }
  return runningUserApps[0].info;
}

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
  api.capturePid = null;
  api.captureProcess = null;
  api.traceFile = null;
  api.appProcess = null;
  api.cpuFilterPid = null;
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
  api.capturePid = null;
  api.captureProcess = null;
  api.profilingActive = false;
  if (!api.recordingTimedOut) {
    api.recordingExitedUnexpectedly = true;
  }
  api.lastExitInfo = { code, signal };
}

/**
 * malloc_stack_logging must cold-launch the app under `xctrace --device --launch`.
 * When the resolved capture strategy is NOT `device`, the cold launch can't run, so
 * we refuse — but attribute the refusal to the ACTUAL cause so the message and the
 * telemetry `error_code` don't blame a degraded Xcode that may not be present:
 *   - `env-override`   → the operator forced `ARGENT_IOS_CAPTURE=all-processes`;
 *   - `degraded-xcode` → the active Xcode has the `--device` recording-start deadlock.
 */
function mallocNonDeviceStrategyError(reason: CaptureStrategyReason): FailureError {
  if (reason.kind === "env-override") {
    return new FailureError(
      `malloc_stack_logging must cold-launch the app under \`xctrace --device\`, but ` +
        `ARGENT_IOS_CAPTURE="${reason.strategyName}" forces the "${reason.strategyName}" capture ` +
        `strategy, which attaches host-wide and cannot \`--launch\` a cold start. Unset ` +
        `ARGENT_IOS_CAPTURE (or set it to "device") to use malloc_stack_logging, or re-run without ` +
        `malloc_stack_logging (leaks are still detected, just unattributed).`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_MALLOC_STRATEGY_OVERRIDE,
        failure_stage: "native_profiler_start_malloc_capability",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }
  const versionNote =
    reason.kind === "degraded-xcode" ? `Xcode ${reason.major}.${reason.minor}` : "the active Xcode";
  return new FailureError(
    `malloc_stack_logging needs to cold-launch the app under \`xctrace --device\`, but ` +
      `${versionNote} has the --device recording-start deadlock (Xcode 26.4 and later), so it would ` +
      `terminate your app and then capture an empty trace. Re-run without malloc_stack_logging ` +
      `(leaks are still detected, just unattributed), profile on a non-degraded Xcode, or set ` +
      `ARGENT_IOS_CAPTURE=device to force the device path if you know it works on your host.`,
    {
      error_code: FAILURE_CODES.NATIVE_PROFILER_MALLOC_DEGRADED_XCODE,
      failure_stage: "native_profiler_start_malloc_capability",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

export interface IosStartParams {
  device_id: string;
  app_process?: string;
  template_path?: string;
  malloc_stack_logging?: boolean;
}

export async function startNativeProfilerIos(
  api: NativeProfilerSessionApi,
  params: IosStartParams
): Promise<{ status: "recording"; pid: number; traceFile: string }> {
  if (api.profilingActive) {
    throw new FailureError(
      `A native profiling session is already running (PID: ${api.capturePid}).`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_ALREADY_RUNNING,
        failure_stage: "native_profiler_start_session_state",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  const templatePath = params.template_path ?? resolveDefaultTemplatePath();

  // Default flow attaches to the running app (preserves state, no overhead).
  // malloc_stack_logging mode instead cold-launches the app *under* xctrace with
  // MallocStackLogging=1 so the malloc library records allocation backtraces from
  // the first allocation — without that, leaks are detected but unattributable
  // ("<Call stack limit reached>"). `--env` is only honoured with `--launch`,
  // which needs the .app path rather than the executable name or PID.
  const useMallocStackLogging = params.malloc_stack_logging === true;
  let appProcess: string;
  let launchBundlePath: string | null = null;
  // Bundle id of the app the malloc path terminated for its clean cold start, so a
  // failed start can best-effort relaunch it instead of leaving the user's app dead.
  let mallocRelaunchBundleId: string | null = null;
  // Normal (attach / all-processes) flow only — both stay null in
  // malloc_stack_logging mode, which cold-launches by .app path under `--device`
  // and is therefore already scoped without a capture strategy or detected PID.
  let detected: DetectedApp | null = null;
  let strategy: IosCaptureStrategy | null = null;

  // Resolve the trace output path (which creates the debug dir) BEFORE the branch
  // below. The malloc path terminates the running app for a clean cold start; if
  // getDebugDir()'s mkdir failed AFTER that terminate, the app would be left dead
  // with no relaunch (the best-effort relaunch only guards the start attempt).
  // Doing it here means any mkdir failure happens before the app is touched.
  const debugDir = await getDebugDir();
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
    .slice(0, 15);
  const outputFile = path.join(debugDir, `native-profiler-${timestamp}.trace`);

  if (useMallocStackLogging) {
    // malloc_stack_logging must cold-launch the app under `xctrace --device --launch`
    // (only `--launch` honours `--env MallocStackLogging=1`). On Xcode 26.4–27.0 the
    // `--device` recording-start handshake is broken (see capture-strategy), so this
    // would terminate the running app and then capture an empty trace — the opposite
    // of the feature's purpose, surfaced only as a downstream "Analysis failed". Refuse
    // up front, BEFORE touching the running app, unless the operator forces the device
    // path via ARGENT_IOS_CAPTURE=device. Use the SIDE-EFFECT-FREE resolver so this
    // guard doesn't emit selectIosCaptureStrategy()'s "using the all-processes
    // fallback" stderr line immediately before throwing (that fallback never runs
    // here); the reason it returns also lets the refusal name its actual cause
    // (forced override vs. degraded Xcode) rather than always blaming the Xcode.
    const captureDecision = resolveIosCaptureStrategy();
    // The side-effect-free resolver above stays silent, so a typo'd override would
    // be dropped without a word here (unlike the normal record flow). Surface it —
    // otherwise the degraded-Xcode refusal below can even tell the user to "set
    // ARGENT_IOS_CAPTURE=device" while their fumbled value sits ignored.
    warnIfInvalidCaptureOverride(captureDecision);
    if (captureDecision.strategy.name !== "device") {
      throw mallocNonDeviceStrategyError(captureDecision.reason);
    }
    const info = resolveAppForLaunch(params.device_id, params.app_process);
    appProcess = info.CFBundleExecutable;
    launchBundlePath = getAppBundlePath(params.device_id, info.CFBundleIdentifier);
    // Terminate any running instance so xctrace owns a clean cold launch with the
    // env var set from process start (best-effort; not-running is fine).
    try {
      execFileSync("xcrun", ["simctl", "terminate", params.device_id, info.CFBundleIdentifier], {
        timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
        stdio: "ignore",
      });
      // The terminate SUCCEEDED, so the app was actually running and we own killing
      // it. Only now mark it for best-effort relaunch on a later start failure — if
      // the app was NOT running (terminate throws below), relaunching would foreground
      // an app the user never had open, the opposite of "restore what we killed".
      mallocRelaunchBundleId = info.CFBundleIdentifier;
    } catch {
      // app was not running — nothing to terminate, and nothing to restore
    }
  } else {
    detected = params.app_process
      ? resolveExplicitApp(params.device_id, params.app_process)
      : detectRunningApp(params.device_id);
    appProcess = detected.executable;

    // Pick the capture approach for this environment. On Xcode versions where
    // `xctrace --device` works this is the original device/attach path (which
    // attaches by PID — immune to Xcode 26.5's display-name `--attach` matching);
    // on the 26.4–27.0 regression (where --device deadlocks) it is the host-wide
    // --all-processes fallback, filtered to the app PID. See capture-strategy.
    strategy = selectIosCaptureStrategy();
    // The all-processes fallback records host-wide and isolates the app by PID, so
    // it can only run when the target is actually running (PID known).
    if (strategy.name === "all-processes" && detected.pid == null) {
      throw new FailureError(
        `The all-processes capture fallback needs the target app to be running so its ` +
          `samples can be isolated by PID, but no running PID was found for "${appProcess}". ` +
          `Launch the app first using \`launch-app\`, then retry.`,
        {
          error_code: FAILURE_CODES.NATIVE_PROFILER_NO_RUNNING_USER_APPS,
          failure_stage: "native_profiler_start_app_detect",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
  }

  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.lastExitInfo = null;

  const attemptStart = async (): Promise<{ child: ChildProcess; pid: number }> => {
    api.appProcess = appProcess;
    api.traceFile = outputFile;
    // Null for the device strategy (already scoped by --attach) and for a
    // malloc_stack_logging cold launch (scoped by --launch on --device); the app
    // PID only for the host-wide all-processes fallback, to filter the samples.
    api.cpuFilterPid = strategy ? strategy.cpuFilterPid(detected!) : null;

    const notifyName = `com.argent.ios-profiler.started.${process.pid}.${Date.now()}`;
    const notify = await registerStartupNotify(notifyName);

    let xctraceArgs: string[];
    if (useMallocStackLogging) {
      // malloc_stack_logging cold launch: `--env` only applies to `--launch`, and
      // the launched command must be the final argument (everything after `--` is
      // the target plus its args). The degraded-Xcode guard above guarantees the
      // `--device` path is viable here (or ARGENT_IOS_CAPTURE=device forced it).
      xctraceArgs = [
        "record",
        "--template",
        templatePath,
        "--device",
        params.device_id,
        "--output",
        outputFile,
        "--no-prompt",
        "--env",
        "MallocStackLogging=1",
      ];
      if (notify) {
        xctraceArgs.push("--notify-tracing-started", notifyName);
      }
      xctraceArgs.push("--launch", "--", launchBundlePath!);
    } else {
      // Normal flow: let the selected capture strategy (device --attach by PID, or
      // host-wide --all-processes) build the argv.
      xctraceArgs = strategy!.buildRecordArgs({
        templatePath,
        deviceId: params.device_id,
        target: detected!,
        outputFile,
        notifyName: notify ? notifyName : undefined,
      });
    }

    const xctraceProcess = spawn("xctrace", xctraceArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    api.capturePid = xctraceProcess.pid ?? null;
    api.captureProcess = xctraceProcess;

    try {
      await waitForXctraceReady(xctraceProcess, { notify, timeoutMs: STARTUP_TIMEOUT_MS });
    } catch (err) {
      resetStartState(api);
      throw err;
    }

    if (!xctraceProcess.pid) {
      try {
        xctraceProcess.kill("SIGKILL");
      } catch {
        // already dead
      }
      resetStartState(api);
      throw new FailureError("xctrace process has no pid; cannot resolve start.", {
        error_code: FAILURE_CODES.NATIVE_PROFILER_XCTRACE_NO_PID,
        failure_stage: "native_profiler_xctrace_start",
        failure_area: "tool_server",
        error_kind: "subprocess",
        failure_command: "xctrace",
      });
    }

    return { child: xctraceProcess, pid: xctraceProcess.pid };
  };

  const startMs = Date.now();
  const startWithRetry = async (): Promise<{ child: ChildProcess; pid: number }> => {
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      try {
        return await attemptStart();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Cold-start retry only applies when attaching by name (device strategy);
        // the all-processes fallback doesn't attach, and malloc_stack_logging
        // cold-launches by path (no strategy), so neither can hit this.
        const isColdStart =
          (strategy?.attachesByName ?? false) && msg.includes(COLD_START_SIGNATURE);
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
    throw new FailureError(
      `xctrace could not find process "${appProcess}" after ${MAX_START_ATTEMPTS} attempts within ${totalMs} ms. ` +
        `The app appears to be cold-launching — its bundle is registered with launchd, but xctrace's process resolver hasn't seen it yet. ` +
        `Wait 1–2 seconds for the app to finish launching and retry. ` +
        `If the wrong app is being detected, pass app_process explicitly with the CFBundleExecutable or display name.`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_XCTRACE_PROCESS_NOT_FOUND,
        failure_stage: "native_profiler_xctrace_start",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
  };

  let started: { child: ChildProcess; pid: number };
  try {
    started = await startWithRetry();
  } catch (err) {
    // malloc_stack_logging terminated the running app for a clean cold start. If the
    // capture never started, best-effort relaunch it so we don't leave the user with a
    // dead app — the default attach path never terminates, so only this path needs it.
    if (mallocRelaunchBundleId) {
      try {
        execFileSync("xcrun", ["simctl", "launch", params.device_id, mallocRelaunchBundleId], {
          timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
          stdio: "ignore",
        });
      } catch {
        // best-effort restore; surface the original start failure regardless
      }
    }
    throw err;
  }
  const { child: xctraceProcess, pid: xctracePid } = started;

  api.profilingActive = true;
  api.wallClockStartMs = Date.now();
  api.recordingTimeout = setTimeout(() => {
    try {
      xctraceProcess.kill("SIGINT");
    } catch {
      // already dead
    }
    api.profilingActive = false;
    api.capturePid = null;
    api.captureProcess = null;
    api.recordingTimeout = null;
    api.recordingTimedOut = true;
  }, RECORDING_CAP_MS);

  xctraceProcess.on("exit", (code, signal) => handleXctraceExit(api, code, signal));

  return {
    status: "recording",
    pid: xctracePid,
    traceFile: outputFile,
  };
}

export interface IosStopResult {
  traceFile: string;
  exportedFiles: Record<string, string | null>;
  exportDiagnostics: ExportDiagnostics;
  warning?: string;
}

export async function stopNativeProfilerIos(api: NativeProfilerSessionApi): Promise<IosStopResult> {
  if ((api.recordingTimedOut || api.recordingExitedUnexpectedly) && api.traceFile) {
    const traceFile = api.traceFile;
    const wasTimeout = api.recordingTimedOut;
    const exitInfo = api.lastExitInfo;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;

    const { files: exportedFiles, diagnostics } = await exportIosTraceData(traceFile);
    api.exportedFiles = exportedFiles;

    const warning = wasTimeout
      ? "Recording timed out at 10 min cap; exported the partial trace. " +
        "Call native-profiler-start again for a fresh recording."
      : `xctrace exited before stop was called (code=${exitInfo?.code ?? "?"}, ` +
        `signal=${exitInfo?.signal ?? "?"}); exported the partial trace. ` +
        "Common causes: attached app terminated, simulator daemon restart. " +
        "Call native-profiler-start again for a fresh recording.";
    process.stderr.write(`[native-profiler] ${warning}\n`);

    return { traceFile, exportedFiles, exportDiagnostics: diagnostics, warning };
  }

  if (!api.profilingActive || !api.captureProcess || !api.traceFile) {
    throw new FailureError(
      "No active native profiling session found. Call native-profiler-start first.",
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_NO_ACTIVE_SESSION,
        failure_stage: "native_profiler_stop_session_state",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }

  const result = await shutdownChild(api.captureProcess, {
    graceMs: STOP_GRACE_MS,
    termMs: STOP_TERM_MS,
    killMs: STOP_KILL_MS,
  });

  let warning: string | undefined;
  if (!result.clean) {
    warning =
      `xctrace did not respond to SIGINT${result.signalUsed === "SIGKILL" ? "/SIGTERM" : ""}; ` +
      `${result.signalUsed} was used. Trace bundle may be incomplete.`;
    process.stderr.write(`[native-profiler] ${warning}\n`);
  }

  api.profilingActive = false;
  api.capturePid = null;
  api.captureProcess = null;
  api.recordingExitedUnexpectedly = false;
  api.lastExitInfo = null;

  const { files: exportedFiles, diagnostics } = await exportIosTraceData(api.traceFile);
  api.exportedFiles = exportedFiles;

  const stopResult: IosStopResult = {
    traceFile: api.traceFile,
    exportedFiles,
    exportDiagnostics: diagnostics,
  };
  if (warning) stopResult.warning = warning;
  return stopResult;
}

async function checkExportFileMissing(filePath: string | null): Promise<string | null> {
  if (!filePath) return null;
  try {
    await fs.access(filePath);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `not found at \`${filePath}\``;
    if (code === "EACCES") return `unreadable (permission denied) at \`${filePath}\``;
    return `unreadable at \`${filePath}\` (${code ?? "unknown error"})`;
  }
}

export async function analyzeNativeProfilerIos(
  api: NativeProfilerSessionApi
): Promise<NativeProfilerAnalyzeResult> {
  if (!api.exportedFiles) {
    throw new FailureError("No exported trace data found. Call native-profiler-stop first.", {
      error_code: FAILURE_CODES.PROFILER_NATIVE_TRACE_MISSING,
      failure_stage: "native_profiler_analyze_load_exports",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }

  const [cpuMissing, hangsMissing, leaksMissing] = await Promise.all([
    checkExportFileMissing(api.exportedFiles.cpu ?? null),
    checkExportFileMissing(api.exportedFiles.hangs ?? null),
    checkExportFileMissing(api.exportedFiles.leaks ?? null),
  ]);

  const { bottlenecks, cpuSamples, uiHangs, cpuHotspots, memoryLeaks } =
    await runIosProfilerPipeline(api.exportedFiles, { cpuFilterPid: api.cpuFilterPid });

  api.parsedData = { cpuSamples, uiHangs, cpuHotspots, memoryLeaks };

  const exportErrors: Record<string, string> = {};
  if (!api.exportedFiles.cpu) {
    exportErrors.cpu =
      "CPU time-profile export failed — xctrace could not export CPU data from this trace. " +
      "The trace template may not include a Time Profiler instrument, or the schema name " +
      "did not match any known CPU profile schema (time-profile, cpu-profile, time-sample). " +
      "Check native-profiler-stop output for exportDiagnostics.";
  } else if (cpuMissing) {
    exportErrors.cpu =
      `CPU time-profile export ${cpuMissing} — the trace export claims it succeeded but the ` +
      `file is gone or unreadable, so no CPU data could be analyzed. Re-run native-profiler-stop.`;
  }
  if (!api.exportedFiles.hangs) {
    exportErrors.hangs = "Hangs export failed — no potential-hangs table found in trace.";
  } else if (hangsMissing) {
    exportErrors.hangs =
      `Hangs export ${hangsMissing} — the trace export claims it succeeded but the file is gone ` +
      `or unreadable, so no hang data could be analyzed. Re-run native-profiler-stop.`;
  }
  if (api.exportedFiles.leaks && leaksMissing) {
    exportErrors.leaks =
      `Leaks export ${leaksMissing} — the trace export claims it succeeded but the file is gone ` +
      `or unreadable, so no leak data could be analyzed. Re-run native-profiler-stop.`;
  }

  const payload = {
    metadata: {
      traceFile: api.traceFile,
      platform: "iOS",
      timestamp: new Date().toISOString(),
    },
    bottlenecks,
  };

  return renderNativeProfilerReport({
    payload,
    traceFile: api.traceFile,
    exportErrors,
    // wallClockStartMs is the recording's start time, stamped in-memory at
    // native-profiler-start. A large gap to "now" means analyze is reusing a
    // trace from an earlier capture in this same process run, not a fresh one.
    //
    // Limitation (iOS): unlike Android, iOS has no on-disk metadata sidecar, so
    // profiler-load (which restores only the raw_*.xml) cannot recover the start
    // time — wallClockStartMs is null for a loaded session and this note stays
    // off. The note therefore fires only for a live in-process session, never
    // for one restored from disk. Restoring iOS start-time across loads needs an
    // iOS sidecar this Android-scoped change does not add; formatTraceFreshness
    // degrades cleanly to null in that case. See test/ios-instruments/load-freshness.test.ts.
    freshnessNote: formatTraceFreshness(api.wallClockStartMs, Date.now()) ?? undefined,
  });
}
