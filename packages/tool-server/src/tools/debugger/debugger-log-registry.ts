import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import type { LogStats, MessageCluster } from "../../utils/debugger/log-file-writer";
import { DEBUGGER_TOOL_CAPABILITY, debuggerReapedScope } from "./debugger-service-ref";
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
   * Whatever would make the rest of this answer misleading on its own, in the
   * two states where something does — and both sentences when both hold. The
   * first carries a further clause of its own where that teardown's record
   * replaced an earlier one nobody read: how many went unreported, and whether
   * one of their log files went with it, whether anything they left is still in
   * `~/.argent/tmp` under no name, or both.
   *
   * - This registry is a new session's, minted after the previous one for this
   *   device was torn down holding console history — by a
   *   `stop-all-simulator-servers`, or by its runtime going away. Without it a
   *   zero here reads as "nothing was ever logged on this device", which is
   *   wrong about the session that just died. Names the old log file when that
   *   teardown left it on disk, which a runtime death does unless its writer
   *   never opened one.
   * - {@link LogStats.file} names a path that is not there: `open()` failed and
   *   the writer buffered instead, or something removed the file after it was
   *   written. The counts and clusters are real; the file is not.
   */
  note?: string;
}

/**
 * Consume the breadcrumb the previous session's dispose left. The store files
 * one teardown under every id its device answered to and spends them together,
 * so the id the caller named finds it whichever one that is.
 *
 * That id and no other. The resolved session's own `logicalDeviceId` is not a
 * candidate: Metro answers an unmatched device_id with its single remaining
 * target rather than failing (`selectTarget`'s one-device fallback), so that id
 * can belong to a different device, whose breadcrumb this read would then
 * consume and report as its own.
 */
function takeReapedNote(deviceId: string, scope?: string): string | undefined {
  const entry = takeReapedSession("js-runtime-debugger", deviceId, scope);
  return entry ? describeReapedSession(entry, "JS-runtime debugger session") : undefined;
}

const zodSchema = z.object({
  port: z.coerce.number().default(8081).describe("Metro server port (ignored for Chromium)"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices — the SAME id you passed to debugger-connect (iOS simulator UDID, Android serial, Vega serial, or Chromium device id). On Metro the logicalDeviceId debugger-connect returns also resolves here for as long as that session lives, but prefer the stable list-devices id: once the session ends the alias goes with it, so the same logicalDeviceId then opens a SECOND debugger session for one device. On Chromium the two are one string, and a legacy inspector (Vega) reports no logicalDeviceId at all."
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
        result.status === "connected" ? "Read app logs" : "JavaScript debugger is not connected",
      failedMsg: ({ failureSignal }) => `Failed to read app logs: ${failureSignal.error_code}`,
    },
    description: `Get a summary of all console logs captured from the app's JS runtime.
Returns the log file path, entry counts by level, and message clusters (grouped by similarity). Works against Hermes (iOS / Android / Vega) and V8 (Chromium).
Use when investigating warnings, errors, or unexpected output — call this first for an overview, then read the returned file for details. ALWAYS check { note } before acting on the rest: it appears only when something would otherwise mislead you, and it says which of two things it is — or both, when both hold. Either the previous debugger session for this device was torn down while holding captured logs — by a stop-all-simulator-servers, or by the app's JS runtime going away — so the counts here are a new session's own and a zero says nothing about what the old one captured, and when that teardown left the old log file on disk (a crash or force-quit does, unless the writer never opened one) the note names its path to read instead — and where that teardown's own record replaced an earlier one nobody read, it says how many went unreported and where their logs stand. Or nothing is at { file } — the writer could not create it, or something has removed it since — so it is not there to grep and the counts and clusters here are all there is. Absent a note, empty means nothing has been captured since this session began, and { file } is readable.
When the debugger cannot be reached, this tool does not fail: it returns { status: "not_connected", reason, detail, guidance } and no log file of its own — follow the guidance (do not retry in a loop). A crashed app reaches that state too, so check { note } there as well: when the dead session left its log file behind the note names it, and that file is readable even though the debugger is not. The one exception is reason "reconnecting": the record is held for the retry that guidance asks for, so no note there says nothing about what the previous session left. A "connected" result's stats may come from a session whose socket has since died — use debugger-status, not this tool, to judge debugger health.`,
    zodSchema,
    capability: DEBUGGER_TOOL_CAPABILITY,
    // Resolved manually in execute so a not-connected precondition becomes a
    // structured result instead of a service-resolution tool failure.
    services: () => ({}),
    async execute(_services, params, ctx) {
      try {
        const api = await resolveDebuggerService(registry, params);
        // Unlike debugger-status, no socket-state gate here: captured logs are
        // readable over a dead socket, and this is the tool that hands out the
        // path to read them from. Disposing the stale service would mint a new
        // session over a new path and reduce this answer to a breadcrumb, which
        // is strictly less than the caller came for.
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

        // Resolving the service above silently RECONNECTED if the previous
        // session had been reaped, so an empty registry here is ambiguous: the
        // app has logged nothing, or a teardown took the old log file with it,
        // or the runtime died and left that file on disk. The breadcrumb is what
        // separates the three. Only the empty case is ambiguous — a registry
        // with entries in it is reporting this session's own capture, and
        // consuming a breadcrumb there would attach a stale explanation to a
        // healthy result.
        const reaped =
          stats.totalEntries === 0
            ? takeReapedNote(params.device_id, debuggerReapedScope(params))
            : undefined;
        // Both can be true at once — an unwritable directory outlives the
        // session that died in it — and they are about different files, the old
        // session's and this one's, so neither may swallow the other.
        const notes: string[] = [];
        if (reaped) {
          // The one answer that HAS a registry to account for, so the one that
          // says what this zero covers. `debugger-connect` and the
          // `not_connected` branch below report the same teardown without one.
          // It does not go on to say the app HAS logged: the relaunched session
          // may well have captured nothing yet, and both are true at once —
          // what the reader must not do is read this zero as the old session's.
          notes.push(
            `${reaped} The counts here are the new session's own, so this zero ` +
              `says nothing about what the old one captured.`
          );
        }
        if (!api.logWriter.hasFile()) {
          // Whatever the counts say, `file` names nothing: `open()` swallows its
          // failure and buffers, and the documented next step is to grep that
          // path. Checked on an empty registry too — a session that has not
          // logged yet is where an unwritable directory shows up first, and
          // saying so beats letting the caller find out by grepping. `hasFile`
          // is a look at the path, so it cannot tell a writer that never got
          // one from a file something has since removed; the note says both.
          notes.push(
            `There is no log file at ${stats.file}, so the entries counted here are only in ` +
              `this summary — do not try to read that path. The writer either could not ` +
              `create it, or something has removed it since. Check that ~/.argent/tmp is ` +
              `writable.`
          );
        }
        if (notes.length > 0) response.note = notes.join(" ");
        return response;
      } catch (err) {
        const reason = classifyNotConnected(err);
        if (!reason) throw err;
        trackDebuggerOutcome("debugger-log-registry", reason, params, ctx);
        // A crash is the ordinary way here: the app drops off Metro's target
        // list, so the resolve above throws and this is the only answer the
        // caller gets. The breadcrumb the dead session left is what names the
        // file it kept, and reading it back is the whole point of keeping it:
        // `debugger-connect` is the only other tool that reports it, and an
        // agent that relaunches without going through it never hears of the file
        // at all.
        //
        // Except while that session is still being torn down. The dispose files
        // the breadcrumb before it awaits anything, and a read landing in the
        // awaits that follow — the console server's close waits out the sockets
        // attached to it — gets `reconnecting`, whose guidance is to wait and
        // ask again. The asking again is what would find it spent.
        const withheld = reason === "reconnecting";
        const scope = debuggerReapedScope(params);
        const note = withheld ? undefined : takeReapedNote(params.device_id, scope);
        const result = buildNotConnected(reason, err, params, { reportsOwnNote: true });
        // `guidance` is the field an agent acts on, and these strings are
        // written for `debugger-status`, which carries no note: one that names a
        // note sends the reader here to fetch it, which is backwards in this
        // tool's own answer, and the rest name none at all. So this tool says
        // what its own result holds beside the guidance.
        //
        // The withheld answer says neither: it is holding a breadcrumb it did
        // not spend, and "wait and ask again" is already what its reason's own
        // guidance says.
        if (withheld) return result;
        return {
          ...result,
          ...(note ? { note } : {}),
          guidance: note
            ? `Read this result's note first — it explains what became of the previous session's console log, and of any session whose record that one replaced unread. ${result.guidance}`
            : `${result.guidance} This result has no note: no unread record of a previous session ` +
              `under this ${scope ? "device id and port" : "device id"}. One is filed only for a ` +
              `session that ended holding console history, and the first read of it spends it.`,
        };
      }
    },
  };
}
