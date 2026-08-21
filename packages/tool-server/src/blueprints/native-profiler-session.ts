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

// Cross-platform session for the `native-profiler-*` tools: iOS drives an xctrace
// child, Android an `adb shell perfetto` child, both behind the shared
// `capturePid`/`captureProcess` fields so only the platform helpers branch.
export const NATIVE_PROFILER_SESSION_NAMESPACE = "NativeProfilerSession";

type NativeProfilerSessionFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export function nativeProfilerSessionRef(device: DeviceInfo): ServiceRef {
  return {
    urn: `${NATIVE_PROFILER_SESSION_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

export interface NativeProfilerParsedData {
  /** iOS only — on Android `parsedData` stays null and drill-down re-queries the .pftrace. */
  cpuSamples: CpuSample[];
  uiHangs: UiHang[];
  cpuHotspots: CpuHotspot[];
  memoryLeaks: MemoryLeak[];
  /**
   * Capture mode of THIS data, frozen at parse time so drill-down consumers
   * (leak_stacks, the combined report) are not re-labeled by a later capture.
   * Null when unknown (session restored from disk).
   */
  mallocStackLogging: boolean | null;
  /**
   * Recording start (wall-clock ms) of THIS data, frozen at parse time: the
   * combined report anchors these hangs, and reading the live session field
   * instead would shift them all once a later capture re-stamps it. Null for
   * iOS sessions restored from disk (no start-time sidecar).
   */
  wallClockStartMs: number | null;
}

export interface NativeProfilerSessionApi {
  deviceId: string;
  platform: "ios" | "android";
  appProcess: string | null;
  /** iOS: xctrace PID. Android: on-device perfetto daemon PID — NOT the adb-shell PID (which exits after `--background-wait`). */
  capturePid: number | null;
  /** iOS: the xctrace ChildProcess. Android: the `adb shell perfetto` ChildProcess, which exits once the daemon is up. */
  captureProcess: ChildProcess | null;
  traceFile: string | null;
  exportedFiles: Record<string, string | null> | null;
  profilingActive: boolean;
  wallClockStartMs: number | null;
  parsedData: NativeProfilerParsedData | null;
  /**
   * iOS-only: PID the exported CPU samples must be filtered to, or null to
   * keep all samples. Taken from the capture strategy at start — only the
   * host-wide all-processes fallback needs it. See
   * utils/ios-profiler/capture-strategy.
   */
  cpuFilterPid: number | null;
  /**
   * iOS-only: whether the IN-FLIGHT (or most recently attempted) recording was
   * cold-launched with MallocStackLogging=1 (native-profiler-start's
   * malloc_stack_logging flag). Stop copies it into `mallocStackLogging`; the
   * split keeps a new start from re-labeling the previous capture's
   * still-loaded data.
   */
  recordingMallocStackLogging: boolean | null;
  /**
   * iOS-only: capture mode of the data in `exportedFiles` (and, via analyze,
   * `parsedData`), so the report layer names it instead of inferring it from
   * the attributed-leak count. Stamped at stop; cleared by profiler-load (the
   * raw_*.xml carry no capture-mode sidecar). Null before any stop, on
   * Android, or after a load.
   */
  mallocStackLogging: boolean | null;
  /**
   * Set by `dispose()` and never cleared: `Registry._teardown` nulls the
   * node's instance, so the next resolve builds a fresh api.
   *
   * `native-profiler-start` checks it after its readiness handshake — a
   * teardown inside that window would otherwise have it report
   * `status: "recording"` for a session the registry no longer has, whose
   * owner's `native-profiler-stop` then answers "call native-profiler-start
   * first".
   */
  disposed: boolean;
  recordingTimeout: NodeJS.Timeout | null;
  recordingTimedOut: boolean;
  recordingExitedUnexpectedly: boolean;
  lastExitInfo: { code: number | null; signal: string | null } | null;
  /** Android-only: path of the .pftrace on the device. */
  androidOnDeviceTracePath: string | null;
}

// Dispose runs on process shutdown and on `stop-all-simulator-servers`, so an
// in-flight capture is being abandoned with nobody waiting on the trace: skip
// the SIGINT finalize grace (that is `native-profiler-stop`'s contract) and
// SIGKILL immediately rather than holding the caller up.
const DISPOSE_REAP_MS = 1_000;
const ANDROID_DISPOSE_ADB_TIMEOUT_MS = 5_000;

/**
 * What survived an iOS teardown. `midCapture` is the arm that was still
 * recording; in the other the 10-minute cap's SIGINT (or xctrace exiting on its
 * own) already ran the finalize pass, so its bundle must not be called
 * half-written.
 */
function iosSalvage(midCapture: boolean, traceFile: string | null): string | undefined {
  if (!traceFile) return undefined;
  return midCapture
    ? `xctrace was killed without its finalize pass, so the partial bundle at ${traceFile} is ` +
        `very likely unreadable — re-profile rather than trying to salvage it.`
    : `The recording had already ended before this teardown (the 10-minute cap, or xctrace ` +
        `exiting on its own), so the bundle at ${traceFile} was finalized and may well be ` +
        `readable — but this session was the only thing that could export it, so re-profile ` +
        `unless you can open that bundle yourself.`;
}

/** The Android twin of {@link iosSalvage}. */
function androidSalvage(midCapture: boolean, onDeviceTracePath: string | null): string {
  if (midCapture) {
    // The kill branch removed the on-device .pftrace and nothing had been
    // pulled to the host, so there is nothing left to point at.
    return (
      "The perfetto daemon was killed and its on-device trace removed, so no trace " +
      "survived — re-profile to capture again."
    );
  }
  // The cap arm sent SIGTERM and cleared `profilingActive`, so the kill branch
  // never ran and the trace is still on the device — but only this session knew
  // to pull it.
  return (
    `The recording had already ended before this teardown (the 10-minute cap), so the ` +
    `on-device trace was left in place${onDeviceTracePath ? ` at ${onDeviceTracePath}` : ""} — ` +
    `but this session was the only thing that could pull it to the host. Re-profile, or ` +
    `\`adb pull\` it yourself.`
  );
}

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
        // Set first, and read by a start still inside its readiness handshake:
        // that start must fail rather than report a recording nothing can
        // reach. See {@link NativeProfilerSessionApi.disposed}.
        state.disposed = true;
        if (state.recordingTimeout) {
          clearTimeout(state.recordingTimeout);
          state.recordingTimeout = null;
        }
        // Read before the teardown below clears it. This capture is destroyed
        // rather than salvaged, so the breadcrumb exists only to stop
        // `native-profiler-stop` answering "call native-profiler-start first"
        // for a session that really did run.
        const midCapture = state.profilingActive;
        // A capture the 10-minute cap or an unexpected exit already ended RAN
        // too: those arms clear `profilingActive` while leaving the trace
        // recoverable via `native-profiler-stop`, so gating on
        // `profilingActive` alone sent that owner back to "you never started
        // one". It is destroyed DIFFERENTLY too — SIGINT already went out (or
        // the process exited itself) — so the salvage text below must not call
        // the bundle half-written.
        const endedCapture =
          (state.recordingTimedOut || state.recordingExitedUnexpectedly) &&
          state.traceFile !== null;
        const abandonedCapture = midCapture || endedCapture;
        const abandonedTrace = state.traceFile;

        if (state.platform === "ios") {
          const child = state.captureProcess;
          try {
            // Regardless of `profilingActive`: `attemptStart` hands the child
            // over BEFORE awaiting xctrace's readiness handshake, so a
            // teardown in that window sees the flag still false while a
            // spawned xctrace is running. Gating the kill on it left xctrace
            // recording into a trace nobody would ever stop.
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
                iosSalvage(midCapture, abandonedTrace)
              );
            }
          }
          return;
        }

        const onDeviceTracePath = state.androidOnDeviceTracePath;
        // ANDROID: the warm-engine cache is keyed by this host trace path
        // (analyze/drill-down/load); read it for the release below.
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
              androidSalvage(midCapture, onDeviceTracePath)
            );
          }
        }

        // ANDROID: free this trace's warm Perfetto engine (trace memory + wasm
        // heap) now instead of waiting out the idle timer / LRU reclaim —
        // teardown is end-of-life. Independent of profilingActive: the engine
        // is booted by analyze/drill-down, after the daemon stops. No-op when
        // unwarmed, and never throws. iOS returned above.
        if (hostTracePath) {
          await disposeWarmEngine(hostTracePath);
        }
      },
      events,
    };
  },
};
