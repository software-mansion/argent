import {
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { discoverMetro } from "../utils/debugger/discovery";
import { selectTarget } from "../utils/debugger/target-selection";
import { CDPClient } from "../utils/debugger/cdp-client";
import { NETWORK_INTERCEPTOR_SCRIPT } from "../utils/debugger/scripts/network-interceptor";

export const NETWORK_INSPECTOR_NAMESPACE = "NetworkInspector";

export interface NetworkInspectorApi {
  port: number;
  cdp: CDPClient;
}

export const networkInspectorBlueprint: ServiceBlueprint<
  NetworkInspectorApi,
  string
> = {
  namespace: NETWORK_INSPECTOR_NAMESPACE,

  getURN(port: string) {
    return `${NETWORK_INSPECTOR_NAMESPACE}:${port}`;
  },

  async factory(_deps, payload) {
    const port = parseInt(payload, 10);

    const metro = await discoverMetro(port);
    const selected = selectTarget(metro.targets, port);

    const cdp = new CDPClient(selected.webSocketUrl);
    await cdp.connect();

    const ignore = () => {};
    await cdp.send("Runtime.enable").catch(ignore);
    await cdp.send("Runtime.runIfWaitingForDebugger").catch(ignore);

    // Inject the fetch-level network interceptor. Idempotent — the script
    // guards itself with __radon_network_installed.
    await cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT).catch(ignore);

    const api: NetworkInspectorApi = { port, cdp };

    const events = new TypedEventEmitter<ServiceEvents>();

    cdp.events.on("disconnected", (error) => {
      events.emit("terminated", error ?? new Error("CDP disconnected"));
    });

    return {
      api,
      dispose: async () => {
        await cdp.disconnect();
      },
      events,
    };
  },
};
