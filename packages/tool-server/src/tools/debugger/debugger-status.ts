import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { CHROMIUM_ID_PREFIX } from "../../utils/device-info";
import { DEBUGGER_TOOL_CAPABILITY, debuggerServiceRef } from "./debugger-service-ref";
import { metroPortField } from "../../utils/debugger/metro-port";
import {
  buildNotConnected,
  classifyNotConnected,
  resolveDebuggerService,
  trackDebuggerOutcome,
  type DebuggerNotConnectedResult,
} from "./not-connected";

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

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from `debugger-connect`<flag:macos-apps> (macOS: Mac app id)</flag:macos-apps>."
    ),
});

export function createDebuggerStatusTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, DebuggerConnectedStatus | DebuggerNotConnectedResult> {
  return {
    id: "debugger-status",
    description: `Check JS runtime debugger connectivity and diagnostics.
Use when verifying debugger health before other \`debugger-*\` tools.
Returns \`{ status: "connected", port, projectRoot, deviceName, appName, logicalDeviceId, isNewDebugger, loadedScripts, sourceMapReady }\` or \`{ status: "not_connected", reason, detail, guidance }\` (follow \`guidance\`; don't retry in a loop). Fails only on invalid input.`,
    zodSchema,
    readOnly: true,
    interaction: {
      startedMsg: () => "Checking JavaScript debugger",
      completedMsg: ({ result }) =>
        result.status === "connected"
          ? "Checked JavaScript debugger"
          : "JavaScript debugger is not connected",
      failedMsg: ({ failureSignal }) =>
        `Failed to check JavaScript debugger: ${failureSignal.error_code}`,
    },
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
          // call reconnects fresh. A concurrent terminated cascade may remove
          // the node first; that end state is what we wanted, so a failed
          // dispose is absorbed.
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
