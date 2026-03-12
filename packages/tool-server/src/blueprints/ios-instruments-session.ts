import {
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";

export const IOS_INSTRUMENTS_SESSION_NAMESPACE = "IosInstrumentsSession";

export interface IosInstrumentsSessionApi {
  deviceId: string;
  appProcess: string | null;
  xctracePid: number | null;
  traceFile: string | null;
  exportedFiles: Record<string, string | null> | null;
  profilingActive: boolean;
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
    };

    const events = new TypedEventEmitter<ServiceEvents>();

    return {
      api: state,
      dispose: async () => {
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
