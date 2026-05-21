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

// The tools that consume this session are cross-platform: `native-profiler-*`.
// iOS uses an xctrace child process; Android uses an `adb shell perfetto`
// child whose PID is the on-device perfetto daemon (the host-side adb shell
// exits after `--background-wait` returns). The blueprint stores both shapes
// behind platform-agnostic field names (`capturePid`, `captureProcess`) so
// the start/stop tools branch only inside platform-specific helpers.
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
  /** iOS: xctrace PID. Android: on-device perfetto daemon PID. */
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

// Discard semantics on dispose: registry teardown only fires from process
// shutdown, where any in-flight recording is being abandoned. Skip the
// SIGINT finalise grace (that is the explicit `native-profiler-stop` contract)
// and SIGKILL straight away so shutdown is not held up.
const DISPOSE_REAP_MS = 1_000;

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
        const child = state.captureProcess;
        if (state.profilingActive && child) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead
          }
          // NOTE: on Android, `captureProcess` is the host-side `adb shell
          // perfetto` ChildProcess, which has typically already exited (stdin
          // closed once --background-wait returned). The kill above is a
          // no-op against an already-dead handle; the on-device perfetto
          // daemon keeps running and is owned by `traced`. A future cleanup
          // pass should optionally `adb -s <serial> shell kill -KILL
          // <capturePid>` here to reap the daemon — outside v1 scope because
          // dispose only fires on process shutdown and orphaned recordings
          // self-terminate at the configured duration_ms (currently none) or
          // when the device reboots.
          await waitForChildExit(child, DISPOSE_REAP_MS);
          state.profilingActive = false;
          state.capturePid = null;
          state.captureProcess = null;
        }
      },
      events,
    };
  },
};
