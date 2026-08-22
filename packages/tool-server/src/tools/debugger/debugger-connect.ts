import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";
import {
  DEBUGGER_TOOL_CAPABILITY,
  debuggerReapedScope,
  debuggerServiceRef,
} from "./debugger-service-ref";
import { describeReapedSession, takeReapedSession } from "../../utils/reaped-sessions";

const zodSchema = z.object({
  port: z.coerce
    .number()
    .default(8081)
    .describe("Metro server port (ignored for Chromium — its CDP port is encoded in device_id)"),
  device_id: z
    .string()
    .describe(
      "Device id from list-devices: iOS simulator UDID, Android serial, Vega serial (amazon-...), or Chromium device id (chromium-cdp-<port>). Pass this SAME id as device_id to every subsequent debugger-* call to pin them to this device. The returned logicalDeviceId is informational (on Metro the app's own id for this device and bundle, absent on Vega; on Chromium the device id itself); you do not switch to it unless a `device_mismatch` refusal tells you to. While this session lives, forwarding it resolves back here; once the session ends the alias goes with it, so the same id then opens a SECOND debugger session for one device. The list-devices id is the one every other tool takes."
    ),
});

export const debuggerConnectTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    port: number;
    projectRoot: string;
    deviceName: string;
    appName: string;
    logicalDeviceId: string | undefined;
    isNewDebugger: boolean;
    connected: boolean;
    /**
     * What became of the previous session's console history. Present when that
     * session's socket closed with no `dispose()` accounting for it — the app
     * went away, the route to it did, or Metro gave its one debugger slot to
     * another client — and for the teardown that replaced an unread earlier
     * session, which is the only record that that session's output is reported
     * nowhere. Names the log file the teardown left on disk, says it has since
     * been reclaimed, or — when there was no file to keep, because the teardown
     * deleted it, the writer never created one, or something removed it since —
     * that those entries went with it. Where it reports what this event
     * replaced too, it says separately that one of those log files went with
     * it, that anything they left is in `~/.argent/tmp` under no name, or both
     * — and neither where there is nothing of theirs left for the agent to
     * reach.
     * Reported here because this call is the prescribed recovery step after a
     * crash, and it consumes the record that names the file.
     */
    note?: string;
  }
> = {
  id: "debugger-connect",
  interaction: {
    startedMsg: () => "Connecting JavaScript debugger",
    completedMsg: ({ result }) =>
      `Connected JavaScript debugger to ${result.appName || result.deviceName}`,
    failedMsg: ({ failureSignal }) =>
      `Failed to connect JavaScript debugger: ${failureSignal.error_code}`,
  },
  description: `Connect to a JS runtime CDP debugger.
iOS / Android / Vega: connects to Metro's CDP endpoint on the given port. Chromium: re-uses the page CDP session opened by boot-device — port is ignored.
Returns connection info including port, projectRoot (empty on Chromium and on legacy Metro, e.g. Vega), deviceName, appName, logicalDeviceId (absent on Vega), and isNewDebugger. If already connected, returns the existing connection.
Also returns { note } when the PREVIOUS session for this device ended with its debugger connection dropping rather than being closed (a crash, a force-quit, the runtime becoming unreachable, or Metro handing this device's one debugger slot to another client) while holding captured console logs: the note names the log file that teardown left on disk — read it for the pre-crash logs — or says those entries are gone, because the file was reclaimed or never written. debugger-log-registry reports the same thing while its registry is still empty; this is where it surfaces once the relaunched app has logged its first line. Both tools spend the record, so whichever reads it first is the one that reports it — and this tool drops a plain teardown silently, because from this connect on the capture is your own. It does report a teardown that replaced an unread earlier session, since nothing else ever will: a teardown deletes its own log file, so its own entries are gone, and the note adds what became of the replaced session's log wherever the store has anything left to say about it.
Use when starting a debug session or before calling other debugger-* tools. Fails if the runtime is unreachable (Metro down, or Chromium CDP terminated).`,
  zodSchema,
  capability: DEBUGGER_TOOL_CAPABILITY,
  services: (params) => ({
    debugger: debuggerServiceRef(params),
  }),
  async execute(services, params) {
    const api = services.debugger as JsRuntimeDebuggerApi;
    // Drop any teardown breadcrumb for this device, the way the screen-recording
    // and native-profiler starts drop theirs. `debugger-log-registry` reads one
    // only when it has no entries of its own to explain, so a breadcrumb left
    // here outlives every read that finds some — and then attaches "a teardown
    // ate your logs" to a later, unrelated empty read. An explicit connect makes
    // it wrong anyway: from here the capture is this session's, so an empty
    // registry honestly means this app has logged nothing since.
    //
    // Report it first when the app went away: it carries the path of a log file
    // still on disk, and by the time the crash-recovery route — restart-app,
    // then here — arrives, `debugger-log-registry` has nothing left to report.
    // It reads a breadcrumb only from an empty registry, and the relaunched
    // app's first line makes that registry its own.
    //
    // Not in the blueprint's factory: that runs for an IMPLICIT resolve too —
    // `debugger-log-registry` reconnects through it — and clearing there would
    // consume the breadcrumb one line before the read that exists to report it.
    //
    // One lookup, on the id this call names: the store files a teardown under
    // every id its device answered to and spends them all together, and
    // `api.logicalDeviceId` belongs to whatever session this call resolved,
    // which `selectTarget`'s one-device fallback can put on another device.
    const reaped = takeReapedSession(
      "js-runtime-debugger",
      params.device_id,
      debuggerReapedScope(params)
    );
    // A teardown record is dropped deliberately: from this connect on the
    // capture is your own, and someone else's stop-all is not this session's
    // business. One that replaced an unread session is — it is the only record
    // that that session's output is reported nowhere, and reading it here is
    // what destroys it. What ended the session it replaced does not matter: a
    // teardown goes unread as readily as a crash. The two sibling starts drop
    // even a superseded record, and are right to: a live capture leaves no
    // answer for one to ride on, so keeping it only misdirects a later, genuine
    // "no active recording". This connect is itself that answer.
    const note =
      reaped && (reaped.cause === "runtime-death" || reaped.superseded)
        ? describeReapedSession(reaped, "JS-runtime debugger session")
        : undefined;
    return {
      port: api.port,
      projectRoot: api.projectRoot,
      deviceName: api.deviceName,
      appName: api.appName,
      logicalDeviceId: api.logicalDeviceId,
      isNewDebugger: api.isNewDebugger,
      connected: api.cdp.isConnected(),
      ...(note ? { note } : {}),
    };
  },
};
