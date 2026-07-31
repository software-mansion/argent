import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { LogStats, MessageCluster } from "../../utils/debugger/log-file-writer";
import { DEBUGGER_TOOL_CAPABILITY } from "./debugger-service-ref";
import {
  buildNotConnected,
  classifyNotConnected,
  resolveDebuggerService,
  trackDebuggerOutcome,
  type DebuggerNotConnectedResult,
} from "./not-connected";

interface LogRegistryResponse extends LogStats {
  status: "connected";
  clusters: MessageCluster[];
  deviceName: string;
  appName: string;
  logicalDeviceId: string | undefined;
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port (ignored for Chromium)"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices — the SAME id you passed to debugger-connect (iOS simulator UDID, Android serial, Vega serial, or Chromium device id). The logicalDeviceId debugger-connect returns also resolves here, but prefer the stable list-devices id."
    ),
});

export function createDebuggerLogRegistryTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, LogRegistryResponse | DebuggerNotConnectedResult> {
  return {
    id: "debugger-log-registry",
    interaction: {
      startedMsg: () => "Reading app logs",
      completedMsg: ({ result }) =>
        result.status === "connected"
          ? "Read app logs"
          : "JavaScript debugger is not connected — no logs captured",
      failedMsg: ({ failureSignal }) => `Failed to read app logs: ${failureSignal.error_code}`,
    },
    description: `Get a summary of all console logs captured from the app's JS runtime.
Returns the log file path, entry counts by level, and message clusters (grouped by similarity). Works against Hermes (iOS / Android / Vega) and V8 (Chromium).
Use when investigating warnings, errors, or unexpected output — call this first for an overview, then read the returned file for details. Returns empty stats if no log data has been captured yet.
When the debugger cannot be reached, this tool does not fail: it returns { status: "not_connected", reason, detail, guidance } with NO log file — follow the guidance (do not retry in a loop, and do not try to read a log file from this state).`,
    zodSchema,
    capability: DEBUGGER_TOOL_CAPABILITY,
    // Resolved manually in execute so a not-connected precondition becomes a
    // structured result instead of a service-resolution tool failure.
    services: () => ({}),
    async execute(_services, params, ctx) {
      try {
        const api = await resolveDebuggerService(registry, params);
        // Unlike debugger-status, no socket-state gate here: captured logs are
        // readable over a dead socket, and disposing the stale service would
        // close the LogFileWriter — destroying exactly the post-crash logs the
        // caller came for.
        const stats = api.logWriter.getStats();
        const clusters = api.logWriter.getClusters(20);

        trackDebuggerOutcome("debugger-log-registry", "connected", params, ctx);
        return {
          status: "connected" as const,
          ...stats,
          clusters,
          deviceName: api.deviceName,
          appName: api.appName,
          logicalDeviceId: api.logicalDeviceId,
        };
      } catch (err) {
        const reason = classifyNotConnected(err);
        if (!reason) throw err;
        trackDebuggerOutcome("debugger-log-registry", reason, params, ctx);
        return buildNotConnected(reason, err, params);
      }
    },
  };
}
