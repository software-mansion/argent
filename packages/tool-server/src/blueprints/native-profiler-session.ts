import {
  ServiceRef,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import type { ChildProcess } from "child_process";
import type { CpuSample, UiHang, MemoryLeak, CpuHotspot } from "../utils/ios-profiler/types";
import { waitForChildExit } from "../utils/ios-profiler/lifecycle";

// The tools that consume this session are cross-platform in name
// (`native-profiler-*`), but today the only backend is xctrace on iOS. When
// Perfetto / simpleperf land, this namespace keeps the same URN shape —
// `NativeProfilerSession:<deviceId>` — and the factory branches on
// the caller-provided `device.platform` to build either the iOS or Android
// backend without reclassifying.
export const NATIVE_PROFILER_SESSION_NAMESPACE = "NativeProfilerSession";

// Same shape as the other DeviceInfo-routed blueprints: caller threads through
// `options.device`, registry-side URN payload is just `device.id`.
type NativeProfilerSessionFactoryOptions = Record<string, unknown> & { device: DeviceInfo };

export function nativeProfilerSessionRef(device: DeviceInfo): ServiceRef {
  return {
    urn: `${NATIVE_PROFILER_SESSION_NAMESPACE}:${device.id}`,
    options: { device },
  };
}

export interface NativeProfilerParsedData {
  cpuSamples: CpuSample[];
  uiHangs: UiHang[];
  cpuHotspots: CpuHotspot[];
  memoryLeaks: MemoryLeak[];
}

export interface NativeProfilerSessionApi {
  deviceId: string;
  appProcess: string | null;
  xctracePid: number | null;
  xctraceProcess: ChildProcess | null;
  traceFile: string | null;
  exportedFiles: Record<string, string | null> | null;
  profilingActive: boolean;
  wallClockStartMs: number | null;
  parsedData: NativeProfilerParsedData | null;
  recordingTimeout: NodeJS.Timeout | null;
  recordingTimedOut: boolean;
  recordingExitedUnexpectedly: boolean;
  lastExitInfo: { code: number | null; signal: string | null } | null;
}

// Discard semantics on dispose: registry teardown only fires from process
// shutdown, where any in-flight xctrace recording is being abandoned. Skip the
// SIGINT finalise grace (that is the explicit `native-profiler-stop` contract)
// and SIGKILL straight away so shutdown is not held up. The partial .trace on
// disk is left in place.
const DISPOSE_REAP_MS = 1_000;

export const nativeProfilerSessionBlueprint: ServiceBlueprint<
  NativeProfilerSessionApi,
  DeviceInfo
> = {
  namespace: NATIVE_PROFILER_SESSION_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${NATIVE_PROFILER_SESSION_NAMESPACE}:${device.id}`;
  },

  // DeviceInfo travels via options (registry URN-payload channel is string-only).
  async factory(_deps, _payload, options) {
    const opts = options as unknown as NativeProfilerSessionFactoryOptions | undefined;
    if (!opts?.device) {
      throw new Error(
        `${NATIVE_PROFILER_SESSION_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use nativeProfilerSessionRef(device) when registering the service ref.`
      );
    }
    const { device } = opts;
    // Android backend (Perfetto / simpleperf) is not implemented yet; reject
    // early so an Android serial gets a clear "not yet" message instead of an
    // opaque xctrace failure deeper in.
    if (device.platform !== "ios") {
      throw new Error(
        `${NATIVE_PROFILER_SESSION_NAMESPACE} currently supports iOS only (xctrace-backed). ` +
          `The target '${device.id}' classifies as Android — Android profiling (Perfetto/simpleperf) is on the roadmap. ` +
          `Pick an iOS udid from list-devices for now.`
      );
    }
    const state: NativeProfilerSessionApi = {
      deviceId: device.id,
      appProcess: null,
      xctracePid: null,
      xctraceProcess: null,
      traceFile: null,
      exportedFiles: null,
      profilingActive: false,
      wallClockStartMs: null,
      parsedData: null,
      recordingTimeout: null,
      recordingTimedOut: false,
      recordingExitedUnexpectedly: false,
      lastExitInfo: null,
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    return {
      api: state,
      dispose: async () => {
        if (state.recordingTimeout) {
          clearTimeout(state.recordingTimeout);
          state.recordingTimeout = null;
        }
        const child = state.xctraceProcess;
        if (state.profilingActive && child) {
          try {
            child.kill("SIGKILL");
          } catch {
            // already dead
          }
          await waitForChildExit(child, DISPOSE_REAP_MS);
          state.profilingActive = false;
          state.xctracePid = null;
          state.xctraceProcess = null;
        }
      },
      events,
    };
  },
};
