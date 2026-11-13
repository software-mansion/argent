import { execFileSync, type ChildProcess } from "child_process";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { promises as fs } from "fs";
import type { NativeProfilerSessionApi } from "../../../../blueprints/native-profiler-session";
import { externalNativeId } from "../../../../utils/external-devices";
import { describeReapedSession, takeReapedSession } from "../../../../utils/reaped-sessions";
import { deviceSetForUdid, simctlArgsForUdidSync } from "../../../../utils/ios-device-sets";
import { firstSimulatorPoll } from "../../../../utils/simulator-watcher";
import { XcodeFirstLaunchPendingError } from "../../../../utils/dependency-errors";
import { DEFAULT_EXEC_MAX_BUFFER } from "../../../../utils/ios-profiler/run-with-timeout";
import { exportIosTraceData, skippedTraceExport } from "../../../../utils/ios-profiler/export";
import {
  suspensionSpansInTrace,
  type AppSuspensionSpan,
  type AppSuspensionWindow,
  type SuspensionAdjustment,
} from "../../../../utils/ios-profiler/app-suspensions";
import type { ExportDiagnostics, IosExportKey } from "../../../../utils/ios-profiler/export";
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
import {
  appEnded,
  assertNoCaptureRunning,
  waitForStop,
  commitXctraceRecording,
  endXctrace,
  newTraceOutputPath,
  resolveDefaultTemplatePath,
  spawnXctraceRecording,
  xctraceEndWarning,
  xctraceRunErrors,
} from "./xctrace";

const DETECT_RUNNING_APP_TIMEOUT_MS = 10_000;
const MAX_START_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_200;
const COLD_START_SIGNATURE = "Cannot find process matching name:";

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
      simctlArgsForUdidSync(udid, ["spawn", udid, "launchctl", "list"], {
        granted: "native-profiler",
      }),
      {
        encoding: "utf-8",
        timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
        maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
      }
    );
  } catch (err) {
    // Its message says what to do, and a flow step reports only the thrown message.
    if (err instanceof XcodeFirstLaunchPendingError) throw err;
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
  } catch (err) {
    // A refused `simctl` says nothing about the app, so this is not "it isn't running yet".
    if (err instanceof XcodeFirstLaunchPendingError) throw err;
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
    const listAppsPlist = execFileSync(
      "xcrun",
      simctlArgsForUdidSync(udid, ["listapps", udid], { granted: "native-profiler" }),
      {
        encoding: "utf-8",
        timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
        maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
      }
    );
    listAppsOutput = execFileSync("plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      input: listAppsPlist,
      encoding: "utf-8",
      timeout: DETECT_RUNNING_APP_TIMEOUT_MS,
      maxBuffer: DEFAULT_EXEC_MAX_BUFFER,
    });
  } catch (err) {
    if (err instanceof XcodeFirstLaunchPendingError) throw err;
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
      simctlArgsForUdidSync(udid, ["get_app_container", udid, bundleId, "app"], {
        granted: "native-profiler",
      }),
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
        `malloc_stack_logging.`,
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
      `terminate your app and then capture an empty trace. Re-run without malloc_stack_logging, or set ` +
      `ARGENT_IOS_CAPTURE=device to force the device path if you know it works on your host.`,
    {
      error_code: FAILURE_CODES.NATIVE_PROFILER_MALLOC_DEGRADED_XCODE,
      failure_stage: "native_profiler_start_malloc_capability",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

interface IosStartParams {
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

  /**
   * `xctrace --device` resolves a CoreSimulator UDID, and the `ext:` prefix a
   * provider-supplied id carries means nothing outside Argent. simctl argv is
   * substituted by {@linkcode simctlArgsForUdidSync}, this one isn't.
   */
  const xctraceDevice = externalNativeId(params.device_id);

  await waitForStop(api);
  assertNoCaptureRunning(api);

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
  const outputFile = await newTraceOutputPath();

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
    // The relaunch below must not beat injection.
    await firstSimulatorPoll();
    appProcess = info.CFBundleExecutable;
    launchBundlePath = getAppBundlePath(params.device_id, info.CFBundleIdentifier);
    // Terminate any running instance so the env var is set from process start
    // (best-effort; not-running is fine).
    try {
      execFileSync(
        "xcrun",
        simctlArgsForUdidSync(
          params.device_id,
          ["terminate", params.device_id, info.CFBundleIdentifier],
          { granted: "native-profiler" }
        ),
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

  const attemptStart = (): Promise<{ child: ChildProcess; pid: number }> =>
    spawnXctraceRecording(api, (notifyName) => {
      if (useMallocStackLogging) {
        // The launched command must be the final argument (everything after `--` is the
        // target plus its args). The guard above guarantees `--device` is viable here.
        const xctraceArgs = [
          "record",
          "--template",
          templatePath,
          "--device",
          xctraceDevice,
          "--output",
          outputFile,
          "--no-prompt",
          "--env",
          "MallocStackLogging=1",
        ];
        if (notifyName) {
          xctraceArgs.push("--notify-tracing-started", notifyName);
        }
        xctraceArgs.push("--launch", "--", launchBundlePath!);
        return xctraceArgs;
      }
      return strategy!.buildRecordArgs({
        templatePath,
        deviceId: xctraceDevice,
        target: detected!,
        outputFile,
        notifyName,
      });
    });

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
          simctlArgsForUdidSync(
            params.device_id,
            ["launch", params.device_id, mallocRelaunchBundleId],
            { granted: "native-profiler" }
          ),
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
  return commitXctraceRecording(api, started, {
    appProcess,
    traceFile: outputFile,
    mallocStackLogging: useMallocStackLogging,
    // Null for the device strategy (scoped by --attach) and for a malloc cold launch
    // (scoped by --launch); the app PID only for the host-wide all-processes fallback.
    cpuFilterPid: strategy ? strategy.cpuFilterPid(detected!) : null,
  });
}

export interface IosStopResult {
  traceFile: string;
  exportedFiles: Record<IosExportKey, string | null>;
  exportDiagnostics: ExportDiagnostics;
  warning?: string;
}

export function stopNativeProfilerIos(api: NativeProfilerSessionApi): Promise<IosStopResult> {
  // A second stop while the first exports (a client that gave up on a slow stop
  // and sent it again) gets the first one's result, not "no active session".
  if (api.stopInProgress) return api.stopInProgress as Promise<IosStopResult>;
  const stop = stopXctraceRecording(api).finally(() => {
    api.stopInProgress = null;
  });
  api.stopInProgress = stop;
  return stop;
}

async function stopXctraceRecording(api: NativeProfilerSessionApi): Promise<IosStopResult> {
  if ((api.recordingTimedOut || api.recordingExitedUnexpectedly) && api.traceFile) {
    const traceFile = api.traceFile;
    const wasTimeout = api.recordingTimedOut;
    const exitInfo = api.lastExitInfo;
    // The cap ended xctrace as a stop does, and xctrace may still save the trace.
    const cappedEnd = wasTimeout && api.cappedEnd ? await api.cappedEnd : null;
    api.cappedEnd = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;

    const ended = api.recordingAppEnded;
    const suspensions = endSuspensionWatch(api);
    const { files: exportedFiles, diagnostics } = await exportIosTraceData(traceFile, ended);
    api.exportedFiles = exportedFiles;
    // Pair the exports with the capture mode of the recording that just ended.
    api.mallocStackLogging = api.recordingMallocStackLogging;
    api.appEndedDuringCapture = ended;
    api.exportSkipReason = diagnostics.skipped ?? null;
    api.recordedMs = null;
    api.appSuspensions = suspensionSpans(suspensions, diagnostics);

    // When xctrace did not end on the cap's SIGINT, its warning says what is left
    // of the data and to record again.
    const endWarning = cappedEnd ? xctraceEndWarning(cappedEnd) : undefined;
    let warning = wasTimeout
      ? "Recording timed out at 10 min cap; " +
        (endWarning ??
          "exported the partial trace. Call native-profiler-start again for a fresh recording.")
      : `xctrace exited before stop was called (code=${exitInfo?.code ?? "?"}, ` +
        `signal=${exitInfo?.signal ?? "?"}); exported the partial trace. ` +
        (api.platform === "macos"
          ? "Common causes: restart-app or launch-app started the app again, or xctrace was ended from outside. "
          : "Common causes: attached app terminated, simulator daemon restart. ") +
        "Call native-profiler-start again for a fresh recording.";
    if (ended) warning = `${warning} ${APP_ENDED_NOTE}`;
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

  const child = api.captureProcess;
  const recordedMs = Date.now() - (api.wallClockStartMs ?? Date.now());
  // Before xctrace saves the trace and the exports run: an app that quits during
  // them did not quit during the recording.
  const ended = appEnded(api);
  let warning = xctraceEndWarning(await endXctrace(child, api.traceFile, recordedMs));
  if (warning) process.stderr.write(`[native-profiler] ${warning}\n`);

  api.profilingActive = false;
  api.capturePid = null;
  api.captureProcess = null;
  api.recordingExitedUnexpectedly = false;
  api.lastExitInfo = null;
  // After xctrace ended: it suspends the app until then.
  const suspensions = endSuspensionWatch(api);

  // On a Mac app, xctrace can fail to attach and still write an empty trace.
  const runErrors = api.platform === "macos" ? xctraceRunErrors(child) : [];
  const attachFailed = runErrors.some((line) =>
    line.startsWith("Failed to attach to target process")
  );
  if (runErrors.length > 0) {
    const reported = runErrors.join(" ");
    const issues = attachFailed
      ? `xctrace could not attach to ${api.appProcess}, so nothing was recorded. xctrace ` +
        `reported: ${reported} Call native-profiler-start again.`
      : `xctrace reported errors for this recording, so the data may be incomplete: ${reported}`;
    process.stderr.write(`[native-profiler] ${issues}\n`);
    warning = warning ? `${warning} ${issues}` : issues;
  }

  // Each export of an empty trace waits out its timeout.
  const { files: exportedFiles, diagnostics } = attachFailed
    ? skippedTraceExport("xctrace did not attach to the app, so the trace holds no data.")
    : await exportIosTraceData(api.traceFile, ended);
  api.exportedFiles = exportedFiles;
  // Pair the exports with the capture mode of the recording that just ended.
  api.mallocStackLogging = api.recordingMallocStackLogging;
  api.appEndedDuringCapture = ended;
  api.exportSkipReason = diagnostics.skipped ?? null;
  api.recordedMs = api.platform === "macos" && api.wallClockStartMs !== null ? recordedMs : null;
  api.appSuspensions = suspensionSpans(suspensions, diagnostics);
  if (ended) {
    // xctrace keeps recording when the app crashes, and the trace then lacks
    // most of what came before.
    warning = [warning, APP_ENDED_NOTE].filter(Boolean).join(" ");
  }

  const stopResult: IosStopResult = {
    traceFile: api.traceFile,
    exportedFiles,
    exportDiagnostics: diagnostics,
  };
  if (warning) stopResult.warning = warning;
  return stopResult;
}

/** Ends the Mac app's suspension watch: what it saw, or null when nothing watched. */
function endSuspensionWatch(api: NativeProfilerSessionApi): AppSuspensionWindow[] | null {
  const watch = api.suspensionWatch;
  api.suspensionWatch = null;
  return watch ? watch.end() : null;
}

function suspensionSpans(
  windows: AppSuspensionWindow[] | null,
  diagnostics: ExportDiagnostics
): AppSuspensionSpan[] | null {
  if (!windows || diagnostics.traceStartMs === undefined) return null;
  return suspensionSpansInTrace(windows, diagnostics.traceStartMs, diagnostics.traceDurationMs);
}

const APP_ENDED_NOTE =
  "The app quit, crashed or was restarted during the recording, and xctrace keeps only part " +
  "of what the app did before that, so the report can miss CPU work, hangs and leaks of that " +
  "time. Profile the scenario again with the app running until native-profiler-stop.";

// Measured on two Mac apps that argent drove: each check held up taps and describe for about
// 10 s, and the report showed hangs of 11 to 14 s where the app did no heavy work. The same
// actions under the Time Profiler template showed no hang, and that template still found a
// 1.5 s and a 2 s hang of the app.
const LEAK_CHECK_HANG_NOTE =
  "Instruments pauses a Mac app for several seconds while it checks the app for leaks, about " +
  "every 11 s. A hang, mainly one that began at a tap or a describe, can be this pause and not " +
  "the app's own work. To check a hang, record the same actions again with `template_path: \"Time " +
  'Profiler"`, which records hangs and CPU samples but does not check for leaks.';

/**
 * Says what the pipeline took out of the hangs when argent watched the Mac app's
 * suspensions, in place of LEAK_CHECK_HANG_NOTE. Each leak check suspended the
 * whole app, so a hang that began before or during one included it. Null when
 * no hang changed.
 */
function suspensionNote(adjustment: SuspensionAdjustment, leaksRecorded: boolean): string | null {
  const { pauses, pausedMs, removedHangs, adjustedHangs } = adjustment;
  if (removedHangs === 0 && adjustedHangs === 0) return null;
  const seconds = `${(pausedMs / 1000).toFixed(1)} s`;
  const times = pauses === 1 ? `once (${seconds})` : `${pauses} times (${seconds} in all)`;
  const thePauses = pauses === 1 ? "the pause" : "the pauses";
  const hangs = (n: number) => (n === 1 ? "hang" : "hangs");
  const changes: string[] = [];
  if (removedHangs > 0) {
    changes.push(
      `left out ${removedHangs} ${hangs(removedHangs)} that ${removedHangs === 1 ? "was" : "were"} ` +
        `only ${pauses === 1 ? "this pause" : "these pauses"}`
    );
  }
  if (adjustedHangs > 0) {
    changes.push(
      `took ${thePauses} out of the length of ${adjustedHangs} ` +
        `${removedHangs > 0 ? "other " : ""}${hangs(adjustedHangs)}`
    );
  }
  return leaksRecorded
    ? `> ℹ️ **Leak-check pauses:** Instruments held the app suspended ${times} to check it for ` +
        `leaks. argent ${changes.join(", and ")}.`
    : `> ℹ️ **App pauses:** macOS held the app suspended ${times}. argent ${changes.join(", and ")}.`;
}

// Measured on Mac apps with the Argent template: the first leak check began 3.7 s after the
// start returned and the next ones about every 11 s. A leak is in the trace only after a check
// that began after it has ended, and a check took up to about 10 s on an app that argent drove:
// a stop 8 s after the start found no leak at all, and a leak made just after a check began was
// missing 15 s later and present 20 s later.
const SHORT_LEAK_RECORDING_MS = 20_000;

function shortLeakRecordingNote(recordedMs: number): string {
  return (
    `No leak was found, but the recording lasted only ${Math.round(recordedMs / 1000)} s. ` +
    `Instruments begins its first leak check about 4 s after native-profiler-start returns, ` +
    `and a check can take several seconds, so this trace may hold no finished check. Do not report the app as leak-free: record again, and keep recording ` +
    `about 25 s after the action to check.`
  );
}

/**
 * Whether a leaks export holds the trace's Leaks detail, also when it has no row.
 * Measured on a Mac app with `template_path: "Time Profiler"`, which has no Leaks
 * instrument: the xctrace of Xcode 26.6 exports `<trace-query-result>` with no node
 * in it and exits 0. The xctrace of Xcode 27.2 fails that export.
 */
async function leaksDetailExported(filePath: string): Promise<boolean> {
  try {
    return /<node[\s>]/.test(await fs.readFile(filePath, "utf8"));
  } catch {
    return false;
  }
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
  // Until the stop has exported the trace, exportedFiles holds the previous
  // recording's tables.
  await waitForStop(api);
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

  // Null on iOS and when argent did not watch the Mac app: the hangs stay as recorded.
  const appSuspensions = api.platform === "macos" ? api.appSuspensions : null;
  const {
    bottlenecks,
    cpuSamples,
    uiHangs,
    cpuHotspots,
    memoryLeaks,
    toolingCpuMs,
    totalCpuMs,
    suspensionAdjustment,
  } = await runIosProfilerPipeline(api.exportedFiles, {
    cpuFilterPid: api.cpuFilterPid,
    appSuspensions,
  });

  // No leaks export means no leak data, not zero leaks: a trace whose template
  // has the Leaks instrument exports an empty table when nothing leaked. The
  // all-processes fallback records the built-in Time Profiler template, which
  // has none. A leaks file that stop wrote but is now gone or unreadable is no
  // leak data either. On a Mac app, so is a leaks export with no Leaks detail in it.
  const leaksRecorded =
    api.exportedFiles.leaks != null &&
    !leaksMissing &&
    (api.platform !== "macos" ||
      memoryLeaks.length > 0 ||
      (await leaksDetailExported(api.exportedFiles.leaks)));

  api.parsedData = {
    cpuSamples,
    uiHangs,
    cpuHotspots,
    memoryLeaks,
    leaksRecorded,
    // Freeze the capture mode with the parsed data so drill-down consumers
    // (leak_stacks, combined report) stay paired with it after a newer capture
    // re-stamps the session fields.
    mallocStackLogging: api.mallocStackLogging,
    // Freeze the start time too — the combined report anchors these hangs to
    // wall-clock time and must use THIS capture's start, not a later one's.
    wallClockStartMs: api.wallClockStartMs,
  };

  const exportErrors: Record<string, string> = {};
  const skipped = api.exportSkipReason
    ? `Not exported: ${api.exportSkipReason} Call native-profiler-start for a new recording.`
    : null;
  if (!api.exportedFiles.cpu && skipped) {
    exportErrors.cpu = skipped;
  } else if (!api.exportedFiles.cpu) {
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
    exportErrors.hangs =
      skipped ?? "Hangs export failed — no potential-hangs table found in trace.";
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
      platform: api.platform === "macos" ? "macOS" : "iOS",
      timestamp: new Date().toISOString(),
    },
    bottlenecks,
  };

  const shortLeakNote =
    api.platform === "macos" &&
    leaksRecorded &&
    memoryLeaks.length === 0 &&
    api.recordedMs !== null &&
    api.recordedMs < SHORT_LEAK_RECORDING_MS
      ? shortLeakRecordingNote(api.recordedMs)
      : null;

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
    // All are warnings about the capture itself, shown at the top of the report.
    freshnessNote:
      [
        formatTraceFreshness(api.wallClockStartMs, Date.now()),
        api.appEndedDuringCapture
          ? `> ⚠️ **The app ended during the recording:** ${APP_ENDED_NOTE}`
          : null,
        api.platform === "macos" && appSuspensions === null && leaksRecorded && uiHangs.length > 0
          ? `> ⚠️ **Hangs and the leak check:** ${LEAK_CHECK_HANG_NOTE}`
          : null,
        suspensionAdjustment ? suspensionNote(suspensionAdjustment, leaksRecorded) : null,
        shortLeakNote ? `> ⚠️ **Memory leaks:** ${shortLeakNote}` : null,
      ]
        .filter(Boolean)
        .join("\n\n") || undefined,
    // Same live-session-only caveat as wallClockStartMs: profiler-load has no
    // capture-mode sidecar, so a restored session renders with null (the
    // unattributed-leaks note then goes by the attributed-leak count instead).
    mallocStackLogging: api.mallocStackLogging,
    leaksRecorded,
    mayMissFindings: api.appEndedDuringCapture || shortLeakNote !== null,
    cpuDiagnostic: toolingNote(toolingCpuMs, totalCpuMs, api.platform === "macos"),
  });
}

/**
 * Names the CPU time that the hotspots leave out because a tool spent it inside
 * the app: argent's library while an agent drives the app during the recording
 * (on a Mac app, describe and taps), and the recorder that Instruments'
 * Allocations instrument injects.
 */
function toolingNote(
  toolingMs: { argent: number; instruments: number } | undefined,
  totalMs: number | undefined,
  macApp: boolean
): string | undefined {
  if (!toolingMs || !totalMs || !(totalMs > 0)) return undefined;
  const share = (ms: number) => {
    const pct = Math.round((ms / totalMs) * 100);
    return pct < 1 ? "<1%" : `${pct}%`;
  };
  const parts: string[] = [];
  if (toolingMs.argent > 0) {
    parts.push(
      `${toolingMs.argent} ms (${share(toolingMs.argent)}) were argent's own work inside the app` +
        (macApp ? `, such as describe and taps,` : ``) +
        ` while the trace recorded`
    );
  }
  if (toolingMs.instruments > 0) {
    parts.push(
      `${toolingMs.instruments} ms (${share(toolingMs.instruments)}) were the recorder that ` +
        `Instruments loads into the app to track allocations`
    );
  }
  if (parts.length === 0) return undefined;
  return (
    `Of the CPU samples, ${parts.join(", and ")}. They are left out of the CPU hotspots. A hang ` +
    `whose suspects are marked "argent's own library" or "Instruments' own library" was caused ` +
    `by that tool, not the app.`
  );
}
