import * as path from "path";
import type { NativeProfilerSessionApi } from "../../../../blueprints/native-profiler-session";
import { getDebugDir } from "../../../../utils/react-profiler/debug/dump";
import { startPerfetto, stopPerfetto } from "../../../../utils/android-profiler/capture";
import {
  detectAndroidRunningApp,
  validateAndroidAppProcess,
} from "../../../../utils/android-profiler/detect-app";
import { runAndroidProfilerPipeline } from "../../../../utils/android-profiler/pipeline/index";
import { writeAndroidNativeProfilerMetadata } from "../../../../utils/android-profiler/session-metadata";
import { formatTraceFreshness } from "../../../../utils/profiler-shared/freshness";
import type { NativeProfilerAnalyzeResult } from "../../../../utils/ios-profiler/types";
import {
  renderNativeProfilerReport,
  renderTraceProcessorUnavailable,
} from "../../../../utils/ios-profiler/render";
import { RECORDING_CAP_MS } from "../../../../utils/profiler-shared/types";
import { TraceProcessorUnavailableError } from "@argent/native-devtools-android";

export interface AndroidStartParams {
  device_id: string;
  app_process?: string;
}

export async function startNativeProfilerAndroid(
  api: NativeProfilerSessionApi,
  params: AndroidStartParams
): Promise<{ status: "recording"; pid: number; traceFile: string }> {
  if (api.profilingActive) {
    throw new Error(`A native profiling session is already running (PID: ${api.capturePid}).`);
  }

  // An explicit app_process is validated up front (Perfetto won't tell us it's
  // bogus); auto-detection already only returns a real foreground user app.
  const explicit = params.app_process?.trim();
  let appPackage: string;
  if (explicit) {
    await validateAndroidAppProcess(params.device_id, explicit);
    appPackage = explicit;
  } else {
    appPackage = await detectAndroidRunningApp(params.device_id);
  }

  const debugDir = await getDebugDir();
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
    .slice(0, 15);
  const hostTracePath = path.join(debugDir, `native-profiler-${timestamp}.pftrace`);

  // Start perfetto BEFORE mutating any session state: a failed start (adb
  // error, device offline, spawn failure) must be non-destructive. If a prior
  // capture hit the 10-min cap or exited early, its partial trace is still
  // recoverable via native-profiler-stop, and its recordingTimedOut/
  // recordingExitedUnexpectedly/traceFile fields must survive an unrelated
  // failed start attempt — otherwise the pending recovery is silently burned.
  // (Same contract as the iOS start path.)
  const { pid, onDeviceTracePath, child } = await startPerfetto({
    serial: params.device_id,
    appPackage,
    timestamp,
  });

  // Perfetto is up — this capture now owns the session; stamp its descriptors
  // and clear any prior capture's recovery flags (superseded on success only).
  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.lastExitInfo = null;
  api.appProcess = appPackage;
  api.traceFile = hostTracePath;
  api.capturePid = pid;
  api.captureProcess = child;
  api.androidOnDeviceTracePath = onDeviceTracePath;
  api.profilingActive = true;
  api.wallClockStartMs = Date.now();

  api.recordingTimeout = setTimeout(() => {
    // Best-effort SIGTERM to the on-device perfetto daemon; stop tool will pull
    // the partial trace and surface the timeout warning.
    void (async () => {
      try {
        const { adbShell } = await import("../../../../utils/adb");
        await adbShell(params.device_id, `kill -TERM ${pid}`).catch(() => {});
      } catch {
        // best-effort
      }
    })();
    api.profilingActive = false;
    api.recordingTimeout = null;
    api.recordingTimedOut = true;
  }, RECORDING_CAP_MS);

  return {
    status: "recording",
    pid,
    traceFile: hostTracePath,
  };
}

export interface AndroidStopResult {
  traceFile: string;
  exportedFiles: Record<string, string | null>;
  warning?: string;
}

export async function stopNativeProfilerAndroid(
  api: NativeProfilerSessionApi
): Promise<AndroidStopResult> {
  const recoveringPartialTrace = api.recordingTimedOut || api.recordingExitedUnexpectedly;
  if (!api.profilingActive && !recoveringPartialTrace) {
    throw new Error("No active native profiling session found. Call native-profiler-start first.");
  }

  if (!api.traceFile || !api.androidOnDeviceTracePath || !api.capturePid) {
    if (recoveringPartialTrace) {
      throw new Error(
        "Native profiling recording exited unexpectedly and no trace file is available. " +
          "Call native-profiler-start again."
      );
    }
    throw new Error("No active native profiling session found. Call native-profiler-start first.");
  }

  if (api.recordingTimeout) {
    clearTimeout(api.recordingTimeout);
    api.recordingTimeout = null;
  }

  let stopResult: Awaited<ReturnType<typeof stopPerfetto>>;
  try {
    stopResult = await stopPerfetto({
      serial: api.deviceId,
      pid: api.capturePid,
      onDeviceTracePath: api.androidOnDeviceTracePath,
      hostTracePath: api.traceFile,
      recordingTimedOut: api.recordingTimedOut,
    });
  } finally {
    // Always return the session to a clean, startable state — even if the
    // `adb pull` failed (device unplugged mid-stop, on-device file gone, host
    // disk full). Otherwise a transient stop error leaves profilingActive=true,
    // which rejects the next start with "a session is already running" and
    // wedges the user until they happen to re-stop.
    api.profilingActive = false;
    api.capturePid = null;
    api.captureProcess = null;
    api.androidOnDeviceTracePath = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;
  }

  const { hostTracePath, warning } = stopResult;
  api.exportedFiles = { pftrace: hostTracePath };
  if (api.appProcess) {
    await writeAndroidNativeProfilerMetadata(hostTracePath, {
      platform: "android",
      appProcess: api.appProcess,
      wallClockStartMs: api.wallClockStartMs,
    });
  }

  const result: AndroidStopResult = {
    traceFile: hostTracePath,
    exportedFiles: api.exportedFiles,
  };
  if (warning) result.warning = warning;
  return result;
}

export async function analyzeNativeProfilerAndroid(
  api: NativeProfilerSessionApi
): Promise<NativeProfilerAnalyzeResult> {
  if (!api.exportedFiles || !api.exportedFiles.pftrace) {
    throw new Error("No exported trace data found. Call native-profiler-stop first.");
  }

  const hostTracePath = api.exportedFiles.pftrace;
  const appPackage = api.appProcess ?? "";

  let pipelineResult: Awaited<ReturnType<typeof runAndroidProfilerPipeline>>;
  try {
    pipelineResult = await runAndroidProfilerPipeline(hostTracePath, appPackage);
  } catch (err) {
    // Bundled WASM engine failed to load: return a prominent banner
    // (analysis_failed, empty exportErrors so it never renders as a "> Export
    // warnings" list) pointing at the reinstall / ARGENT_TRACE_PROCESSOR_WASM fix.
    if (err instanceof TraceProcessorUnavailableError) {
      api.parsedData = null;
      return {
        report: renderTraceProcessorUnavailable(err),
        reportFile: null,
        bottlenecksTotal: 0,
        status: "analysis_failed",
        exportErrors: {},
      };
    }
    throw err;
  }

  // Android drill-down re-queries the .pftrace; nothing to cache here.
  api.parsedData = null;

  const payload = {
    metadata: {
      traceFile: hostTracePath,
      platform: "Android",
      timestamp: new Date().toISOString(),
    },
    bottlenecks: pipelineResult.bottlenecks,
  };

  return renderNativeProfilerReport({
    payload,
    traceFile: hostTracePath,
    exportErrors: pipelineResult.exportErrors,
    // wallClockStartMs is the recording's start time (set at start, persisted in
    // the metadata sidecar, restored by profiler-load). A large gap to "now"
    // means we're analyzing a trace from an earlier session, not a fresh capture.
    freshnessNote: formatTraceFreshness(api.wallClockStartMs, Date.now()) ?? undefined,
  });
}
