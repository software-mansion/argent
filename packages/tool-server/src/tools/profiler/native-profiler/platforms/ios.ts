import { spawn, execFileSync, type ChildProcess } from "child_process";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { promises as fs } from "fs";
import { existsSync } from "node:fs";
import * as path from "path";
import type { NativeProfilerSessionApi } from "../../../../blueprints/native-profiler-session";
import { describeReapedSession, takeReapedSession } from "../../../../utils/reaped-sessions";
import { deviceSetForUdid, simctlArgsForUdidSync } from "../../../../utils/ios-device-sets";
import { getDebugDir } from "../../../../utils/react-profiler/debug/dump";
import {
  listenForDarwinNotification,
  type NotifyHandle,
} from "../../../../utils/ios-profiler/notify";
import { waitForXctraceReady } from "../../../../utils/ios-profiler/startup";
import { DEFAULT_EXEC_MAX_BUFFER } from "../../../../utils/ios-profiler/run-with-timeout";
import { exportIosTraceData } from "../../../../utils/ios-profiler/export";
import type { ExportDiagnostics, IosExportKey } from "../../../../utils/ios-profiler/export";
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
import {
  isCaptureInFlight,
  inFlightGuardMessage,
} from "../../../../utils/profiler-shared/capture-guard";
import { RECORDING_CAP_MS } from "../../../../utils/profiler-shared/types";

// Two candidates because __dirname differs by build: bundled it is argent/dist/
// (template copied to argent/assets/); in dev it is
// tool-server/dist/tools/profiler/native-profiler/platforms/, four levels below
// dist/, where the build copies the template to utils/ios-profiler/.
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
  throw new FailureError(
    `Argent.tracetemplate not found. Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      `Pass template_path explicitly, or rebuild so the template is copied into place.`,
    {
      // A missing bundled asset is a packaging/build problem, not a device or
      // subprocess failure.
      error_code: FAILURE_CODES.NATIVE_PROFILER_TRACE_TEMPLATE_MISSING,
      failure_stage: "ios_native_profiler_template_resolve",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
    }
  );
}
const STARTUP_TIMEOUT_MS = 10_000;
const DETECT_RUNNING_APP_TIMEOUT_MS = 10_000;
const NOTIFY_REGISTER_TIMEOUT_MS = 2_000;
const MAX_START_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_200;
const COLD_START_SIGNATURE = "Cannot find process matching name:";

// Ceiling, not a fixed wait — 30s SIGTERM'd xctrace mid-package.
const STOP_GRACE_MS = 300_000;
const STOP_TERM_MS = 5_000;
const STOP_KILL_MS = 5_000;

interface AppInfo {
  CFBundleExecutable: string;
  CFBundleIdentifier: string;
  CFBundleDisplayName?: string;
  ApplicationType: string;
}

interface DetectedApp {
  /** CFBundleExecutable — human-readable messages and api.appProcess. */
  executable: string;
  /**
   * Host PID from `launchctl list` — for simulator apps the launchd PID is also
   * the host PID xctrace attaches to. Attaching by PID rather than by name
   * because Xcode 26.5's `xctrace --attach` matches the display name (not
   * CFBundleExecutable, as <= 26.3 did), failing with "Cannot find process
   * matching name". Null when the target is not running; then we attach by name.
   */
  pid: number | null;
}

/**
 * Running user apps with their host PIDs. The PID is the leading column of
 * `launchctl list`; registered-but-not-running apps carry `-` and are skipped.
 */
// Exported for native-profiler-ios-shell-injection.test.ts.
export function enumerateRunningUserApps(udid: string): { info: AppInfo; pid: number }[] {
  let launchctlOutput: string;
  try {
    launchctlOutput = execFileSync(
      "xcrun",
      simctlArgsForUdidSync(udid, ["spawn", udid, "launchctl", "list"]),
      {
        encoding: "utf-8",
        timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
        maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
      }
    );
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
  // (PID, status, label); a non-numeric PID column means registered, not running.
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
 * The auto-detect (attach) and malloc_stack_logging launch paths bail identically
 * when several user apps run and no `app_process` disambiguates them — only the
 * failure_stage differs.
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
 * Match an explicit `app_process` against a running user app's CFBundleExecutable
 * or CFBundleDisplayName. On no match — e.g. the app isn't running yet — returns
 * pid: null so the caller attaches by name and the cold-start retry can kick in.
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
    // `simctl listapps` emits a plist; plutil converts it to JSON from stdin (the
    // trailing `-`, guarded by `--` so it can never be taken for a flag). Two
    // discrete-argv execFileSync calls rather than a piped shell string, so no value
    // (device_id included) is ever interpolated into a shell. Each stage buffers its
    // full stdout in Node, hence run-with-timeout.ts's 256 MiB maxBuffer; Node's
    // 1 MiB default would throw ENOBUFS on a well-populated simulator.
    const listAppsPlist = execFileSync("xcrun", simctlArgsForUdidSync(udid, ["listapps", udid]), {
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
      maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
    });
    listAppsOutput = execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: listAppsPlist,
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
      maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
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
    appPath = execFileSync(
      "xcrun",
      simctlArgsForUdidSync(udid, ["get_app_container", udid, bundleId, "app"]),
      {
        encoding: "utf-8",
        timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
      }
    ).trim();
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
    // CFBundleIdentifier is matched too, as the unique escape hatch: it narrows to
    // exactly one app even when builds share an executable or display name.
    const matches = Object.values(installed).filter(
      (info) =>
        info.ApplicationType === "User" &&
        (info.CFBundleExecutable === appProcess ||
          info.CFBundleDisplayName === appProcess ||
          info.CFBundleIdentifier === appProcess)
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      // The malloc path TERMINATES the resolved app before cold-launching it, so
      // first-match-in-plist-order is unacceptable when installed apps share a
      // display name (dev + prod builds both shown as "MyApp"): an exact executable
      // match wins, otherwise refuse before touching anything. (A bundle id matched
      // uniquely above, so the tie is always on executable/display name.)
      const exact = matches.filter((info) => info.CFBundleExecutable === appProcess);
      if (exact.length === 1) return exact[0];
      const appList = matches
        .map(
          (info) =>
            `  - ${info.CFBundleIdentifier} (CFBundleExecutable ${info.CFBundleExecutable}${info.CFBundleDisplayName ? `, "${info.CFBundleDisplayName}"` : ""})`
        )
        .join("\n");
      throw new FailureError(
        `app_process "${appProcess}" matches multiple installed user apps on simulator ${udid}:\n${appList}\n` +
          `Pass the exact CFBundleIdentifier (the first column above) to select one — the ` +
          `CFBundleExecutable/display name you passed is shared by these builds.`,
        {
          error_code: FAILURE_CODES.NATIVE_PROFILER_LAUNCH_APP_AMBIGUOUS,
          failure_stage: "native_profiler_resolve_app_for_launch",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    throw new FailureError(
      `No installed user app matching "${appProcess}" found on simulator ${udid}. ` +
        `Pass the exact CFBundleIdentifier, CFBundleExecutable, or display name, or omit ` +
        `app_process to auto-detect the running app.`,
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

// Per-capture descriptors (appProcess, traceFile, cpuFilterPid, capture mode) are
// stamped only after a SUCCESSFUL start, so a failed attempt has nothing to reset
// beyond the spawned process handles.
function resetStartState(api: NativeProfilerSessionApi): void {
  api.capturePid = null;
  api.captureProcess = null;
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
 * malloc_stack_logging must cold-launch under `xctrace --device --launch`, so a
 * non-`device` strategy is refused. Attribute the refusal to the ACTUAL cause so
 * the message and telemetry `error_code` don't blame a degraded Xcode that may not
 * be present: `env-override` (the operator forced `ARGENT_IOS_CAPTURE`) vs
 * `degraded-xcode` (the active Xcode has the `--device` recording-start deadlock).
 */
function mallocNonDeviceStrategyError(reason: CaptureStrategyReason): FailureError {
  if (reason.kind === "env-override") {
    return new FailureError(
      `malloc_stack_logging must cold-launch the app under \`xctrace --device\`, but ` +
        `ARGENT_IOS_CAPTURE="${reason.rawValue}" forces the "${reason.strategyName}" capture ` +
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
  // Warm the UDID → device-set cache; the synchronous simctl helpers below read it
  // via simctlArgsForUdidSync and would otherwise target the wrong set.
  await deviceSetForUdid(params.device_id);
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
  // malloc_stack_logging instead cold-launches it *under* xctrace with
  // MallocStackLogging=1, so allocation backtraces exist from the first allocation —
  // without that, leaks are detected but unattributable ("<Call stack limit
  // reached>"). `--env` is honoured only with `--launch`, which needs the .app path.
  const useMallocStackLogging = params.malloc_stack_logging === true;
  let appProcess: string;
  let launchBundlePath: string | null = null;
  // Bundle id the malloc path terminated for its cold start, so a failed start can
  // best-effort relaunch it instead of leaving the user's app dead.
  let mallocRelaunchBundleId: string | null = null;
  // Normal (attach / all-processes) flow only — both stay null in
  // malloc_stack_logging mode, whose `--launch` on `--device` is already scoped.
  let detected: DetectedApp | null = null;
  let strategy: IosCaptureStrategy | null = null;

  // Resolve the output path (getDebugDir mkdirs) BEFORE the branch below: the malloc
  // path terminates the running app, and an mkdir failure after that would leave it
  // dead (the best-effort relaunch only guards the start attempt).
  const debugDir = await getDebugDir();
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
    .slice(0, 15);
  const outputFile = path.join(debugDir, `native-profiler-${timestamp}.trace`);

  if (useMallocStackLogging) {
    // Only `--launch` honours `--env MallocStackLogging=1`, and it needs `--device`,
    // whose recording-start handshake is broken on Xcode 26.4 and later (see
    // capture-strategy) — so this would terminate the running app and capture an empty
    // trace, surfaced only as a downstream "Analysis failed". Refuse BEFORE touching
    // the app. The SIDE-EFFECT-FREE resolver keeps selectIosCaptureStrategy()'s "using
    // the all-processes fallback" stderr line from printing right before the throw, and
    // its reason lets the refusal name the actual cause (forced override vs. Xcode).
    const captureDecision = resolveIosCaptureStrategy();
    // The resolver above stays silent, so a typo'd override would be dropped without
    // a word — and the refusal below could then tell the user to "set
    // ARGENT_IOS_CAPTURE=device" while their fumbled value sits ignored.
    warnIfInvalidCaptureOverride(captureDecision);
    if (captureDecision.strategy.name !== "device") {
      throw mallocNonDeviceStrategyError(captureDecision.reason);
    }
    const info = resolveAppForLaunch(params.device_id, params.app_process);
    appProcess = info.CFBundleExecutable;
    launchBundlePath = getAppBundlePath(params.device_id, info.CFBundleIdentifier);
    // Terminate any running instance so the env var is set from process start
    // (best-effort; not-running is fine).
    try {
      execFileSync(
        "xcrun",
        simctlArgsForUdidSync(params.device_id, [
          "terminate",
          params.device_id,
          info.CFBundleIdentifier,
        ]),
        {
          timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
          stdio: "ignore",
        }
      );
      // The terminate SUCCEEDED, so the app was running and we own killing it. Only
      // then mark it for relaunch — restoring an app the user never had open would be
      // the opposite of "restore what we killed".
      mallocRelaunchBundleId = info.CFBundleIdentifier;
    } catch {
      // app was not running — nothing to terminate, nothing to restore
    }
  } else {
    detected = params.app_process
      ? resolveExplicitApp(params.device_id, params.app_process)
      : detectRunningApp(params.device_id);
    appProcess = detected.executable;

    // On Xcode versions where `xctrace --device` works this is the device/attach path
    // (attaching by PID — immune to Xcode 26.5's display-name `--attach` matching); on
    // the 26.4-and-later deadlock it is the host-wide --all-processes fallback,
    // filtered to the app PID. See capture-strategy.
    strategy = selectIosCaptureStrategy();
    // The all-processes fallback isolates the app by PID, so it needs a live target.
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

  const attemptStart = async (): Promise<{ child: ChildProcess; pid: number }> => {
    const notifyName = `com.argent.ios-profiler.started.${process.pid}.${Date.now()}`;
    const notify = await registerStartupNotify(notifyName);

    let xctraceArgs: string[];
    if (useMallocStackLogging) {
      // The launched command must be the final argument (everything after `--` is the
      // target plus its args). The guard above guarantees `--device` is viable here.
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
        // Cold-start retry applies only to attach-by-name (device strategy); the
        // all-processes fallback never attaches and malloc cold-launches by path.
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
    // The malloc path terminated the running app; if the capture never started,
    // relaunch it. The attach path never terminates, so only this path needs this.
    if (mallocRelaunchBundleId) {
      try {
        execFileSync(
          "xcrun",
          simctlArgsForUdidSync(params.device_id, [
            "launch",
            params.device_id,
            mallocRelaunchBundleId,
          ]),
          {
            timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
            stdio: "ignore",
          }
        );
      } catch {
        // best-effort restore; surface the original start failure regardless
      }
    }
    throw err;
  }
  const { child: xctraceProcess, pid: xctracePid } = started;

  // A `stop-all-simulator-servers` that landed inside the readiness handshake above
  // already destroyed this session — `Registry._teardown` nulled the node's instance,
  // so the owner's `native-profiler-stop` would answer "call native-profiler-start
  // first". Reporting `status: "recording"` would hand back an unreachable session
  // with a trace file on disk. Reap what this attempt spawned instead.
  if (api.disposed) {
    try {
      xctraceProcess.kill("SIGKILL");
    } catch {
      // already dead
    }
    resetStartState(api);
    throw new FailureError(
      `The native profiling session for ${api.deviceId} was torn down by a ` +
        `stop-all-simulator-servers while this start was waiting for xctrace to become ` +
        `ready, so nothing was recorded — one tool-server serves every agent using this ` +
        `argent install, so this may have been another agent ending its session. Call ` +
        `native-profiler-start again.`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN,
        failure_stage: "native_profiler_xctrace_start",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  // Stamp the per-capture descriptors only on SUCCESS: a failed start must leave the
  // previous capture's still-loaded exports fully described for analyze. The stale
  // recovery flags reset here too — clearing them on a FAILED start would make stop's
  // partial-trace recovery for the previous abnormal capture unreachable.
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.lastExitInfo = null;
  api.appProcess = appProcess;
  api.traceFile = outputFile;
  // The in-flight capture's mode; stop copies it into api.mallocStackLogging when it
  // writes exportedFiles. Stamping the report-facing flag here would re-label the
  // previous capture's still-loaded exports/parsedData.
  api.recordingMallocStackLogging = useMallocStackLogging;
  // Null for the device strategy (scoped by --attach) and for a malloc cold launch
  // (scoped by --launch); the app PID only for the host-wide all-processes fallback.
  api.cpuFilterPid = strategy ? strategy.cpuFilterPid(detected!) : null;
  api.profilingActive = true;
  api.wallClockStartMs = Date.now();
  // See the Android twin: a live capture makes any earlier teardown breadcrumb
  // unconsumable, and therefore a future false accusation.
  takeReapedSession("native-profiler", api.deviceId);
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
  exportedFiles: Record<IosExportKey, string | null>;
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
    // Pair the exports with the capture mode of the recording that just ended.
    api.mallocStackLogging = api.recordingMallocStackLogging;

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
    // A teardown reaps NativeProfilerSession and the registry nulls the instance, so
    // `api` here can be a fresh session that never saw the caller's capture. Say that
    // happened rather than "you never started one".
    const reaped = takeReapedSession("native-profiler", api.deviceId);
    throw new FailureError(
      reaped
        ? describeReapedSession(reaped, "native profiling session")
        : "No active native profiling session found. Call native-profiler-start first.",
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_NO_ACTIVE_SESSION,
        failure_stage: "native_profiler_stop_session_state",
        failure_area: "tool_server",
        // Internal session-state, not caller input — matches the react twin
        // REACT_PROFILER_NO_ACTIVE_SESSION and the Android site.
        error_kind: "not_found",
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
  // Pair the exports with the capture mode of the recording that just ended.
  api.mallocStackLogging = api.recordingMallocStackLogging;

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
  // Mid-recording (or with a crashed capture pending recovery), the live session
  // fields (traceFile, cpuFilterPid, wallClockStartMs) belong to the newer capture
  // while exportedFiles still holds the previous one, so analyze would render the old
  // exports under the new trace's name, freshness anchor, and CPU filter PID.
  if (isCaptureInFlight(api)) {
    throw new FailureError(inFlightGuardMessage(api, "analyze"), {
      error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_ALREADY_RUNNING,
      failure_stage: "native_profiler_analyze_session_state",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }
  if (!api.exportedFiles) {
    // Same logical failure as the Android analyze guard — one code so telemetry
    // doesn't split "analyze called before stop" by platform.
    // PROFILER_NATIVE_TRACE_MISSING stays reserved for a trace file missing on disk
    // (see profiler-load).
    throw new FailureError("No exported trace data found. Call native-profiler-stop first.", {
      error_code: FAILURE_CODES.NATIVE_PROFILER_NO_EXPORTED_TRACE,
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

  api.parsedData = {
    cpuSamples,
    uiHangs,
    cpuHotspots,
    memoryLeaks,
    // Freeze the capture mode with the parsed data so drill-down consumers
    // (leak_stacks, combined report) stay paired with it after a newer capture
    // re-stamps the session fields.
    mallocStackLogging: api.mallocStackLogging,
    // Freeze the start time too — the combined report anchors these hangs to
    // wall-clock time and must use THIS capture's start, not a later one's.
    wallClockStartMs: api.wallClockStartMs,
  };

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
    // A large gap between the in-memory start time and "now" means analyze is reusing
    // a trace from an earlier capture in this same process run, not a fresh one.
    //
    // iOS, unlike Android, has no on-disk metadata sidecar, so profiler-load (raw_*.xml
    // only) cannot recover the start time: wallClockStartMs is null for a loaded
    // session, formatTraceFreshness returns null, and the note stays off. See
    // test/ios-instruments/load-freshness.test.ts.
    freshnessNote: formatTraceFreshness(api.wallClockStartMs, Date.now()) ?? undefined,
    // Same live-session-only caveat as wallClockStartMs: profiler-load has no
    // capture-mode sidecar, so a restored session renders with null (the
    // unattributed-leaks note then goes by the attributed-leak count instead).
    mallocStackLogging: api.mallocStackLogging,
  });
}
