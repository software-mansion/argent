import { spawn, execSync, type ChildProcess } from "child_process";
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
import type { NativeProfilerAnalyzeResult } from "../../../../utils/ios-profiler/types";
import { renderNativeProfilerReport } from "../../../../utils/ios-profiler/render";
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
    throw new Error(
      `Failed to enumerate running processes on simulator ${udid} within ${DETECT_RUNNING_APP_TIMEOUT_MS} ms. ` +
        `Verify the simulator is booted and responsive, then retry. Underlying error: ${msg}`,
      { cause: err }
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
        `Verify the simulator is booted and responsive, then retry. Underlying error: ${msg}`,
      { cause: err }
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
    throw new Error(
      "No running user apps detected on the simulator (only system apps are running). Launch the app first using `launch-app`, then retry."
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
    throw new Error(
      `Multiple user apps are running on the simulator:\n${appList}\nSpecify \`app_process\` with the CFBundleExecutable or display name of the app you want to profile.`
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
    throw new Error(`A native profiling session is already running (PID: ${api.capturePid}).`);
  }

  const templatePath = params.template_path ?? resolveDefaultTemplatePath();
  const detected = params.app_process
    ? resolveExplicitApp(params.device_id, params.app_process)
    : detectRunningApp(params.device_id);
  const appProcess = detected.executable;
  // Attach by PID when we know it (immune to Xcode 26.5's display-name `--attach`
  // matching); fall back to the name when the target isn't running yet.
  const attachTarget = detected.pid != null ? String(detected.pid) : appProcess;

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

    const notifyName = `com.argent.ios-profiler.started.${process.pid}.${Date.now()}`;
    const notify = await registerStartupNotify(notifyName);

    const xctraceArgs = [
      "record",
      "--template",
      templatePath,
      "--device",
      params.device_id,
      "--attach",
      attachTarget,
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
      throw new Error("xctrace process has no pid; cannot resolve start.");
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
        `If the wrong app is being detected, pass app_process explicitly with the CFBundleExecutable or display name.`
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

    const { files: exportedFiles, diagnostics } = exportIosTraceData(traceFile);
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
    throw new Error("No active native profiling session found. Call native-profiler-start first.");
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

  const { files: exportedFiles, diagnostics } = exportIosTraceData(api.traceFile);
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
    throw new Error("No exported trace data found. Call native-profiler-stop first.");
  }

  const [cpuMissing, hangsMissing, leaksMissing] = await Promise.all([
    checkExportFileMissing(api.exportedFiles.cpu ?? null),
    checkExportFileMissing(api.exportedFiles.hangs ?? null),
    checkExportFileMissing(api.exportedFiles.leaks ?? null),
  ]);

  const { bottlenecks, cpuSamples, uiHangs, cpuHotspots, memoryLeaks } =
    await runIosProfilerPipeline(api.exportedFiles);

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
  });
}
