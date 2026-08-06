import {
  FAILURE_CODES,
  FailureError,
  ServiceRef,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import type { ChildProcess } from "child_process";
import type { CpuSample, UiHang, MemoryLeak, CpuHotspot } from "../utils/ios-profiler/types";
import { waitForChildExit } from "../utils/profiler-shared/lifecycle";
import { adbShell } from "../utils/adb";
import { recordReapedSession } from "../utils/reaped-sessions";
import { disposeWarmEngine } from "@argent/native-devtools-android";

// Cross-platform session for the `native-profiler-*` tools: iOS uses an xctrace
// child, Android an `adb shell perfetto` child. Both sit behind platform-agnostic
// fields (`capturePid`, `captureProcess`) so start/stop branch only in helpers.
export const NATIVE_PROFILER_SESSION_NAMESPACE = "NativeProfilerSession";

type NativeProfilerSessionFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export function nativeProfilerSessionRef(device: DeviceInfo): ServiceRef {
  return {
    urn: `${NATIVE_PROFILER_SESSION_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

export interface NativeProfilerParsedData {
  /** iOS only — Android re-queries the .pftrace for drill-down, so this stays null. */
  cpuSamples: CpuSample[];
  uiHangs: UiHang[];
  cpuHotspots: CpuHotspot[];
  memoryLeaks: MemoryLeak[];
  /**
   * Capture mode of THIS parsed data (see the session field of the same name),
   * frozen at parse time so drill-down consumers (leak_stacks, the combined
   * report) stay paired with the data even after a newer capture re-stamps the
   * session. Null when unknown (session restored from disk).
   */
  mallocStackLogging: boolean | null;
  /**
   * Recording start (wall-clock ms) of THIS parsed data, frozen at parse time.
   * The combined report anchors these hangs to wall-clock time; reading the live
   * session `wallClockStartMs` instead would pair frozen hangs with a NEWER
   * capture's start once a second recording re-stamps the session, shifting every
   * hang. Null for iOS sessions restored from disk (no start-time sidecar).
   */
  wallClockStartMs: number | null;
}

export interface NativeProfilerSessionApi {
  deviceId: string;
  platform: "ios" | "android";
  appProcess: string | null;
  /** iOS: xctrace PID. Android: on-device perfetto daemon PID — NOT the adb-shell PID (which exits after `--background-wait`). */
  capturePid: number | null;
  /** iOS: the xctrace ChildProcess. Android: the `adb shell perfetto` ChildProcess (detaches after --background-wait). */
  captureProcess: ChildProcess | null;
  traceFile: string | null;
  exportedFiles: Record<string, string | null> | null;
  profilingActive: boolean;
  wallClockStartMs: number | null;
  parsedData: NativeProfilerParsedData | null;
  /**
   * iOS-only: PID the exported CPU samples must be filtered to, or null to keep
   * all samples. Set by the capture strategy at start — the all-processes
   * fallback records host-wide and filters to the app PID; the device strategy
   * scopes via --attach and leaves this null. See utils/ios-profiler/capture-strategy.
   */
  cpuFilterPid: number | null;
  /**
   * iOS-only: whether the IN-FLIGHT (or most recently attempted) recording was
   * cold-launched with MallocStackLogging=1 (native-profiler-start's
   * malloc_stack_logging flag). Stamped at start, copied into
   * `mallocStackLogging` when stop writes `exportedFiles` — the split keeps a
   * new start from re-labeling the previous capture's still-loaded data.
   */
  recordingMallocStackLogging: boolean | null;
  /**
   * iOS-only: capture mode of the data currently in `exportedFiles` (and, via
   * analyze, `parsedData`) — the report layer names it instead of inferring it
   * from the attributed-leak count. Stamped at stop alongside `exportedFiles`;
   * cleared by profiler-load (the raw_*.xml carry no capture-mode sidecar).
   * Null when unknown — before any stop, on Android, or after a load.
   */
  mallocStackLogging: boolean | null;
  /**
   * Whether this session has been torn down. Set by `dispose()` and never
   * cleared: `Registry._teardown` nulls the node's instance, so the next
   * resolve builds a fresh api rather than reviving this one.
   *
   * Read by `native-profiler-start`, which spawns its capture child and then
   * awaits a readiness handshake. A teardown arriving inside that window
   * destroys the session the start is about to report success for — leaving a
   * `status: "recording"` against a session the registry no longer has, whose
   * owner's `native-profiler-stop` then answers "call native-profiler-start
   * first". Start checks this before returning and fails instead.
   */
  disposed: boolean;
  recordingTimeout: NodeJS.Timeout | null;
  recordingTimedOut: boolean;
  recordingExitedUnexpectedly: boolean;
  lastExitInfo: { code: number | null; signal: string | null } | null;
  /** Android-only: path of the .pftrace on the device. */
  androidOnDeviceTracePath: string | null;
}

// Dispose fires on process shutdown, and on `stop-all-simulator-servers` (which
// reaps every device-owned service, `NativeProfilerSession` among them) — the
// call every agent makes at session end. Either way an in-flight capture is
// being abandoned with nobody waiting on the trace, so skip the SIGINT finalise
// grace (that's the native-profiler-stop contract, and a caller that wants the
// trace calls that) and SIGKILL straight away rather than holding the caller up.
const DISPOSE_REAP_MS = 1_000;
const ANDROID_DISPOSE_ADB_TIMEOUT_MS = 5_000;

function clearLiveState(state: NativeProfilerSessionApi): void {
  state.profilingActive = false;
  state.capturePid = null;
  state.captureProcess = null;
  state.androidOnDeviceTracePath = null;
  state.recordingTimedOut = false;
  state.recordingExitedUnexpectedly = false;
  state.lastExitInfo = null;
}

export const nativeProfilerSessionBlueprint: ServiceBlueprint<
  NativeProfilerSessionApi,
  DeviceInfo
> = {
  namespace: NATIVE_PROFILER_SESSION_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${NATIVE_PROFILER_SESSION_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as NativeProfilerSessionFactoryOptions | undefined;
    if (!opts?.device) {
      throw new FailureError(
        `${NATIVE_PROFILER_SESSION_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use nativeProfilerSessionRef(device) when registering the service ref.`,
        {
          error_code: FAILURE_CODES.NATIVE_PROFILER_FACTORY_OPTIONS_MISSING,
          failure_stage: "native_profiler_session_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    const { device } = opts;
    if (device.platform !== "ios" && device.platform !== "android") {
      throw new FailureError(
        `${NATIVE_PROFILER_SESSION_NAMESPACE}: unsupported platform "${device.platform}" for device '${device.id}'.`,
        {
          error_code: FAILURE_CODES.NATIVE_PROFILER_WRONG_PLATFORM,
          failure_stage: "native_profiler_session_factory_options",
          failure_area: "tool_server",
          error_kind: "unsupported",
        }
      );
    }
    const state: NativeProfilerSessionApi = {
      deviceId: device.id,
      platform: device.platform,
      appProcess: null,
      capturePid: null,
      captureProcess: null,
      traceFile: null,
      exportedFiles: null,
      profilingActive: false,
      wallClockStartMs: null,
      parsedData: null,
      cpuFilterPid: null,
      recordingMallocStackLogging: null,
      mallocStackLogging: null,
      disposed: false,
      recordingTimeout: null,
      recordingTimedOut: false,
      recordingExitedUnexpectedly: false,
      lastExitInfo: null,
      androidOnDeviceTracePath: null,
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    return {
      api: state,
      dispose: async () => {
        // Before anything else, and read by a start still inside its readiness
        // handshake: from here on this session no longer exists, so a start
        // that resumes must fail rather than report a recording nothing can
        // reach. See {@link NativeProfilerSessionApi.disposed}.
        state.disposed = true;
        if (state.recordingTimeout) {
          clearTimeout(state.recordingTimeout);
          state.recordingTimeout = null;
        }
        // Read before the teardown below clears it. A capture killed here is
        // destroyed rather than salvaged — no SIGINT finalize grace, and on
        // Android the on-device trace is removed outright — so the breadcrumb
        // exists purely so `native-profiler-stop` stops answering "call
        // native-profiler-start first" for a session that really did run.
        const abandonedCapture = state.profilingActive;
        const abandonedTrace = state.traceFile;

        if (state.platform === "ios") {
          const child = state.captureProcess;
          try {
            // Whether or not the run has been declared active: `attemptStart`
            // hands the child over BEFORE awaiting xctrace's readiness
            // handshake, so a teardown inside that window sees `profilingActive`
            // still false while a spawned xctrace is very much running. Gating
            // the kill on the flag left it behind, recording into a trace
            // nobody would ever stop.
            if (child) {
              try {
                child.kill("SIGKILL");
              } catch {
                // already dead
              }
              await waitForChildExit(child, DISPOSE_REAP_MS);
            }
          } finally {
            clearLiveState(state);
            if (abandonedCapture) {
              recordReapedSession(
                "native-profiler",
                state.deviceId,
                abandonedTrace
                  ? `xctrace was killed without its finalize pass, so the partial bundle at ` +
                      `${abandonedTrace} is very likely unreadable — re-profile rather than ` +
                      `trying to salvage it.`
                  : undefined
              );
            }
          }
          return;
        }

        const onDeviceTracePath = state.androidOnDeviceTracePath;
        // ANDROID: The warm-engine cache keys on api.traceFile (analyze/drill-down/load);
        // clearLiveState leaves it set, so grab it now for the release below.
        const hostTracePath = state.traceFile;
        try {
          if (state.profilingActive && state.capturePid) {
            await adbShell(state.deviceId, `kill -KILL ${state.capturePid}`, {
              timeoutMs: ANDROID_DISPOSE_ADB_TIMEOUT_MS,
            }).catch(() => {});
            if (onDeviceTracePath) {
              await adbShell(state.deviceId, `rm -f ${onDeviceTracePath}`, {
                timeoutMs: ANDROID_DISPOSE_ADB_TIMEOUT_MS,
              }).catch(() => {});
            }
          }
        } finally {
          clearLiveState(state);
          if (abandonedCapture) {
            recordReapedSession(
              "native-profiler",
              state.deviceId,
              // The on-device .pftrace is removed above, and nothing was pulled
              // to the host yet, so there is genuinely nothing to point at.
              "The perfetto daemon was killed and its on-device trace removed, so no trace " +
                "survived — re-profile to capture again."
            );
          }
        }

        // ANDROID: Free this trace's warm Perfetto engine (trace memory + wasm heap) now
        // rather than waiting out the idle-timer / LRU reclaim — teardown is
        // end-of-life. Independent of profilingActive: the engine is booted by
        // analyze/drill-down, after the daemon stops. No-op when unwarmed;
        // best-effort, never throws. iOS returned above, so this is Android-only.
        if (hostTracePath) {
          await disposeWarmEngine(hostTracePath);
        }
      },
      events,
    };
  },
};
