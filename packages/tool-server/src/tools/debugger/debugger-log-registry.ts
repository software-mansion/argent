import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import {
  RECENT_PER_LEVEL,
  type LogStats,
  type MessageCluster,
  type RecentLogEntry,
} from "../../utils/debugger/log-file-writer";
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
  entries: RecentLogEntry[];
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

const DEFAULT_TAIL = 20;

/** `Runtime.consoleAPICalled.type`, the level names the writer records. */
const CONSOLE_LEVELS = [
  "log",
  "debug",
  "info",
  "error",
  "warning",
  "dir",
  "dirxml",
  "table",
  "trace",
  "clear",
  "startGroup",
  "startGroupCollapsed",
  "endGroup",
  "assert",
  "profile",
  "profileEnd",
  "count",
  "timeEnd",
] as const;

const zodSchema = z.object({
  port: metroPortField,
  device_id: z
    .string()
    .describe(
      "Device id from list-devices: the SAME id you passed to debugger-connect (iOS simulator UDID, Android serial, Vega serial, or Chromium device id). The logicalDeviceId debugger-connect returns also resolves here, but prefer the stable list-devices id."
    ),
  tail: z.coerce
    .number()
    .int()
    .min(1)
    .max(RECENT_PER_LEVEL)
    .optional()
    .describe(
      "How many of the newest console entries to return in `entries`. Default 20, max 100."
    ),
  levels: z
    .array(z.enum(CONSOLE_LEVELS))
    .min(1)
    .optional()
    .describe(
      'Return only entries of these levels in `entries`, e.g. ["warning", "error"]. console.warn is "warning". Stats and clusters stay unfiltered.'
    ),
});

export function createDebuggerLogRegistryTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, LogRegistryResponse | DebuggerNotConnectedResult> {
  return {
    id: "debugger-log-registry",
    description: `Get a summary of all console logs captured from the app's JS runtime.
Returns the log file path, entry counts by level, message clusters (grouped by similarity), and { entries }: the newest console entries inline, oldest first, each message cut to 300 characters. Works against Hermes (iOS / Android / Vega) and V8 (Chromium).
Use when investigating warnings, errors, or unexpected output. Call this first and read { entries }; pass levels: ["warning", "error"] to see only those, and tail (default 20, max 100) for more lines. Grep the returned file only for older lines or full messages, and only if you can read files; never Read it whole, it can hold 50,000 lines. Capture stops at 50,000 entries per session, so past that the stats, clusters and entries no longer change. Returns empty stats if no log data has been captured yet, but check { note }, which is present only when the stats are empty BECAUSE the previous debugger session ended: torn down (its log file deleted) or cut off by an app crash (its log file kept at the path the note names). Without that note, empty means the app has logged nothing.
When the debugger cannot be reached, it returns { status: "not_connected", reason, detail, guidance } with NO log file. Follow the guidance (do not retry in a loop). Grep a log file in this state only when a { note } names one kept from before the app crashed. A "connected" result's stats may come from a session whose socket has since died. Use debugger-status, not this tool, to judge debugger health.`,
    zodSchema,
    readOnly: true,
    interaction: {
      startedMsg: () => "Reading app logs",
      completedMsg: ({ result }) =>
        result.status === "connected"
          ? "Read app logs"
          : "JavaScript debugger is not connected — no logs captured",
      failedMsg: ({ failureSignal }) => `Failed to read app logs: ${failureSignal.error_code}`,
    },
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
        const entries = api.logWriter.getRecent(params.tail ?? DEFAULT_TAIL, params.levels);

        trackDebuggerOutcome("debugger-log-registry", "connected", params, ctx);
        const response: LogRegistryResponse = {
          status: "connected" as const,
          ...stats,
          clusters,
          entries,
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
