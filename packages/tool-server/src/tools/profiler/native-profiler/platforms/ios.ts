import { spawn, execSync, type ChildProcess } from "child_process";
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
import { selectIosCaptureStrategy } from "../../../../utils/ios-profiler/capture-strategy";
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
  throw new FailureError(
    `Argent.tracetemplate not found. Looked in:\n${candidates.map((c) => `  - ${c}`).join("\n")}\n` +
      `Pass template_path explicitly, or rebuild so the template is copied into place.`,
    {
      // A required bundled asset is absent — a packaging/build problem, not a
      // device or subprocess failure — so dependency_missing with no command.
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

  let listAppsOutput: string;
  try {
    listAppsOutput = execSync(`xcrun simctl listapps ${udid} | plutil -convert json -o - -`, {
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

  const installedApps: Record<string, AppInfo> = JSON.parse(listAppsOutput);

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

/** Auto-detect the single running user app to profile, with its host PID. */
function detectRunningApp(udid: string): DetectedApp {
  const runningUserApps = enumerateRunningUserApps(udid);

  if (runningUserApps.length > 1) {
    const appList = runningUserApps
      .map(
        ({ info }) =>
          `  - ${info.CFBundleExecutable} (${info.CFBundleIdentifier}${info.CFBundleDisplayName ? `, "${info.CFBundleDisplayName}"` : ""})`
      )
      .join("\n");
    throw new FailureError(
      `Multiple user apps are running on the simulator:\n${appList}\nSpecify \`app_process\` with the CFBundleExecutable or display name of the app you want to profile.`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_MULTIPLE_RUNNING_USER_APPS,
        failure_stage: "native_profiler_detect_running_user_app",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
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

export interface IosStartParams {
  device_id: string;
  app_process?: string;
  template_path?: string;
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
  const detected = params.app_process
    ? resolveExplicitApp(params.device_id, params.app_process)
    : detectRunningApp(params.device_id);
  const appProcess = detected.executable;

  // Pick the capture approach for this environment. On Xcode versions where
  // `xctrace --device` works this is the original device/attach path; on the
  // 26.4–27.0 regression (where --device deadlocks) it is the host-wide
  // --all-processes fallback, filtered to the app PID. See capture-strategy.
  const strategy = selectIosCaptureStrategy();
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

  const debugDir = await getDebugDir();
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
    .slice(0, 15);
  const outputFile = path.join(debugDir, `native-profiler-${timestamp}.trace`);

  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.lastExitInfo = null;

  const attemptStart = async (): Promise<{ child: ChildProcess; pid: number }> => {
    api.appProcess = appProcess;
    api.traceFile = outputFile;
    // Null for the device strategy (already scoped by --attach); the app PID for
    // the host-wide all-processes fallback, used to filter the exported samples.
    api.cpuFilterPid = strategy.cpuFilterPid(detected);

    const notifyName = `com.argent.ios-profiler.started.${process.pid}.${Date.now()}`;
    const notify = await registerStartupNotify(notifyName);

    const xctraceArgs = strategy.buildRecordArgs({
      templatePath,
      deviceId: params.device_id,
      target: detected,
      outputFile,
      notifyName: notify ? notifyName : undefined,
    });

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
        // the all-processes fallback doesn't attach, so it can't hit this.
        const isColdStart = strategy.attachesByName && msg.includes(COLD_START_SIGNATURE);
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

  const { child: xctraceProcess, pid: xctracePid } = await startWithRetry();

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
    // Same logical failure as the Android analyze guard — keep them on one code
    // so telemetry doesn't split "analyze called before stop" by platform.
    // PROFILER_NATIVE_TRACE_MISSING stays reserved for a trace file missing on
    // disk (see profiler-load).
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
