import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import {
  TAIL_MAX,
  TAIL_MESSAGE_CHARS,
  selectTail,
  type LogStats,
  type MessageCluster,
  type TailEntry,
} from "../../utils/debugger/log-file-writer";
import { DEBUGGER_TOOL_CAPABILITY } from "./debugger-service-ref";
import { metroPortField } from "../../utils/debugger/metro-port";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import {
  describeReapedSession,
  takeReapedSessionAnyId,
  type ReapedSession,
} from "../../utils/reaped-sessions";
import {
  buildNotConnected,
  classifyNotConnected,
  debuggerMetroPort,
  resolveDebuggerService,
  trackDebuggerOutcome,
  type DebuggerNotConnectedResult,
} from "./not-connected";

interface ReapedNote {
  /**
   * Set only when a teardown reaped the previous debugger session while it held
   * captured console output. Without it an empty registry reads as "the app
   * logged nothing".
   */
  note?: string;
  /** The reaped session's newest entries, for a call that passed `tail`. */
  previousSessionEntries?: TailEntry[];
}

interface LogRegistryResponse extends LogStats, ReapedNote {
  status: "connected";
  clusters: MessageCluster[];
  /** The newest `tail` entries (optionally filtered by level), oldest first. */
  entries?: TailEntry[];
  deviceName: string;
  appName: string;
  logicalDeviceId: string | undefined;
}

const CONSOLE_LEVELS = [
  "log",
  "info",
  "debug",
  "warning",
  "error",
  "assert",
  "trace",
  "dir",
  "dirxml",
  "table",
  "clear",
  "count",
  "timeEnd",
  "startGroup",
  "startGroupCollapsed",
  "endGroup",
  "profile",
  "profileEnd",
] as const;

const zodSchema = z
  .object({
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
      .max(TAIL_MAX)
      .optional()
      .describe(
        `Also return the newest N entries (oldest first, each message cut at ${TAIL_MESSAGE_CHARS} chars, with sourceFile and a 0-based sourceLine when the call frame has a source path; React Native frames point at the Metro bundle, so their entries carry no source, while their clusters carry only a sourceLine into that bundle), so you can read the logs without opening the file. At most ${TAIL_MAX}.`
      ),
    levels: z
      .array(z.enum(CONSOLE_LEVELS))
      .min(1)
      .optional()
      .describe('Only with tail: keep entries of these levels, e.g. ["warning","error"].'),
  })
  .refine((p) => !p.levels || p.tail !== undefined, {
    message: "levels filters the tail entries, so pass tail too (e.g. tail: 20).",
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
Use when investigating warnings, errors, or unexpected output. Call this first for an overview. Pass tail (and optionally levels) to get the newest entries in the result itself, since the log file may sit outside the directories you can read; read the returned file only when you need more than that. The file, totalEntries, byLevel and clusters stop at 50,000 entries; past that, { droppedEntries } counts the later entries, of which tail returns only the newest 100 per level. Returns empty stats if no log data has been captured yet, but check { note }, which is present only when the stats are empty BECAUSE the previous debugger session ended: torn down (e.g. by stop-all-simulator-servers) with its log file deleted, or cut off by the app crashing with its log file kept at the path the note names. Absent that note, empty really does mean the app has logged nothing. With tail, a note also brings { previousSessionEntries }: the newest entries of that ended session, filtered by levels, on this one call only, since the note is spent once read. Only the first read after the session ended gets them, and only while the new session has logged nothing and no debugger-connect has run since, so after a crash or teardown pass tail on your first debugger-log-registry call, before debugger-connect.
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
        const entries =
          params.tail !== undefined
            ? api.logWriter.tail({ levels: params.levels, limit: params.tail })
            : undefined;
        const response: LogRegistryResponse = {
          status: "connected" as const,
          ...stats,
          clusters,
          ...(entries ? { entries } : {}),
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
          const reaped = takeReapedSessionAnyId(
            "js-runtime-debugger",
            [canonicalDeviceId(params.device_id), params.device_id, api.logicalDeviceId],
            debuggerMetroPort(params)
          );
          if (reaped) Object.assign(response, explainReaped(reaped, params));
        }
        return response;
      } catch (err) {
        const reason = classifyNotConnected(err);
        if (!reason) throw err;
        trackDebuggerOutcome("debugger-log-registry", reason, params, ctx);
        const result: DebuggerNotConnectedResult & ReapedNote = buildNotConnected(
          reason,
          err,
          params
        );
        const reaped = takeReapedSessionAnyId(
          "js-runtime-debugger",
          [canonicalDeviceId(params.device_id), params.device_id],
          debuggerMetroPort(params)
        );
        if (reaped) Object.assign(result, explainReaped(reaped, params));
        return result;
      }
    },
  };
}

function explainReaped(reaped: ReapedSession, params: z.infer<typeof zodSchema>): ReapedNote {
  const note = describeReapedSession(reaped, "JS-runtime debugger session");
  if (params.tail === undefined || !reaped.logTail) return { note };
  const previousSessionEntries = selectTail(reaped.logTail, {
    levels: params.levels,
    limit: params.tail,
  });
  return { note, previousSessionEntries };
}
