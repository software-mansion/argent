import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import type { ChildProcess } from "child_process";
import type { CpuSample, UiHang, MemoryLeak, CpuHotspot } from "../utils/ios-profiler/types";
import { waitForChildExit } from "../utils/ios-profiler/lifecycle";

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
  recordingExitedUnexpectedly: boolean;
  lastExitInfo: { code: number | null; signal: string | null } | null;
}

// Discard semantics on dispose: registry teardown only fires from process
// shutdown, where any in-flight xctrace recording is being abandoned. Skip the
// SIGINT finalise grace (that is the explicit `ios-profiler-stop` contract)
// and SIGKILL straight away so shutdown is not held up. The partial .trace on
// disk is left in place.
const DISPOSE_REAP_MS = 1_000;

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
