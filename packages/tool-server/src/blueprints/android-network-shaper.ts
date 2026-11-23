import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import type { NetworkConditions } from "../utils/network-conditions";
import { startShapingProxy } from "../utils/network-shaping-proxy";
import {
  EMULATOR_HOST_ALIAS,
  clearArgentProxy,
  setArgentProxy,
} from "../utils/android-global-proxy";
import { withKeyedLock } from "../utils/keyed-lock";

const ANDROID_NETWORK_SHAPER_NAMESPACE = "AndroidNetworkShaper";

interface AndroidNetworkShaperApi {
  throttle(conditions: NetworkConditions): Promise<void>;
  clear(): Promise<void>;
}

export const androidNetworkShaperBlueprint: ServiceBlueprint<AndroidNetworkShaperApi, string> = {
  namespace: ANDROID_NETWORK_SHAPER_NAMESPACE,

  getURN(serial: string) {
    return `${ANDROID_NETWORK_SHAPER_NAMESPACE}:${serial}`;
  },

  async factory(_deps, serial) {
    let proxyOnDevice = false;
    const locks = new Map<string, Promise<unknown>>();
    const proxy = await startShapingProxy({
      resolveTarget: async (host, port) => ({
        host: host === EMULATOR_HOST_ALIAS ? "127.0.0.1" : host,
        port,
      }),
    });

    const clear = async (): Promise<void> => {
      proxy.setConditions(null);
      await clearArgentProxy(serial);
      proxyOnDevice = false;
    };

    const api: AndroidNetworkShaperApi = {
      throttle: (conditions) =>
        withKeyedLock(locks, serial, async () => {
          proxy.setConditions(conditions);
          proxyOnDevice = true;
          await setArgentProxy(serial, proxy.port);
        }),
      clear: () => withKeyedLock(locks, serial, clear),
    };

    const removeProxyOnStop = async (): Promise<void> => {
      if (proxyOnDevice) await clear();
    };

    const dispose = async (): Promise<void> => {
      await withKeyedLock(locks, serial, removeProxyOnStop).catch((err: unknown) => {
        process.stderr.write(
          `[${ANDROID_NETWORK_SHAPER_NAMESPACE}:${serial}] could not remove the proxy: ${String(err)}\n`
        );
      });
      await proxy.close();
    };

    return { api, dispose, events: new TypedEventEmitter<ServiceEvents>() };
  },
};
