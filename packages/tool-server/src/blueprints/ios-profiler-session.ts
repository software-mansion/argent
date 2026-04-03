import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import type { CpuSample, UiHang, MemoryLeak, CpuHotspot } from "../utils/ios-profiler/types";

export const IOS_PROFILER_SESSION_NAMESPACE = "IosProfilerSession";

export interface IosProfilerParsedData {
  cpuSamples: CpuSample[];
  uiHangs: UiHang[];
  cpuHotspots: CpuHotspot[];
  memoryLeaks: MemoryLeak[];
}

export interface IosProfilerSessionApi {
  deviceId: string;
  appProcess: string | null;
  xctracePid: number | null;
  traceFile: string | null;
  exportedFiles: Record<string, string | null> | null;
  profilingActive: boolean;
  wallClockStartMs: number | null;
  parsedData: IosProfilerParsedData | null;
  recordingTimeout: NodeJS.Timeout | null;
}

export const iosInstrumentsSessionBlueprint: ServiceBlueprint<IosProfilerSessionApi, string> = {
  namespace: IOS_PROFILER_SESSION_NAMESPACE,

  getURN(deviceId: string) {
    return `${IOS_PROFILER_SESSION_NAMESPACE}:${deviceId}`;
  },

  async factory(_deps, _payload) {
    const state: IosProfilerSessionApi = {
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
