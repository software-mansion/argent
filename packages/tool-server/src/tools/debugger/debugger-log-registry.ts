import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { LogStats, MessageCluster } from "../../utils/debugger/log-file-writer";
import { DEBUGGER_TOOL_CAPABILITY } from "./debugger-service-ref";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { describeReapedSession, takeReapedSession } from "../../utils/reaped-sessions";
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
   * Why this registry is empty when it should not be — present only when the
   * previous debugger session for this device was torn down by a
   * `stop-all-simulator-servers` with console history captured. Without it an
   * empty registry reads as "the app logged nothing", which is the wrong
   * conclusion to hand an agent debugging a silent app.
   */
  note?: string;
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
Use when investigating warnings, errors, or unexpected output — call this first for an overview, then read the returned file for details. Returns empty stats if no log data has been captured yet — but check { note }, which is present only when the stats are empty BECAUSE a stop-all-simulator-servers tore the previous debugger session down and deleted its log file. Absent that note, empty really does mean the app has logged nothing.
When the debugger cannot be reached, this tool does not fail: it returns { status: "not_connected", reason, detail, guidance } with NO log file — follow the guidance (do not retry in a loop, and do not try to read a log file from this state). A "connected" result's stats may come from a session whose socket has since died — use debugger-status, not this tool, to judge debugger health.`,
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
        const response: LogRegistryResponse = {
          status: "connected" as const,
          ...stats,
          clusters,
          deviceName: api.deviceName,
          appName: api.appName,
          logicalDeviceId: api.logicalDeviceId,
        };

        // Resolving the service above silently RECONNECTED if a teardown had
        // reaped the previous session, so an empty registry here is ambiguous:
        // either the app has logged nothing, or a `stop-all-simulator-servers`
        // deleted the log file. Only the empty case is ambiguous — a registry
        // with entries in it is reporting this session's own capture, and
        // consuming a breadcrumb there would attach a stale explanation to a
        // healthy result.
        if (stats.totalEntries === 0) {
          // Every id this device answers to, and all of them unconditionally — NOT
          // `a ?? b`. The disposer writes ONE event under two keys (the id the
          // caller connected with and the `logicalDeviceId` Metro echoed) so either
          // spelling can read it back. Short-circuiting consumed only the key that
          // matched and left the other behind, where it would attach a stale
          // explanation to a later, unrelated empty read — against the report-once
          // invariant the breadcrumb store states. `forgetDeviceAlias` runs in that
          // same dispose, so by the time this read happens the alias no longer
          // joins the two: the logical id has to come from the freshly resolved
          // api, which is the only thing that still knows it.
          const aliases = [
            canonicalDeviceId(params.device_id),
            params.device_id,
            api.logicalDeviceId,
          ].filter((id): id is string => id !== undefined);
          let reaped: ReturnType<typeof takeReapedSession>;
          for (const id of new Set(aliases)) {
            // Take FIRST, keep second: `reaped ??= take(...)` would short-circuit
            // once one matched and leave the rest behind — the very bug above.
            const entry = takeReapedSession("js-runtime-debugger", id);
            reaped ??= entry;
          }
          if (reaped) response.note = describeReapedSession(reaped, "JS-runtime debugger session");
        }
        return response;
      } catch (err) {
        const reason = classifyNotConnected(err);
        if (!reason) throw err;
        trackDebuggerOutcome("debugger-log-registry", reason, params, ctx);
        return buildNotConnected(reason, err, params);
      }
    },
  };
}
