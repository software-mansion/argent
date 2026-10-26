import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { LogStats, MessageCluster } from "../../utils/debugger/log-file-writer";
import { DEBUGGER_TOOL_CAPABILITY } from "./debugger-service-ref";
import { metroPortField } from "../../utils/debugger/metro-port";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { describeReapedSession, takeReapedSessionAnyId } from "../../utils/reaped-sessions";
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
  /**
   * Set only when a teardown reaped the previous debugger session while it held
   * captured console output. Without it an empty registry reads as "the app
   * logged nothing".
   */
  note?: string;
}

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices: the SAME id you passed to debugger-connect (iOS simulator UDID, Android serial, Vega serial, or Chromium device id). The logicalDeviceId debugger-connect returns also resolves here, but prefer the stable list-devices id."
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
Use when investigating warnings, errors, or unexpected output. Call this first for an overview, then read the returned file for details. Returns empty stats if no log data has been captured yet, but check { note }, which is present only when the stats are empty BECAUSE the previous debugger session ended: torn down (e.g. by stop-all-simulator-servers) with its log file deleted, or cut off by the app crashing with its log file kept at the path the note names. Absent that note, empty really does mean the app has logged nothing.
When the debugger cannot be reached, this tool does not fail: it returns { status: "not_connected", reason, detail, guidance } with NO log file. Follow the guidance (do not retry in a loop). Read a log file in this state only when a { note } names one kept from before the app crashed. A "connected" result's stats may come from a session whose socket has since died. Use debugger-status, not this tool, to judge debugger health.`,
    readOnly: true,
    zodSchema,
    capability: DEBUGGER_TOOL_CAPABILITY,
    // Resolved manually in execute so a not-connected precondition becomes a
    // structured result instead of a service-resolution tool failure.
    services: () => ({}),
    async execute(_services, params, ctx) {
      try {
        const api = await resolveDebuggerService(registry, params);
        // No socket-state gate (unlike debugger-status): captured logs are
        // readable over a dead socket.
        const stats = api.logWriter.getStats();
        const clusters = api.logWriter.getClusters(20);

        trackDebuggerOutcome("debugger-log-registry", "connected", params, ctx);
        const response: LogRegistryResponse = {
          status: "connected" as const,
          ...stats,
          clusters,
          deviceName: api.deviceName,
          appName: api.appName,
          logicalDeviceId: api.logicalDeviceId,
        };

        // Resolving above silently reconnects after a teardown, so only an
        // EMPTY registry is ambiguous; one with entries is this session's own
        // capture, and consuming a breadcrumb there would attach a stale
        // explanation to a healthy result.
        if (stats.totalEntries === 0) {
          // Every id this device answers to: the disposer files the breadcrumb
          // under the connect id and the `logicalDeviceId` Metro echoed, and
          // `forgetDeviceAlias` ran in that same dispose, so only the freshly
          // resolved api still knows the logical id.
          const reaped = takeReapedSessionAnyId("js-runtime-debugger", [
            canonicalDeviceId(params.device_id),
            params.device_id,
            api.logicalDeviceId,
          ]);
          if (reaped) response.note = describeReapedSession(reaped, "JS-runtime debugger session");
        }
        return response;
      } catch (err) {
        const reason = classifyNotConnected(err);
        if (!reason) throw err;
        trackDebuggerOutcome("debugger-log-registry", reason, params, ctx);
        const result: DebuggerNotConnectedResult & { note?: string } = buildNotConnected(
          reason,
          err,
          params
        );
        const reaped = takeReapedSessionAnyId("js-runtime-debugger", [
          canonicalDeviceId(params.device_id),
          params.device_id,
        ]);
        if (reaped) result.note = describeReapedSession(reaped, "JS-runtime debugger session");
        return result;
      }
    },
  };
}
