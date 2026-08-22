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
}

/**
 * Both timeout surfaces carry one message, and it names a breakpoint because
 * debugger-evaluate — which awaits the promise — really can hang on one. The
 * connect pipeline cannot, so a runtime_unresponsive result contradicts its own
 * detail unless the guidance says which half of it applies.
 */
const DETAIL_NAMES_A_BREAKPOINT =
  'The detail says "frozen, or paused at a breakpoint" because it is the shared ' +
  "request-timeout wording, which also covers debugger-evaluate; only the frozen " +
  "half of it applies here. ";

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
    "Metro is running but no app is attached. Do not retry immediately — launch or restart " +
    "the RN app on the target device (launch-app / restart-app), wait a few seconds for the " +
    "bundle to load, then retry once.",
  device_mismatch:
    "The device_id does not match any debugger target on this Metro. Re-target with the " +
    "logicalDeviceId listed in the detail message, or give the device its own Metro port.",
  cdp_unreachable:
    "The runtime's CDP endpoint could not be reached. Verify the app is running " +
    "(launch-app), then call debugger-connect and retry once.",
  runtime_unresponsive:
    "The runtime accepted the debugger connection but did not answer within the " +
    "timeout. A runtime paused at a breakpoint does not reach this reason — every " +
    "send that can time out here is answered by the inspector rather than by the JS " +
    "thread, and the two that do wait on the JS thread are both swallowed, so the " +
    "session resolves and debugger-status reports connected. What timed out is one of " +
    "those inspector-answered sends, so the inspector itself has stopped answering. " +
    DETAIL_NAMES_A_BREAKPOINT +
    "Do not retry in a loop (each attempt waits out the full timeout). Restart it " +
    "(restart-app), then retry once.",
  stale_connection:
    "The cached debugger connection went stale; it has been discarded. Restart the app " +
    "(restart-app) if it is not running, then call debugger-connect — the next call " +
    "reconnects fresh.",
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
  // Reachable from either connect pipeline when the target accepts the socket and
  // then stops answering a send. A runtime paused at a breakpoint does not reach it
  // on either platform, but for different reasons - see the two runtime_unresponsive
  // guidance strings, which state each. Post-connect hangs are different: an OPEN
  // socket still reports status "connected" (see the socket-state gate comment in
  // debugger-status).
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
 * How both Chromium overrides close. Hoisted because the id and the port are the
 * same fact: `parseChromiumCdpPort` reads the port straight out of the id with no
 * check against discovery, while `getCandidateChromiumPorts` probes only 9222, the
 * env list and the ports `boot-device` opened — so a browser brought back elsewhere
 * is invisible to `list-devices` and still perfectly drivable.
 */
const CHROMIUM_REREAD_ID =
  "After a relaunch, re-read the chromium-cdp-<port> id from boot-device / " +
  "list-devices, since a " +
  "relaunch on a new port is a new id — though list-devices only probes 9222, " +
  "ARGENT_CHROMIUM_PORTS and the ports boot-device opened, so a browser brought " +
  "back on any other port is not listed at all, and a boot-device port that has since " +
  "failed a probe is dropped from that set for good, so an id it listed once may not " +
  "come back when the app does — if the user names the port, use " +
  "chromium-cdp-<that port> directly, since the id carries the port and discovery " +
  "is only how you find one you were not told. Then retry once.";

/**
 * Reason guidance that must read differently on a Chromium target. Keyed
 * sparsely: reasons without an override fall back to GUIDANCE.
 */
const CHROMIUM_GUIDANCE: Partial<Record<DebuggerNotConnectedReason, string>> = {
  cdp_unreachable:
    "No page could be driven: the CDP endpoint was unreachable, answered as something " +
    "other than CDP, or is up with no usable page. Which one is in the detail, and the " +
    "phrase it carries is the split — a service tag opens every detail, so read past it. " +
    "A detail carrying 'Chromium CDP discovery: GET' is the discovery request itself: " +
    "'could not connect' means the request never got an answer — nothing listening, or " +
    "something holding the port without answering — while 'failed (HTTP <status>)' " +
    "or 'returned a body that is not valid JSON' means something answered that is not a " +
    "CDP endpoint, usually another service holding it. In that second case pass on what " +
    "the detail says, since nothing here can free a port. That id stays dead while " +
    "something else holds the port — for an Electron app boot-device takes a free port " +
    "and returns the new id, and a browser has to come back on a port nothing else " +
    "holds. After 'could not connect' the port is merely unanswered, so the same id " +
    "works again if the app comes back on it. " +
    "A detail carrying 'Chromium CDP on port' means the app answered and has no drivable " +
    "page (none at all, or only devtools:// ones): it is still running and only lacks a " +
    "window, so ask the user to bring one back — chromium-tabs cannot open one, since " +
    "its own resolver needs an existing page. If the detail carrying that phrase closes " +
    "by asking about --remote-debugging-port, ignore the question: this port answered, so " +
    "the flag was passed. " +
    "A detail carrying neither is the CDP socket failing after discovery had already " +
    "answered, so " +
    "the app was up moments ago. It may have lost only the page it was driving, which the " +
    "window remedy above fixes, or exited since — nothing here tells the two apart, so " +
    "have the user check. " +
    "Once the app is gone: ask the user to quit it if it is somehow still up, " +
    "then relaunch once it has exited — list-devices cannot " +
    "confirm the exit, since it drops an app that is up with no drivable page exactly " +
    "as it drops an exited one, " +
    "and relaunching a live app never recovers it: boot-device only starts an app and " +
    "never stops one, so the relaunch either duplicates the app or dies on its " +
    "single-instance lock as 'child process exited with code N before CDP was ready' — " +
    "a string boot-device also emits for a launch that really failed, so it does not " +
    "tell you which happened. " +
    "Once it is gone, launch-app cannot " +
    "start a Chromium app: boot-device with electronAppPath relaunches an Electron " +
    "app, and for a browser, ask the user to start the browser again on the same CDP " +
    "port with --remote-debugging-port. " +
    CHROMIUM_REREAD_ID,
  runtime_unresponsive:
    "The app accepted the debugger connection but did not answer within the timeout: " +
    "the renderer is frozen. A renderer paused at a breakpoint does not reach this " +
    "reason — it answers the viewport read, which is the one send on this path that is " +
    "not swallowed, so the session resolves and debugger-status reports connected. " +
    DETAIL_NAMES_A_BREAKPOINT +
    "Do not retry in a loop " +
    "(each attempt waits out the full timeout). Ask the user to quit the app, then " +
    "relaunch once it has " +
    "exited: the app is up, so relaunching it yourself never recovers it — " +
    "boot-device only starts an app and never stops one, so the relaunch either " +
    "duplicates the app or dies on its single-instance lock as 'child process exited " +
    "with code N before CDP was ready' — a string boot-device also emits for a launch " +
    "that really failed, so it does not tell you which happened. " +
    "launch-app cannot start a Chromium app. " +
    "list-devices cannot confirm the exit either: a wedged app keeps its page target " +
    "and stays listed, so when the entry goes it means the window was closed just as " +
    "readily as that the app exited. " +
    "boot-device with electronAppPath relaunches an Electron app, and " +
    "for a browser, ask the user to start the browser again on the same CDP port " +
    "with --remote-debugging-port. " +
    CHROMIUM_REREAD_ID,
};

export function buildNotConnected(
  reason: DebuggerNotConnectedReason,
  err: unknown,
  params: { port: number; device_id?: string }
): DebuggerNotConnectedResult {
  const isChromium = params.device_id?.startsWith(CHROMIUM_ID_PREFIX) ?? false;
  return {
    status: "not_connected",
    connected: false,
    ...(isChromium ? {} : { port: params.port }),
    reason,
    detail: err instanceof Error ? err.message : String(err),
    guidance: (isChromium ? CHROMIUM_GUIDANCE[reason] : undefined) ?? GUIDANCE[reason],
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
