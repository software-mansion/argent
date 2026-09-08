import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
import { IOS_DEVICE_RUNNER_NAMESPACE } from "../../blueprints/ios-device-runner";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { ANDROID_DEVTOOLS_NAMESPACE } from "../../blueprints/android-devtools";
import { CHROMIUM_CDP_NAMESPACE } from "../../blueprints/chromium-cdp";
import { CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE } from "../../blueprints/chromium-js-runtime-debugger";
import { TV_CONTROL_NAMESPACE } from "../../blueprints/tv-control";
import { ANDROID_TV_CONTROL_NAMESPACE } from "../../blueprints/android-tv-control";
import { AX_SERVICE_NAMESPACE } from "../../blueprints/ax-service";
import { SCREEN_RECORDING_SESSION_NAMESPACE } from "../../blueprints/screen-recording-session";
import { NATIVE_PROFILER_SESSION_NAMESPACE } from "../../blueprints/native-profiler-session";
import { JS_RUNTIME_DEBUGGER_NAMESPACE } from "../../blueprints/js-runtime-debugger";
import { NETWORK_INSPECTOR_NAMESPACE } from "../../blueprints/network-inspector";
import { REACT_PROFILER_SESSION_NAMESPACE } from "../../blueprints/react-profiler-session";
import { isLogicalKeyedDevice } from "../../utils/debugger/device-alias";

/**
 * The one URN matcher both `stop-simulator-server` and
 * `stop-all-simulator-servers` resolve a device id through — case-insensitively
 * and `:tcp`-aware — so a udid names the same URNs in either tool.
 *
 * Only MATCHING is shared. Each tool picks its own namespace set, and
 * `stop-simulator-server` picks its from `resolveDevice().platform`, whose
 * prefix tests are case-SENSITIVE, so a mis-cased id can still land on the
 * wrong set there.
 */

/**
 * Every discriminator a device-scoped URN appends after the device id. Only
 * `:tcp` exists — `axServiceRef` and `nativeDevtoolsRef` mint it for
 * `transport: "tcp"`, which no call site passes today (the remote host's
 * forced-TCP choice is made inside the factory, after the ref fixed the URN).
 * Matched anyway so the two stop tools cannot drift the moment one does.
 *
 * Enumerated rather than "anything after a colon": a device id can itself end
 * in `:<something>` — an adb-over-wifi serial is `192.168.1.5:5555` — and a
 * wildcard would let a bare `192.168.1.5` claim every device at that address.
 */
const URN_SUFFIXES = ["", ":tcp"] as const;

/**
 * Namespaces whose URN interposes the Metro port between the namespace and the
 * device id: `<Namespace>:<port>:<deviceId>`. Matched as the plain shape, they
 * would report every debugger session as belonging to no device.
 *
 * Only the FIRST colon is consumed, so a wireless adb serial
 * (`JsRuntimeDebugger:8081:192.168.1.5:5555`) still resolves whole.
 */
export const PORT_KEYED_NAMESPACES: readonly string[] = [
  JS_RUNTIME_DEBUGGER_NAMESPACE,
  // Both depend on `JsRuntimeDebugger:<payload>`, so a cascade already reaps
  // them; listed so `stopped` names them instead of leaving the caller to infer
  // them from the debugger line.
  NETWORK_INSPECTOR_NAMESPACE,
  REACT_PROFILER_SESSION_NAMESPACE,
];

/**
 * Every namespace whose service belongs to exactly one device. Membership is
 * "does `dispose()` reap a resource that outlives the call", with two
 * exceptions: `AndroidTvControl` is stateless adb shell-outs with a no-op
 * dispose, listed so the snapshot drains fully; and the dependents a cascade
 * would reach anyway (`NetworkInspector`, `ReactProfilerSession`,
 * `ChromiumJsRuntimeDebugger`) are listed so `stopped` names them rather than
 * tearing them down silently. `ChromiumJsRuntimeDebugger` belongs here and not
 * in {@link PORT_KEYED_NAMESPACES} because its URN is the plain
 * `<ns>:<deviceId>` shape.
 *
 * Owning none of these is not a bad id: Vega is driven by shell-outs — the
 * `vega` CLI for boot and launch, adb for describe, screenshot and the remote —
 * so a Vega serial holds a live service only once `debugger-connect` or a
 * network-log tool has run. Ownership is counted regardless of state, and a
 * failed resolve leaves an ERROR node behind: `Registry._resolve` inserts
 * before the factory runs, and nothing is ever removed.
 */
export const DEVICE_OWNED_NAMESPACES: readonly string[] = [
  SIMULATOR_SERVER_NAMESPACE,
  IOS_DEVICE_RUNNER_NAMESPACE,
  NATIVE_DEVTOOLS_NAMESPACE,
  ANDROID_DEVTOOLS_NAMESPACE,
  CHROMIUM_CDP_NAMESPACE,
  CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE,
  TV_CONTROL_NAMESPACE,
  ANDROID_TV_CONTROL_NAMESPACE,
  AX_SERVICE_NAMESPACE,
  SCREEN_RECORDING_SESSION_NAMESPACE,
  NATIVE_PROFILER_SESSION_NAMESPACE,
  ...PORT_KEYED_NAMESPACES,
];

/**
 * The subset `stop-simulator-server` disposes: the device's transport session,
 * plus the TV-control daemons a tvOS udid may own alongside it. On a physical
 * iPhone that transport is `IosDeviceRunner` rather than `SimulatorServer`,
 * whose factory rejects `kind: "device"` outright.
 *
 * Deliberately narrower than {@link DEVICE_OWNED_NAMESPACES}. That tool is the
 * documented recovery for a wedged transport, so widening it to devtools/AX
 * would make a routine retry silently drop the native-devtools connection
 * another agent's in-progress recording depends on. Draining everything is
 * `stop-all-simulator-servers`' job.
 *
 * On CHROMIUM the narrowness cannot hold: `ChromiumJsRuntimeDebugger` declares
 * `ChromiumCdp` as a dependency, so disposing the transport tears the debugger
 * down with its captured console history. `stop-simulator-server`'s description
 * says so outright instead.
 */
export function transportNamespacesForPlatform(platform: string): readonly string[] {
  if (platform === "chromium") return [CHROMIUM_CDP_NAMESPACE];
  if (platform === "android") return [SIMULATOR_SERVER_NAMESPACE, ANDROID_TV_CONTROL_NAMESPACE];
  // Shape cannot tell tvOS from iOS or a simulator from a physical device here. Cover all three namespaces.
  return [SIMULATOR_SERVER_NAMESPACE, IOS_DEVICE_RUNNER_NAMESPACE, TV_CONTROL_NAMESPACE];
}

/**
 * The device-id portion of `urn` if it belongs to `namespace`, else undefined.
 * Accounts for the two URN shapes (see {@link PORT_KEYED_NAMESPACES}).
 */
function deviceIdPortion(urn: string, namespace: string): string | undefined {
  if (!urn.startsWith(`${namespace}:`)) return undefined;
  const tail = urn.slice(namespace.length + 1);
  if (!PORT_KEYED_NAMESPACES.includes(namespace)) return tail;
  const afterPort = tail.indexOf(":");
  return afterPort < 0 ? undefined : tail.slice(afterPort + 1);
}

/**
 * Which entry of `deviceIds` owns `urn` within `namespaces`, if any, in the
 * caller's own spelling — so a tool can report which of the ids it was given
 * matched nothing. The device id is compared whole (never split on ":", see
 * {@link URN_SUFFIXES}).
 *
 * Matching is case-insensitive: iOS UDIDs are conventionally upper-case but
 * agents pass through whatever they were given, and a case mismatch must not
 * silently turn a scoped stop into a no-op. Safe because no two distinct
 * devices can differ by case alone — except in principle for a physical Android
 * serial, which is vendor-defined `ro.serialno`; such a pair would already be
 * indistinguishable to `adb -s`.
 */
export function deviceIdOwningUrn(
  urn: string,
  namespaces: readonly string[],
  deviceIds: readonly string[]
): string | undefined {
  for (const namespace of namespaces) {
    const portion = deviceIdPortion(urn, namespace);
    if (portion === undefined) continue;
    const tail = portion.toLowerCase();
    const owner = deviceIds.find((id) => {
      const lower = id.toLowerCase();
      return URN_SUFFIXES.some((suffix) => tail === `${lower}${suffix}`);
    });
    // Namespaces contain no ":", so at most one can prefix a given URN — a
    // miss here is a miss outright, not a reason to keep scanning.
    return owner;
  }
  return undefined;
}

/** Whether `urn` belongs to any of `namespaces`, regardless of which device. */
export function isDeviceServiceUrn(urn: string, namespaces: readonly string[]): boolean {
  return namespaces.some((ns) => urn.startsWith(`${ns}:`));
}

/**
 * The device-id portion of `urn` under whichever of `namespaces` owns it, in
 * that namespace's own URN shape — {@link deviceIdOwningUrn}'s reading minus
 * the caller's id list. Undefined when no namespace in the set prefixes it.
 */
function deviceIdOfUrn(urn: string, namespaces: readonly string[]): string | undefined {
  for (const namespace of namespaces) {
    const portion = deviceIdPortion(urn, namespace);
    if (portion !== undefined) return portion;
  }
  return undefined;
}

/**
 * Of `urns`, the port-keyed sessions no device-scoped teardown could ever name,
 * whatever ids it was given.
 *
 * On a Metro serving two or more devices, `selectTarget` refuses to guess which
 * target a udid or serial means and makes the caller re-target with the
 * `logicalDeviceId` Metro echoed — an opaque per-connection handle
 * `list-devices` never mints, which the debugger URN then embeds. A teardown
 * scoped to real device ids leaves that session holding its CDP socket, a bound
 * loopback server and a log file handle, while the caller's serial still
 * matches the device's OTHER services and so is not reported `unmatched`
 * either.
 *
 * Which ids those are is recorded by the connect that minted the URN, not
 * inferred from it (see {@link isLogicalKeyedDevice}). A session another agent
 * opened with its own serial is NOT reported: a scope could have named that id.
 */
export function unnameableSessionUrns(urns: readonly string[]): string[] {
  return urns.filter((urn) => isLogicalKeyedDevice(deviceIdOfUrn(urn, PORT_KEYED_NAMESPACES)));
}
