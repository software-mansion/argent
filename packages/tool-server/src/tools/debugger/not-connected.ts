import { FAILURE_CODES, getFailureSignal, type Registry, type ToolContext } from "@argent/registry";
import {
  track,
  type DebuggerNotConnectedReason,
  type DebuggerToolOutcome,
} from "@argent/telemetry";
import { CHROMIUM_ID_PREFIX } from "../../utils/device-info";
import { classifyDeviceForTelemetry } from "../../utils/telemetry-platform";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";
import { debuggerServiceRef } from "./debugger-service-ref";
import type { JsRuntimeDebuggerApi } from "../../blueprints/js-runtime-debugger";

/**
 * Structured result debugger-status and debugger-log-registry return instead of
 * failing when the JS debugger cannot be reached. Precondition failures (Metro
 * down, no app attached, wrong device id, CDP unreachable) are expected states
 * an agent must handle, not tool malfunctions — reporting them as errors is what
 * drove these tools' 37%/24% telemetry failure rates and agent retry storms.
 */
export interface DebuggerNotConnectedResult {
  status: "not_connected";
  connected: false;
  /** Omitted for Chromium ids — their CDP port lives in the device id and the `port` param is ignored. */
  port?: number;
  reason: DebuggerNotConnectedReason;
  /** Original error message, preserved for agents that match on its text. */
  detail: string;
  guidance: string;
  /**
   * What became of a previous debugger session's console history, when this
   * device had one that was torn down holding captured logs — and where its log
   * file is if that teardown left it on disk. A crashed app is the ordinary way
   * to reach `no_app_connected`, and the crash is exactly when those logs
   * matter, so the answer that reports the app is gone is also the one that has
   * to say where its last words went. Set by debugger-log-registry only:
   * debugger-status is a health read that consumes nothing, and a breadcrumb is
   * spent by whoever reads it first — spending it there would take it from the
   * tool the agent then calls to actually find the logs.
   */
  note?: string;
}

/**
 * `cdp_unreachable`'s two halves, kept apart because the second is dropped for
 * the tool that carries the record itself. Everything a crash leaves is behind
 * that pointer, and on Chromium this reason is the ONLY one a crashed renderer
 * produces — a non-OPEN socket is `reconnecting`, and the re-resolve after the
 * terminated cascade fails here — so an agent that follows this guidance
 * straight to a relaunch never learns the kept log exists.
 */
const CDP_UNREACHABLE_RECOVERY =
  "The runtime's CDP endpoint could not be reached. Verify the app is running " +
  "(launch-app), then call debugger-connect and retry once.";
const CDP_UNREACHABLE_NOTE_POINTER =
  " Before you relaunch anything: a session whose runtime died holding console logs keeps " +
  "its file, and debugger-log-registry's note names it.";
const CHROMIUM_CDP_UNREACHABLE_RECOVERY =
  "The app's CDP endpoint could not be reached (or did not answer like CDP — see " +
  "detail). launch-app cannot start a Chromium app; make sure the app is running " +
  "with --remote-debugging-port (for an Electron app, boot-device with " +
  "electronAppPath relaunches it), then retry once.";
const CHROMIUM_CDP_UNREACHABLE_NOTE_POINTER =
  " Before you relaunch anything: a renderer that died holding console logs keeps its file, " +
  "and debugger-log-registry's note names it — the record is filed under the CDP port, which " +
  "is the device id, so relaunching on a port boot-device picks strands it.";

/**
 * Guidance strings for Metro-backed targets (iOS / Android / Vega). Chromium
 * ids get platform-corrected overrides below — on Chromium, launch-app cannot
 * start anything (its handler is a documented no-op) and it re-resolves the
 * very CDP service that just failed, so pointing an agent at it from a
 * cdp_unreachable result would manufacture a guaranteed second failure.
 */
const GUIDANCE: Record<DebuggerNotConnectedReason, string> = {
  metro_not_running:
    "Metro is not running on this port. Do not retry in a loop — the result will not change " +
    "until Metro is started. Start Metro (e.g. `npx react-native start` or `npx expo start`) " +
    "or ask the user, wait for it to report ready, then retry once.",
  no_app_connected:
    "Metro is running but no app is attached. A crashed app reads as this too, and a session " +
    "whose runtime died holding console logs keeps its file: read debugger-log-registry's note " +
    "before relaunching, since it names that file when there is one. Do not retry immediately — " +
    "launch or restart the RN app on the target device (launch-app / restart-app), wait a few " +
    "seconds for the bundle to load, then retry once.",
  device_mismatch:
    "The device_id does not match any debugger target on this Metro; while two or more devices " +
    "share the port, a target is matched by its logicalDeviceId alone, so a list-devices udid " +
    "or serial is refused every time. A dead session's console-log record is filed under every " +
    "id its device answered to, and a re-target asks under another device's — read " +
    "debugger-log-registry's note with this same device_id first. Then re-target with a " +
    "logicalDeviceId from the detail message, or give the device its own Metro port, which is " +
    "the only route for a legacy inspector that reports no logicalDeviceId at all.",
  cdp_unreachable: CDP_UNREACHABLE_RECOVERY + CDP_UNREACHABLE_NOTE_POINTER,
  runtime_unresponsive:
    "The runtime accepted the debugger connection but did not answer within the " +
    "timeout — it is likely frozen, or paused at a breakpoint. Do not retry in a " +
    "loop (each attempt waits out the full timeout). Check the app; if it is hung, " +
    "restart it (restart-app), then retry once.",
  stale_connection:
    "The cached debugger connection went stale; it has been discarded. That discard keeps " +
    "whatever console log the session had captured, and debugger-log-registry's note names the " +
    "file when there is one. Restart the app (restart-app) if it is not running, then call " +
    "debugger-connect — the next call reconnects fresh.",
  reconnecting:
    "The debugger connection is being re-established (the previous one was torn down or a " +
    "tab switch is in progress). Wait a moment and retry once.",
};

const NOT_CONNECTED_CODE_MAP: Record<string, DebuggerNotConnectedReason> = {
  [FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING]: "metro_not_running",
  [FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS]: "no_app_connected",
  [FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH]: "device_mismatch",
  [FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED]: "cdp_unreachable",
  [FAILURE_CODES.DEBUGGER_CDP_SOCKET_CLOSED_BEFORE_OPEN]: "cdp_unreachable",
  [FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED]: "cdp_unreachable",
  [FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED]: "cdp_unreachable",
  // Reachable from the connect pipeline's enable/binding sends when the target
  // accepts the socket but its JS runtime never answers (frozen, or paused at a
  // breakpoint). Post-connect hangs are different: an OPEN socket still reports
  // status "connected" (see the socket-state gate comment in debugger-status).
  [FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT]: "runtime_unresponsive",
  [FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE]: "cdp_unreachable",
  // "Reached but not CDP / malformed answer" — a non-CDP server squatting the
  // debug port, an HTTP error status, or a non-JSON body. Same precondition
  // class as the Metro arm's non-Metro-port-occupant (detail names what
  // actually answered), so it must not escape as a thrown tool failure.
  [FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE]: "cdp_unreachable",
  [FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET]: "cdp_unreachable",
  [FAILURE_CODES.REGISTRY_SERVICE_TERMINATING]: "reconnecting",
};

/**
 * Map an error thrown while resolving the debugger service to a not-connected
 * reason, or undefined when the fault is unexpected and must keep failing
 * loudly (payload bugs, console-server binds, plain Errors, ...).
 */
export function classifyNotConnected(err: unknown): DebuggerNotConnectedReason | undefined {
  const code = getFailureSignal(err)?.error_code;
  return code ? NOT_CONNECTED_CODE_MAP[code] : undefined;
}

/**
 * Reason guidance that must read differently on a Chromium target. Keyed
 * sparsely: reasons without an override fall back to GUIDANCE.
 */
const CHROMIUM_GUIDANCE: Partial<Record<DebuggerNotConnectedReason, string>> = {
  cdp_unreachable: CHROMIUM_CDP_UNREACHABLE_RECOVERY + CHROMIUM_CDP_UNREACHABLE_NOTE_POINTER,
  runtime_unresponsive:
    "The app accepted the debugger connection but did not answer within the " +
    "timeout — it is likely frozen. Do not retry in a loop (each attempt waits out " +
    "the full timeout). Restart the app (for an Electron app, boot-device with " +
    "electronAppPath and force: true), then retry once.",
};

/**
 * Reason guidance that must read differently in debugger-log-registry's answer,
 * the one that carries the note the shared strings send an agent to fetch.
 * Read from there, "read debugger-log-registry's note" is an errand the answer
 * in hand has already run — and on a crash that captured nothing it is one that
 * cannot be run at all: the tool that just reported no note would be sending the
 * agent back to itself for one. That answer says what it holds instead, in a
 * sentence of its own beside the guidance. Keyed sparsely, like the map above:
 * `stale_connection` carries the same pointer and needs no entry, since
 * debugger-status mints that reason itself and NOT_CONNECTED_CODE_MAP has no
 * code for it — debugger-log-registry never emits it.
 */
const OWN_NOTE_GUIDANCE: Partial<Record<DebuggerNotConnectedReason, string>> = {
  device_mismatch:
    "The device_id does not match any debugger target on this Metro; while two or more devices " +
    "share the port, a target is matched by its logicalDeviceId alone, so a list-devices udid " +
    "or serial is refused every time. Re-target with a logicalDeviceId from the detail message, " +
    "or give the device its own Metro port, which is the only route for a legacy inspector that " +
    "reports no logicalDeviceId at all.",
  no_app_connected:
    "Metro is running but no app is attached; a crashed app reads as this too. Do not retry " +
    "immediately — launch or restart the RN app on the target device (launch-app / " +
    "restart-app), wait a few seconds for the bundle to load, then retry once.",
  cdp_unreachable: CDP_UNREACHABLE_RECOVERY,
};

/**
 * The Chromium overrides for that same caller. Needed because the platform
 * override is consulted first, so without an entry here the Chromium answer
 * keeps its note pointer — and `cdp_unreachable` is the one reason reachable on
 * both platforms that has one. The documented old-port lookup is the call an
 * agent makes BECAUSE it knows that endpoint is dead, and it would be sent to
 * this same tool for the note it is already holding.
 */
const CHROMIUM_OWN_NOTE_GUIDANCE: Partial<Record<DebuggerNotConnectedReason, string>> = {
  cdp_unreachable: CHROMIUM_CDP_UNREACHABLE_RECOVERY,
};

export function buildNotConnected(
  reason: DebuggerNotConnectedReason,
  err: unknown,
  params: { port: number; device_id?: string },
  /** Set by the tool that reports the breadcrumb itself — see OWN_NOTE_GUIDANCE. */
  opts?: { reportsOwnNote?: boolean }
): DebuggerNotConnectedResult {
  const isChromium = params.device_id?.startsWith(CHROMIUM_ID_PREFIX) ?? false;
  return {
    status: "not_connected",
    connected: false,
    ...(isChromium ? {} : { port: params.port }),
    reason,
    detail: err instanceof Error ? err.message : String(err),
    guidance:
      (isChromium && opts?.reportsOwnNote ? CHROMIUM_OWN_NOTE_GUIDANCE[reason] : undefined) ??
      (isChromium ? CHROMIUM_GUIDANCE[reason] : undefined) ??
      (opts?.reportsOwnNote ? OWN_NOTE_GUIDANCE[reason] : undefined) ??
      GUIDANCE[reason],
  };
}

/**
 * Emit the debugger:tool_outcome event — exactly once per invocation, from the
 * connected return, the socket-state-gate branch, and the classified catch
 * alike. Coded values only; joins tool:invoke/tool:complete via
 * tool_invocation_id.
 */
export function trackDebuggerOutcome(
  tool: "debugger-status" | "debugger-log-registry",
  outcome: DebuggerToolOutcome,
  params: { device_id?: string },
  ctx: ToolContext | undefined
): void {
  let platform;
  try {
    // Classify the id the caller CONNECTED with, not the raw param: a forwarded
    // Metro logicalDeviceId (an opaque hex handle) fails the iOS-UDID shape
    // test and would misreport every iOS Metro session as "android". The alias
    // map (learned at connect) rewrites it back to the UDID/serial; ids with no
    // learned alias pass through unchanged, keeping the old behavior.
    const deviceId = canonicalDeviceId(params.device_id);
    platform = deviceId ? classifyDeviceForTelemetry(deviceId) : undefined;
  } catch {
    platform = undefined;
  }
  track("debugger:tool_outcome", {
    tool,
    outcome,
    ...(platform ? { platform } : {}),
    ...(ctx?.toolInvocationId ? { tool_invocation_id: ctx.toolInvocationId } : {}),
  });
}

/**
 * Resolve the shared debugger service for a status-style tool, preserving the
 * connect-on-first-call contract. Passes ref.options through — the Chromium
 * wrapper factory requires the resolved DeviceInfo and hard-fails without it.
 */
export async function resolveDebuggerService(
  registry: Registry,
  params: { port: number; device_id?: string }
): Promise<JsRuntimeDebuggerApi> {
  const ref = debuggerServiceRef(params);
  return typeof ref === "string"
    ? registry.resolveService<JsRuntimeDebuggerApi>(ref)
    : registry.resolveService<JsRuntimeDebuggerApi>(ref.urn, ref.options);
}

/**
 * Flow integration: a not_connected result is a successful tool return, but a
 * recorded flow step that used these tools as a connectivity gate must not
 * silently green-pass on it. Mirrors isUnmetUiWaitResult for await-ui-element.
 */
export function isDebuggerNotConnectedResult(
  toolId: string,
  result: unknown
): result is DebuggerNotConnectedResult {
  return (
    (toolId === "debugger-status" || toolId === "debugger-log-registry") &&
    typeof result === "object" &&
    result !== null &&
    (result as { status?: unknown }).status === "not_connected"
  );
}
