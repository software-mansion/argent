import {
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
  recordingTimeout: NodeJS.Timeout | null;
  recordingTimedOut: boolean;
  recordingExitedUnexpectedly: boolean;
  lastExitInfo: { code: number | null; signal: string | null } | null;
  /** Android-only: path of the .pftrace on the device. */
  androidOnDeviceTracePath: string | null;
}

// Dispose only fires on process shutdown, where an in-flight recording is being
// abandoned: skip the SIGINT finalise grace (that's the native-profiler-stop
// contract) and SIGKILL straight away so shutdown isn't held up.
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
      throw new Error(
        `${NATIVE_PROFILER_SESSION_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use nativeProfilerSessionRef(device) when registering the service ref.`
      );
    }
    const { device } = opts;
    if (device.platform !== "ios" && device.platform !== "android") {
      throw new Error(
        `${NATIVE_PROFILER_SESSION_NAMESPACE}: unsupported platform "${device.platform}" for device '${device.id}'.`
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
        if (state.recordingTimeout) {
          clearTimeout(state.recordingTimeout);
          state.recordingTimeout = null;
        }

        if (state.platform === "ios") {
          const child = state.captureProcess;
          try {
            if (state.profilingActive && child) {
              try {
                child.kill("SIGKILL");
              } catch {
                // already dead
              }
              await waitForChildExit(child, DISPOSE_REAP_MS);
            }
          } finally {
            clearLiveState(state);
          }
          return;
        }

        const onDeviceTracePath = state.androidOnDeviceTracePath;
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
        }
      },
      events,
    };
  },
};
