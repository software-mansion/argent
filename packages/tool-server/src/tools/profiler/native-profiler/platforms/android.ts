import * as path from "path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { NativeProfilerSessionApi } from "../../../../blueprints/native-profiler-session";
import { describeReapedSession, takeReapedSession } from "../../../../utils/reaped-sessions";
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
    throw new FailureError(
      `A native profiling session is already running (PID: ${api.capturePid}).`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_ALREADY_RUNNING,
        failure_stage: "android_native_profiler_start",
        failure_area: "tool_server",
        error_kind: "validation",
      }
    );
  }

  // Perfetto never reports a bogus app_process, so validate an explicit one up
  // front; auto-detection can only return a real foreground user app.
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

  // Start perfetto BEFORE mutating session state: a failed start must leave a
  // prior capture's recovery flags and traceFile intact, or the partial trace
  // it could still recover via native-profiler-stop is silently burned. (Same
  // contract as the iOS start path.)
  const { pid, onDeviceTracePath, child } = await startPerfetto({
    serial: params.device_id,
    appPackage,
    timestamp,
  });

  // See the iOS twin: a teardown that landed while `startPerfetto` was in
  // flight already destroyed this session, so stamping state onto it would
  // report a recording whose stop answers "call native-profiler-start first".
  // This attempt must reap the daemon itself — the teardown never saw it, since
  // `capturePid` is only handed over below.
  if (api.disposed) {
    const { adbShell } = await import("../../../../utils/adb");
    await adbShell(params.device_id, `kill -KILL ${pid}`).catch(() => {});
    await adbShell(params.device_id, `rm -f ${onDeviceTracePath}`).catch(() => {});
    throw new FailureError(
      `The native profiling session for ${api.deviceId} was torn down by a ` +
        `stop-all-simulator-servers while perfetto was starting, so nothing was recorded — ` +
        `one tool-server serves every agent using this argent install, so this may have been ` +
        `another agent ending its session. Call native-profiler-start again.`,
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_SESSION_TORN_DOWN,
        failure_stage: "android_native_profiler_start",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }

  // Perfetto is up, so this capture owns the session: a prior capture's
  // recovery flags are superseded on success only.
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
  // This capture's own stop will succeed, so an earlier teardown breadcrumb
  // would never be consumed — and would later blame a genuine "no active
  // session" on an unrelated teardown.
  takeReapedSession("native-profiler", api.deviceId);

  api.recordingTimeout = setTimeout(() => {
    // Best-effort SIGTERM to the on-device daemon; the stop tool pulls the
    // partial trace and surfaces the timeout warning.
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
  exportedFiles: Record<AndroidExportKey, string | null>;
  warning?: string;
}

/**
 * The single export an Android stop produces: the pulled `.pftrace` itself.
 * Keyed like {@link IosExportKey} on iOS so kind-classifying consumers are
 * compiler-checked — see native-profiler-stop.
 */
export type AndroidExportKey = "pftrace";

export async function stopNativeProfilerAndroid(
  api: NativeProfilerSessionApi
): Promise<AndroidStopResult> {
  const recoveringPartialTrace = api.recordingTimedOut || api.recordingExitedUnexpectedly;
  if (!api.profilingActive && !recoveringPartialTrace) {
    // See the iOS twin: a teardown leaves a fresh session behind, which without
    // this breadcrumb is indistinguishable from one that never started.
    const reaped = takeReapedSession("native-profiler", api.deviceId);
    throw new FailureError(
      reaped
        ? describeReapedSession(reaped, "native profiling session")
        : "No active native profiling session found. Call native-profiler-start first.",
      {
        error_code: FAILURE_CODES.NATIVE_PROFILER_NO_ACTIVE_SESSION,
        failure_stage: "android_native_profiler_stop",
        failure_area: "tool_server",
        // Internal session-state, not caller input — matches the react twin
        // REACT_PROFILER_NO_ACTIVE_SESSION so the "no active session" family
        // carries one consistent kind.
        error_kind: "not_found",
      }
    );
  }

  if (!api.traceFile || !api.androidOnDeviceTracePath || !api.capturePid) {
    if (recoveringPartialTrace) {
      // Unreachable on Android: `recordingExitedUnexpectedly` is only set on the
      // iOS path, and the recording-cap timeout leaves the trace handles intact.
      // Defensive only — a mid-recording perfetto crash is not flagged yet, so no
      // telemetry code that could never fire on this platform.
      throw new Error(
        "Native profiling recording exited unexpectedly and no trace file is available. " +
          "Call native-profiler-start again."
      );
    }
    // Unreachable in practice: the trace handles are set before `profilingActive`
    // is flipped true and nulled only after it is flipped false, so an active
    // session always has them. Defensive invariant for a programmer/state error,
    // not a user-reachable failure — hence a plain Error with no telemetry code.
    throw new Error(
      "Native profiling session is active but its trace handles are missing — the recording state is inconsistent. " +
        "Call native-profiler-start again."
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
    // Always return the session to a startable state, even when the `adb pull`
    // failed: otherwise profilingActive stays true and rejects the next start
    // with "a session is already running" until the user happens to re-stop.
    api.profilingActive = false;
    api.capturePid = null;
    api.captureProcess = null;
    api.androidOnDeviceTracePath = null;
    api.recordingTimedOut = false;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;
  }

  const { hostTracePath, warning } = stopResult;
  const exportedFiles: Record<AndroidExportKey, string | null> = { pftrace: hostTracePath };
  api.exportedFiles = exportedFiles;
  if (api.appProcess) {
    await writeAndroidNativeProfilerMetadata(hostTracePath, {
      platform: "android",
      appProcess: api.appProcess,
      wallClockStartMs: api.wallClockStartMs,
    });
  }

  const result: AndroidStopResult = {
    traceFile: hostTracePath,
    exportedFiles,
  };
  if (warning) result.warning = warning;
  return result;
}

export async function analyzeNativeProfilerAndroid(
  api: NativeProfilerSessionApi
): Promise<NativeProfilerAnalyzeResult> {
  if (!api.exportedFiles || !api.exportedFiles.pftrace) {
    throw new FailureError("No exported trace data found. Call native-profiler-stop first.", {
      error_code: FAILURE_CODES.NATIVE_PROFILER_NO_EXPORTED_TRACE,
      failure_stage: "android_native_profiler_analyze",
      failure_area: "tool_server",
      error_kind: "validation",
    });
  }

  const hostTracePath = api.exportedFiles.pftrace;
  const appPackage = api.appProcess ?? "";

  let pipelineResult: Awaited<ReturnType<typeof runAndroidProfilerPipeline>>;
  try {
    pipelineResult = await runAndroidProfilerPipeline(hostTracePath, appPackage);
  } catch (err) {
    // Bundled WASM engine failed to load: return a prominent banner instead,
    // with empty exportErrors so it never renders as an "Export warnings" list.
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
    // Recording start time, persisted in the metadata sidecar and restored by
    // profiler-load, so a large gap to "now" means an earlier session's trace.
    freshnessNote: formatTraceFreshness(api.wallClockStartMs, Date.now()) ?? undefined,
    // Explains an absent CPU section when samples exist but carry no stacks.
    cpuDiagnostic: pipelineResult.cpuDiagnostic,
  });
}
