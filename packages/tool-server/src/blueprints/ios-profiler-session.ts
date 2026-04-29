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
  recordingTimedOut: boolean;
}

// Matches STOP_GRACE_MS in ios-profiler-stop.ts — both wait on the same
// physical operation (xctrace finalising the .trace bundle after SIGINT).
// A tight bound here re-introduces the §3.4 truncation bug on large traces.
const DISPOSE_FINALIZE_MS = 30_000;

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
        if (state.profilingActive && state.xctracePid) {
          const pid = state.xctracePid;
          try {
            process.kill(pid, "SIGINT");
          } catch {
            // process may already be dead
          }
          // Give xctrace a bounded window to finalise the trace bundle on
          // disk. Without this wait, registry teardown during an active
          // recording produces a truncated .trace.
          const deadline = Date.now() + DISPOSE_FINALIZE_MS;
          while (Date.now() < deadline) {
            try {
              process.kill(pid, 0);
            } catch {
              break;
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // process may already be dead
          }
          state.profilingActive = false;
          state.xctracePid = null;
        }
      },
      events,
    };
  },
};
