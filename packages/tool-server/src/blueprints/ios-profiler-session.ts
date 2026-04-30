import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import type { ChildProcess } from "child_process";
import type { CpuSample, UiHang, MemoryLeak, CpuHotspot } from "../utils/ios-profiler/types";
import { shutdownChild } from "../utils/ios-profiler/lifecycle";

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
  xctraceProcess: ChildProcess | null;
  traceFile: string | null;
  exportedFiles: Record<string, string | null> | null;
  profilingActive: boolean;
  wallClockStartMs: number | null;
  parsedData: IosProfilerParsedData | null;
  recordingTimeout: NodeJS.Timeout | null;
  recordingTimedOut: boolean;
}

// Match the SIGINT/SIGTERM/SIGKILL ladder used by ios-profiler-stop. Both
// teardown paths wait on the same physical operation (xctrace finalising the
// .trace bundle after SIGINT) so they share the same timings.
const DISPOSE_GRACE_MS = 30_000;
const DISPOSE_TERM_MS = 5_000;
const DISPOSE_KILL_MS = 5_000;

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
      xctraceProcess: null,
      traceFile: null,
      exportedFiles: null,
      profilingActive: false,
      wallClockStartMs: null,
      parsedData: null,
      recordingTimeout: null,
      recordingTimedOut: false,
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
          await shutdownChild(child, {
            graceMs: DISPOSE_GRACE_MS,
            termMs: DISPOSE_TERM_MS,
            killMs: DISPOSE_KILL_MS,
          });
          state.profilingActive = false;
          state.xctracePid = null;
          state.xctraceProcess = null;
        }
      },
      events,
    };
  },
};
