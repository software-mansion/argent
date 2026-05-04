import {
  ServiceRef,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import type { CpuSample, UiHang, MemoryLeak, CpuHotspot } from "../utils/ios-profiler/types";

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
  traceFile: string | null;
  exportedFiles: Record<string, string | null> | null;
  profilingActive: boolean;
  wallClockStartMs: number | null;
  parsedData: NativeProfilerParsedData | null;
  recordingTimeout: NodeJS.Timeout | null;
}

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
      traceFile: null,
      exportedFiles: null,
      profilingActive: false,
      wallClockStartMs: null,
      parsedData: null,
      recordingTimeout: null,
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    return {
      api: state,
      dispose: async () => {
        if (state.recordingTimeout) {
          clearTimeout(state.recordingTimeout);
          state.recordingTimeout = null;
        }
        if (state.profilingActive && state.xctracePid) {
          try {
            process.kill(state.xctracePid, "SIGINT");
          } catch {
            // process may already be dead
          }
          state.profilingActive = false;
        }
      },
      events,
    };
  },
};
