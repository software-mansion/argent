import {
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import type {
  CpuSample,
  UiHang,
  MemoryLeak,
  CpuHotspot,
} from "../utils/ios-instruments/types";

export const IOS_INSTRUMENTS_SESSION_NAMESPACE = "IosInstrumentsSession";

export interface IosInstrumentsParsedData {
  cpuSamples: CpuSample[];
  uiHangs: UiHang[];
  cpuHotspots: CpuHotspot[];
  memoryLeaks: MemoryLeak[];
}

export interface IosInstrumentsSessionApi {
  deviceId: string;
  appProcess: string | null;
  xctracePid: number | null;
  traceFile: string | null;
  exportedFiles: Record<string, string | null> | null;
  profilingActive: boolean;
  wallClockStartMs: number | null;
  parsedData: IosInstrumentsParsedData | null;
  recordingTimeout: NodeJS.Timeout | null;
}

export const iosInstrumentsSessionBlueprint: ServiceBlueprint<
  IosInstrumentsSessionApi,
  string
> = {
  namespace: IOS_INSTRUMENTS_SESSION_NAMESPACE,

  getURN(deviceId: string) {
    return `${IOS_INSTRUMENTS_SESSION_NAMESPACE}:${deviceId}`;
  },

  async factory(_deps, _payload) {
    const state: IosInstrumentsSessionApi = {
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
