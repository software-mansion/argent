import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import type { NetworkConditions } from "../utils/network-conditions";
import { startShapingProxy, type ProxyTarget } from "../utils/network-shaping-proxy";
import {
  EMULATOR_HOST_ALIAS,
  clearArgentProxy,
  listAdbReverses,
  setArgentProxy,
} from "../utils/android-global-proxy";
import { withKeyedLock } from "../utils/keyed-lock";

export const ANDROID_NETWORK_SHAPER_NAMESPACE = "AndroidNetworkShaper";

export function androidNetworkShaperRef(serial: string): string {
  return `${ANDROID_NETWORK_SHAPER_NAMESPACE}:${serial}`;
}

export interface AndroidNetworkShaperApi {
  /** Routes the emulator's HTTP traffic through a proxy with these conditions. */
  throttle(conditions: NetworkConditions, metroPort: number): Promise<void>;
  /** Removes Argent's proxy from the emulator, also one an earlier tool-server left. */
  clear(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["localhost", "::1"]);

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
}

function reachesDevHost(host: string): boolean {
  return host === EMULATOR_HOST_ALIAS || isLoopback(host);
}

/**
 * Loopback on the device names the device itself. A device port that adb reverse
 * forwards reaches the host port behind it; any other device port is out of
 * the proxy's reach.
 */
async function resolveDeviceTarget(
  serial: string,
  host: string,
  port: number
): Promise<ProxyTarget | null> {
  if (host === EMULATOR_HOST_ALIAS) return { host: "127.0.0.1", port };
  if (!isLoopback(host)) return { host, port };
  const hostPort = (await listAdbReverses(serial)).get(port);
  return hostPort === undefined ? null : { host: "localhost", port: hostPort };
}

export const androidNetworkShaperBlueprint: ServiceBlueprint<AndroidNetworkShaperApi, string> = {
  namespace: ANDROID_NETWORK_SHAPER_NAMESPACE,

  getURN(serial: string) {
    return androidNetworkShaperRef(serial);
  },

  async factory(_deps, serial) {
    let metroPort = 0;
    let proxyOnDevice = false;
    const locks = new Map<string, Promise<unknown>>();
    const proxy = await startShapingProxy({
      resolveTarget: (host, port) => resolveDeviceTarget(serial, host, port),
      bypass: (host, port) => reachesDevHost(host) && port === metroPort,
    });

    const clear = async (): Promise<void> => {
      proxy.setConditions(null);
      await clearArgentProxy(serial);
      proxyOnDevice = false;
    };

    const api: AndroidNetworkShaperApi = {
      throttle: (conditions, port) =>
        withKeyedLock(locks, serial, async () => {
          metroPort = port;
          proxy.setConditions(conditions);
          await setArgentProxy(serial, proxy.port);
          proxyOnDevice = true;
        }),
      clear: () => withKeyedLock(locks, serial, clear),
    };

    const dispose = async (): Promise<void> => {
      if (proxyOnDevice) {
        await withKeyedLock(locks, serial, clear).catch((err: unknown) => {
          process.stderr.write(
            `[${ANDROID_NETWORK_SHAPER_NAMESPACE}:${serial}] could not remove the proxy: ${String(err)}\n`
          );
        });
      }
      await proxy.close();
    };

    return { api, dispose, events: new TypedEventEmitter<ServiceEvents>() };
  },
};
