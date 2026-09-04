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
 * failing when the JS debugger cannot be reached. Preconditions (Metro down, no
 * app attached, wrong device id, CDP unreachable) are expected states an agent
 * must handle, not tool malfunctions — reporting them as errors inflated these
 * tools' failure rates and invited agent retry storms.
 */
export interface DebuggerNotConnectedResult {
  status: "not_connected";
  connected: false;
  /** Omitted for Chromium ids — their CDP port lives in the device id and the `port` param is ignored. */
  port?: number;
  reason: DebuggerNotConnectedReason;
  /** Original error message; guidance strings point agents at its text. */
  detail: string;
  guidance: string;
}

/**
 * The detail beside this guidance is the shared request-timeout message, which
 * also covers debugger-evaluate — where a breakpoint really can hang the call, so
 * it offers a resume. The connect pipeline cannot pause, so the guidance has to
 * retire that whole branch and not only the phrase, or the two ship contradicting
 * instructions in one payload.
 */
const DETAIL_NAMES_A_BREAKPOINT =
  'The detail says "frozen, or paused at a breakpoint" and offers to resume it ' +
  "because that wording is shared with debugger-evaluate; here only the frozen " +
  "half applies, so ignore its resume branch. ";

/**
 * Guidance for Metro-backed targets (iOS / Android / Vega). Chromium overrides
 * live in CHROMIUM_GUIDANCE: there launch-app is a no-op that re-resolves the
 * CDP service that just failed, so pointing an agent at it only fails again.
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
    "Do not retry in a loop: the sends are awaited in sequence and each waits out its " +
    "own 10s timeout, so an attempt costs about 30s, not one timeout. Restart it " +
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
  // Reached but not CDP: a squatter on the debug port, an HTTP error status, or
  // a non-JSON body — the same precondition class as the Metro arm's non-Metro
  // occupant, so it must not escape as a thrown tool failure.
  [FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE]: "cdp_unreachable",
  [FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET]: "cdp_unreachable",
  [FAILURE_CODES.REGISTRY_SERVICE_TERMINATING]: "reconnecting",
};

/**
 * Map an error thrown while resolving the debugger service to a not-connected
 * reason, or undefined when the fault is unexpected and must keep failing loudly.
 */
export function classifyNotConnected(err: unknown): DebuggerNotConnectedReason | undefined {
  const code = getFailureSignal(err)?.error_code;
  return code ? NOT_CONNECTED_CODE_MAP[code] : undefined;
}

/**
 * The relaunch both Chromium overrides route to. Stated once: it is the same
 * procedure on either reason, and the two disagreed about the mechanism when each
 * carried its own copy. `parseChromiumCdpPort` reads the port straight out of the
 * id with no check against discovery, which is why a browser `list-devices` never
 * probes is still drivable.
 */
const CHROMIUM_RELAUNCH =
  "To relaunch: restart-app is refused on Chromium and boot-device only starts an app and " +
  "never stops one, so ask the user to quit it and wait for the exit — relaunching a live " +
  "app only duplicates it or dies on its single-instance lock, and list-devices cannot " +
  "confirm the exit. Then boot-device with electronAppPath for an Electron app, or ask the " +
  "user to start the browser again with --remote-debugging-port; launch-app starts neither. " +
  "A relaunch on a new port is a new id, so re-read chromium-cdp-<port> — or use " +
  "chromium-cdp-<that port> straight off if the user names it, since list-devices probes " +
  "only 9222, ARGENT_CHROMIUM_PORTS and the ports boot-device opened. Then retry once.";

/** Chromium overrides; reasons without one fall back to GUIDANCE. */
const CHROMIUM_GUIDANCE: Partial<Record<DebuggerNotConnectedReason, string>> = {
  cdp_unreachable:
    "No page could be driven. Which state it is is in the detail, in a phrase it carries — " +
    "a service tag opens every detail, so read past that. " +
    "'Chromium CDP on port': the app answered and has no drivable page, so it is up and " +
    "only lacks a window. Ask the user to bring one back — chromium-tabs cannot open one — " +
    "and do not relaunch, which recovers nothing here. If that detail closes by asking " +
    "about --remote-debugging-port, ignore it: this port answered, so the flag was passed. " +
    "'Chromium CDP discovery: GET': the discovery request itself. 'could not connect' means " +
    "nothing answered that port — consistent with an exit, not proof of one. 'failed (HTTP " +
    "<status>)' or 'returned a body that is not valid JSON' means something that is not CDP " +
    "holds the port, which no relaunch on that port clears: pass that on, and relaunch onto " +
    "a free one. " +
    "Neither phrase: the socket failed after discovery had answered, so the app was up " +
    "moments ago and may have lost only the page it was driving. Have the user check it. " +
    CHROMIUM_RELAUNCH,
  runtime_unresponsive:
    "The app accepted the debugger connection but did not answer within the timeout: the " +
    "renderer is frozen. A renderer paused at a breakpoint does not reach this reason — it " +
    "answers the viewport read, the one send on this path that is not swallowed, so the " +
    "session resolves and debugger-status reports connected. " +
    DETAIL_NAMES_A_BREAKPOINT +
    "Do not retry in a loop: the five priming sends and the viewport read are awaited in " +
    "sequence and each waits out its own 10s timeout, so an attempt costs about a " +
    "minute, not one timeout. " +
    CHROMIUM_RELAUNCH,
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
 * Emit debugger:tool_outcome exactly once per invocation, on every returned
 * result. Coded values only; joins tool:invoke/tool:complete via
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
    // Metro logicalDeviceId fails the iOS-UDID shape test and would misreport
    // every iOS Metro session as "android".
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
 * factory hard-fails without the resolved DeviceInfo.
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
 * A not_connected result is a successful tool return, but a flow step using
 * these tools as a connectivity gate must not green-pass on it. Mirrors
 * isUnmetUiWaitResult for await-ui-element.
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
