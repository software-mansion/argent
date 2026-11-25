import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import {
  RECENT_PER_LEVEL,
  type LogStats,
  type MessageCluster,
  type RecentLogEntry,
} from "../../utils/debugger/log-file-writer";
import { DEBUGGER_TOOL_CAPABILITY, reapedDebuggerKind } from "./debugger-service-ref";
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
   * Set when a teardown reaped the previous debugger session while it held
   * captured console output (without it an empty registry reads as "the app
   * logged nothing"), or when `file` does not exist or holds fewer entries than were captured.
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
      "Device id used with debugger-connect<flag:macos-apps>. For macOS, use the Mac app id</flag:macos-apps>."
    ),
  tail: z.coerce
    .number()
    .int()
    .min(1)
    .max(RECENT_PER_LEVEL)
    .optional()
    .describe("How many of the newest entries to return in `entries`. Default 20."),
  levels: z
    .array(z.enum(CONSOLE_LEVELS))
    .min(1)
    .optional()
    .describe(
      'Return only these levels in `entries`, e.g. ["warning", "error"]. Stats and clusters stay unfiltered.'
    ),
});

export function createDebuggerLogRegistryTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, LogRegistryResponse | DebuggerNotConnectedResult> {
  return {
    id: "debugger-log-registry",
    description: `Get a summary of all console logs captured from the app's JS runtime, with the newest entries inline in { entries } (oldest first, messages cut to 300 characters).
Returns the log file path, entry counts by level, and message clusters (grouped by similarity). Supports React Native<flag:macos-apps> (including Mac apps)</flag:macos-apps> and Chromium.
Use when investigating warnings, errors, or unexpected output. Read { entries } first; Grep the returned file only for older lines or full messages, and never Read it whole: capture stops at 50,000 lines per session. Returns empty stats if no log data has been captured yet. Check { note }, which is present when { file } does not exist or holds fewer entries than totalEntries counts (failed writes, e.g. a full disk), or when the previous debugger session ended: torn down (its log file deleted) or cut off by an app crash (the note names its kept log file, if it had one). With a note about the previous session, the stats and { entries } hold only what the runtime replayed or logged since. Without a note, empty means the app has logged nothing.
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

        // Every id this device answers to: the disposer files the breadcrumb
        // under the connect id and the `logicalDeviceId` Metro echoed, and
        // `forgetDeviceAlias` ran in that same dispose, so only the freshly
        // resolved api still knows the logical id.
        const reaped = takeReapedSessionAnyId(reapedDebuggerKind(params), [
          canonicalDeviceId(params.device_id),
          params.device_id,
          api.logicalDeviceId,
        ]);
        if (reaped) response.note = describeReapedSession(reaped, "JS-runtime debugger session");
        const inFile = api.logWriter.getFileEntryCount();
        const fileNote = !api.logWriter.hasFile()
          ? `No log file exists at ${stats.file}, so there is nothing to grep: the counts, clusters and { entries } are all that was captured. Usually the disk was full or ~/.argent/tmp was not writable when this session started (if root owns ~/.argent: sudo chown -R "$USER" ~/.argent). Only a new debugger session gets a file: once that is fixed, call stop-all-simulator-servers with devices: ["${canonicalDeviceId(params.device_id)}"], then debugger-connect again.`
          : inFile === 0 && stats.totalEntries > 0
            ? `The log file at ${stats.file} holds none of the ${stats.totalEntries} captured entries: every write to it failed (e.g. a full disk), so there is nothing to grep and the counts, clusters and { entries } are all that was captured. Entries logged once the disk has room are written to it.`
            : inFile < stats.totalEntries
              ? `The log file at ${stats.file} holds only ${inFile} of the ${stats.totalEntries} captured entries: the other writes to it failed (e.g. a full disk or a file-size limit), so byLevel and clusters count entries that grepping it will not find. Entries logged once the disk has room are written to it.`
              : undefined;
        if (fileNote) response.note = response.note ? `${response.note} ${fileNote}` : fileNote;
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
        const reaped = takeReapedSessionAnyId(reapedDebuggerKind(params), [
          canonicalDeviceId(params.device_id),
          params.device_id,
        ]);
        if (reaped) result.note = describeReapedSession(reaped, "JS-runtime debugger session");
        return result;
      }
    },
  };
}
