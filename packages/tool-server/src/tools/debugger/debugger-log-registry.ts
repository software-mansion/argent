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
      "Device id from `debugger-connect`<flag:macos-apps> (macOS: Mac app id)</flag:macos-apps>."
    ),
  tail: z.coerce
    .number()
    .int()
    .min(1)
    .max(RECENT_PER_LEVEL)
    .optional()
    .describe("Newest entries to inline (default 20)."),
  levels: z
    .array(z.enum(CONSOLE_LEVELS))
    .min(1)
    .optional()
    .describe('Filter inline `entries` by level (e.g. ["warning", "error"]).'),
});

export function createDebuggerLogRegistryTool(
  registry: Registry
): ToolDefinition<z.infer<typeof zodSchema>, LogRegistryResponse | DebuggerNotConnectedResult> {
  return {
    id: "debugger-log-registry",
    description: `Summarize JS console logs captured from React Native<flag:macos-apps> (including Mac apps)</flag:macos-apps> or Chromium, with newest \`entries\` inline (truncated to 300 chars).
Use when investigating warnings, errors, or console output. Check \`entries\` first; Grep \`file\` for older/full lines (never Read it whole; up to 50k lines). Use \`debugger-status\` to check connection health.
Returns \`{ status: "connected", file, entries, clusters, note? }\` (\`note\` flags missing/crashed prior sessions), or \`{ status: "not_connected", reason, guidance }\` (follow guidance; don't retry in a loop). Fails only on invalid input.`,
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
