import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { CHROMIUM_ID_PREFIX } from "../../utils/device-info";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";
import {
  buildNotConnected,
  classifyNotConnected,
  resolveDebuggerService,
  trackDebuggerOutcome,
  type DebuggerNotConnectedResult,
} from "./not-connected";

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port (ignored for Chromium)"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices — the SAME id you passed to debugger-connect (iOS simulator UDID, Android serial, Vega serial, or Chromium device id). The logicalDeviceId debugger-connect returns also resolves here, but prefer the stable list-devices id."
    ),
});

interface DebuggerConnectedStatus {
  status: "connected";
  port: number;
  projectRoot: string;
  deviceName: string;
  appName: string;
  logicalDeviceId: string | undefined;
  isNewDebugger: boolean;
  connected: true;
  loadedScripts: number;
  enabledDomains: string[];
  sourceMapReady: boolean;
}

export function createDebuggerStatusTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, DebuggerConnectedStatus | DebuggerNotConnectedResult> {
  return {
    id: "debugger-status",
    interaction: {
      startedMsg: () => "Checking JavaScript debugger",
      completedMsg: ({ result }) =>
        result.status === "connected"
          ? "Checked JavaScript debugger"
          : "JavaScript debugger is not connected",
      failedMsg: ({ failureSignal }) =>
        `Failed to check JavaScript debugger: ${failureSignal.error_code}`,
    },
    description: `Get JS runtime debugger connection status and diagnostic info.
Use when you need to verify connectivity before using other debugger tools. Never fails when the runtime is simply unreachable — it returns a discriminated result instead:
- { status: "connected", ... } with port, projectRoot (empty on Chromium and on legacy Metro, e.g. Vega), deviceName, appName, logicalDeviceId (absent on Vega), isNewDebugger (false on the legacy inspector), connected flag, loadedScripts count, and sourceMapReady (always true — waits for pending source maps before returning; no-op on Chromium).
- { status: "not_connected", connected: false, reason, detail, guidance } (port omitted on Chromium) when Metro is not running (reason "metro_not_running"), no app is attached ("no_app_connected"), the device_id matches no target ("device_mismatch"), the CDP endpoint is unreachable, answered malformed, or (Chromium) is up with no drivable page ("cdp_unreachable"), the runtime accepted the connection but never answered ("runtime_unresponsive"), the cached connection went stale ("stale_connection"), or a reconnect is in flight ("reconnecting"). Follow the guidance field — do not retry in a loop.`,
    zodSchema,
    capability: DEBUGGER_TOOL_CAPABILITY,
    // Resolved manually in execute so a not-connected precondition becomes a
    // structured result instead of a tool failure.
    services: () => ({}),
    async execute(_services, params, ctx) {
      try {
        const api = await resolveDebuggerService(registry, params);
        await api.sourceMaps.waitForPending();
        if (!api.cdp.isConnected()) {
          // Socket-state gate: never report status:"connected" over a socket
          // that is not OPEN. An OPEN socket with a hung runtime still reports
          // connected — that case surfaces as DEBUGGER_CDP_REQUEST_TIMEOUT.
          const isChromium = params.device_id?.startsWith(CHROMIUM_ID_PREFIX) ?? false;
          if (isChromium) {
            // The cdp belongs to the ChromiumCdp dependency, so a wrapper
            // dispose cannot heal it; the only non-OPEN window while this
            // service is RUNNING is a transient tab-switch reconnect.
            const result = buildNotConnected(
              "reconnecting",
              new Error("CDP socket is reconnecting (tab switch in progress)"),
              params
            );
            trackDebuggerOutcome("debugger-status", "reconnecting", params, ctx);
            return result;
          }
          // Metro path owns its CDPClient: discard the stale node so the next
          // call reconnects fresh. Tradeoff: dispose closes the LogFileWriter,
          // which DELETES the captured log file — including a path a prior
          // debugger-log-registry call returned (that tool has no socket gate,
          // so it never triggers this). A concurrent terminated cascade may
          // remove the node first; that end state is what we wanted, so a
          // failed dispose is absorbed.
          //
          // Track BEFORE disposing: dispose forgets the device alias, and the
          // outcome's platform classifies through it — tracking after would
          // misreport a forwarded logicalDeviceId's platform.
          trackDebuggerOutcome("debugger-status", "stale_connection", params, ctx);
          const ref = debuggerServiceRef(params);
          await registry.disposeService(typeof ref === "string" ? ref : ref.urn).catch(() => {});
          return buildNotConnected(
            "stale_connection",
            new Error("Cached debugger connection is no longer open"),
            params
          );
        }
        trackDebuggerOutcome("debugger-status", "connected", params, ctx);
        return {
          status: "connected" as const,
          port: api.port,
          projectRoot: api.projectRoot,
          deviceName: api.deviceName,
          appName: api.appName,
          logicalDeviceId: api.logicalDeviceId,
          isNewDebugger: api.isNewDebugger,
          connected: true as const,
          loadedScripts: api.cdp.getLoadedScripts().size,
          enabledDomains: [...api.cdp.getEnabledDomains()],
          sourceMapReady: true,
        };
      } catch (err) {
        const reason = classifyNotConnected(err);
        if (!reason) throw err;
        trackDebuggerOutcome("debugger-status", reason, params, ctx);
        return buildNotConnected(reason, err, params);
      }
    },
  };
}
