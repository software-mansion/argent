import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import type { CDPClient } from "../utils/debugger/cdp-client";
import type { JsRuntimeDebuggerApi } from "./js-runtime-debugger";
import { NETWORK_INTERCEPTOR_SCRIPT } from "../utils/debugger/scripts/network-interceptor";

export const NETWORK_INSPECTOR_NAMESPACE = "NetworkInspector";

export interface NetworkInspectorApi {
  port: number;
  cdp: CDPClient;
}

export const networkInspectorBlueprint: ServiceBlueprint<NetworkInspectorApi, string> = {
  namespace: NETWORK_INSPECTOR_NAMESPACE,

  // payload is "port:deviceId"
  getURN(payload: string) {
    return `${NETWORK_INSPECTOR_NAMESPACE}:${payload}`;
  },

  getDependencies(payload: string) {
    return { debugger: `JsRuntimeDebugger:${payload}` };
  },

  async factory(deps, _payload) {
    const debuggerApi = deps.debugger as JsRuntimeDebuggerApi;
    const cdp = debuggerApi.cdp;

    // Inject the fetch-level network interceptor. Idempotent — the script
    // guards itself with __argent_network_installed.
    await cdp.evaluate(NETWORK_INTERCEPTOR_SCRIPT).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[NetworkInspector:${debuggerApi.port}] NETWORK_INTERCEPTOR_SCRIPT failed (non-fatal): ${msg}\n`
      );
    });

    const api: NetworkInspectorApi = { port: debuggerApi.port, cdp };

    const events = new TypedEventEmitter<ServiceEvents>();

    cdp.events.on("disconnected", (error) => {
      events.emit(
        "terminated",
        error ??
          new FailureError("CDP disconnected", {
            error_code: FAILURE_CODES.NETWORK_INSPECTOR_CDP_DISCONNECTED,
            failure_stage: "network_inspector_cdp_lifecycle",
            failure_area: "tool_server",
            error_kind: "network",
          })
      );
    });

    return {
      api,
      dispose: async () => {
        // Nothing to dispose — the CDP connection is owned by JsRuntimeDebugger.
      },
      events,
    };
  },
};
