import * as path from "path";
import type { NativeProfilerSessionApi } from "../../../../blueprints/native-profiler-session";
import { getDebugDir } from "../../../../utils/react-profiler/debug/dump";
import { startPerfetto, stopPerfetto } from "../../../../utils/android-profiler/capture";
import { detectAndroidRunningApp } from "../../../../utils/android-profiler/detect-app";
import { runAndroidProfilerPipeline } from "../../../../utils/android-profiler/pipeline/index";
import { writeAndroidNativeProfilerMetadata } from "../../../../utils/android-profiler/session-metadata";
import type { NativeProfilerAnalyzeResult } from "../../../../utils/ios-profiler/types";
import { renderNativeProfilerReport } from "../../../../utils/ios-profiler/render";
import { RECORDING_CAP_MS } from "../../../../utils/profiler-shared/types";

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

  const appPackage = params.app_process ?? (await detectAndroidRunningApp(params.device_id));

  const debugDir = await getDebugDir();
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, (m) => (m === "T" ? "-" : ""))
    .slice(0, 15);
  const hostTracePath = path.join(debugDir, `native-profiler-${timestamp}.pftrace`);

  api.recordingTimedOut = false;
  api.recordingExitedUnexpectedly = false;
  api.lastExitInfo = null;
  api.appProcess = appPackage;
  api.traceFile = hostTracePath;

  const { pid, onDeviceTracePath, child } = await startPerfetto({
    serial: params.device_id,
    appPackage,
    timestamp,
  });

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
    throw new Error(
      "No active native profiling session found. Call native-profiler-start first."
    );
  }

  if (!api.traceFile || !api.androidOnDeviceTracePath || !api.capturePid) {
    if (recoveringPartialTrace) {
      throw new Error(
        "Native profiling recording exited unexpectedly and no trace file is available. " +
          "Call native-profiler-start again."
      );
    }
    throw new Error(
      "No active native profiling session found. Call native-profiler-start first."
    );
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
    // wedges the user until they happen to re-stop. See
    // research/stability_analysis.md #2.
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
  const pipelineResult = await runAndroidProfilerPipeline(hostTracePath, appPackage);

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
  });
}
