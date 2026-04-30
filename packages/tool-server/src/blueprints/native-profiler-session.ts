import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import type { CpuSample, UiHang, MemoryLeak, CpuHotspot } from "../utils/ios-profiler/types";
import { resolveDevice } from "../utils/device-info";

// The tools that consume this session are cross-platform in name
// (`native-profiler-*`), but today the only backend is xctrace on iOS. When
// Perfetto / simpleperf land, this namespace keeps the same URN shape —
// `NativeProfilerSession:<deviceId>` — and the factory branches on
// `resolveDevice(...).platform` to build either the iOS or Android backend.
export const NATIVE_PROFILER_SESSION_NAMESPACE = "NativeProfilerSession";

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

export const nativeProfilerSessionBlueprint: ServiceBlueprint<NativeProfilerSessionApi, string> = {
  namespace: NATIVE_PROFILER_SESSION_NAMESPACE,

  getURN(deviceId: string) {
    return `${NATIVE_PROFILER_SESSION_NAMESPACE}:${deviceId}`;
  },

  async factory(_deps, _payload) {
    // Android backend (Perfetto / simpleperf) is not implemented yet; reject
    // early so an Android serial gets a clear "not yet" message instead of an
    // opaque xctrace failure deeper in.
    if (resolveDevice(_payload).platform !== "ios") {
      throw new Error(
        `${NATIVE_PROFILER_SESSION_NAMESPACE} currently supports iOS only (xctrace-backed). ` +
          `The target '${_payload}' classifies as Android — Android profiling (Perfetto/simpleperf) is on the roadmap. ` +
          `Pick an iOS udid from list-devices for now.`
      );
    }
    const state: NativeProfilerSessionApi = {
      deviceId: _payload,
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
