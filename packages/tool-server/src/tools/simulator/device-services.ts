import { SIMULATOR_SERVER_NAMESPACE } from "../../blueprints/simulator-server";
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
 * Which services one device id owns — the single definition of that mapping,
 * shared by `stop-simulator-server` (one device, transport scope) and
 * `stop-all-simulator-servers` (every device-owned service). Both resolve a
 * URN through one matcher here, so a given udid resolves to the same URNs for
 * either tool — case-insensitively, and with the `:tcp` suffix understood.
 *
 * This unifies how a URN is MATCHED, not which namespaces each tool sweeps:
 * `stop-simulator-server` deliberately scopes to the transport session (see
 * {@link transportNamespacesForPlatform}) while `stop-all-simulator-servers`
 * takes every {@link DEVICE_OWNED_NAMESPACES} entry, so the same udid still
 * reaps a different SET through each tool — by design. Nor does it unify how a
 * raw id is CLASSIFIED: `stop-simulator-server` picks its namespace set from
 * `resolveDevice().platform`, whose prefix tests are case-SENSITIVE, so an id
 * spelled in the wrong case can still land on the wrong namespace set there.
 */

/**
 * Every discriminator a device-scoped URN appends AFTER the device id. Only
 * `:tcp` exists, and only two namespaces can ever emit it: `axServiceRef` and
 * `nativeDevtoolsRef` append it for `transport: "tcp"`. No call site passes
 * that option today — including the ios-remote branches, and the remote host's
 * forced-TCP decision is made inside the factory, after the ref has already
 * fixed the URN — so `:tcp` is a shape the refs can mint rather than one
 * production currently produces. Matched anyway so the two stop tools cannot
 * drift apart again the moment a caller does pass it.
 *
 * Enumerated rather than matched as "anything after a colon", because a device
 * id can itself end in `:<something>`: an adb serial over wifi is
 * `192.168.1.5:5555`, so a suffix wildcard would let the bare `192.168.1.5`
 * claim every device at that address and tear down another agent's — while
 * reporting nothing unmatched.
 */
const URN_SUFFIXES = ["", ":tcp"] as const;

/**
 * Namespaces whose URN interposes the Metro port between the namespace and the
 * device id: `<Namespace>:<port>:<deviceId>`. Split off from the plain shape
 * because the tail is not the device id — matching these as if it were would
 * report every debugger session as belonging to no device.
 *
 * Only the FIRST colon is consumed. The remainder is compared whole, so a
 * wireless adb serial (`JsRuntimeDebugger:8081:192.168.1.5:5555`) still
 * resolves to `192.168.1.5:5555` and not to `192.168.1.5`.
 */
export const PORT_KEYED_NAMESPACES: readonly string[] = [
  JS_RUNTIME_DEBUGGER_NAMESPACE,
  // Both declare `getDependencies -> JsRuntimeDebugger:<payload>`, so neither
  // can be in a snapshot without it and neither adds any ownership the debugger
  // entry does not already establish. They are listed for what `stopped`
  // reports: a session that had a network inspector or a React profiler open is
  // told those went away by name, rather than inferring it from the debugger
  // line.
  NETWORK_INSPECTOR_NAMESPACE,
  REACT_PROFILER_SESSION_NAMESPACE,
];

/**
 * Every namespace whose service belongs to exactly one device and whose
 * `dispose()` frees something worth freeing. A device owning none of these is
 * not a bad id: Vega is driven by shell-outs — the `vega` CLI for boot and
 * launch, adb for describe, screenshot and the remote — so a Vega device owns a
 * RUNNING service only once `debugger-connect` or a network-log tool has run.
 * `DEBUGGER_TOOL_CAPABILITY` declares `vega: { vvd: true }`, and those two
 * (`JsRuntimeDebugger`, `NetworkInspector`) are the only entries here a Vega
 * serial can hold live.
 *
 * It can still MATCH others, because ownership is counted regardless of state
 * and a failed resolve leaves its node behind in ERROR (`Registry._resolve`
 * inserts before the factory runs, and nothing is ever removed). A tool's
 * capability is enforced by the HTTP layer, not by `registry.invokeTool`, so a
 * call that reaches the registry another way — `flow-add-step` takes `command`
 * as a bare string — can mint e.g. `SimulatorServer:<vega serial>` in ERROR. A
 * Vega serial appearing in `stopped` is therefore impossible, but one absent
 * from `unmatched` is not.
 *
 * Membership is decided by "does dispose() reap a resource that outlives the
 * call", and every namespace that meets that test is listed even when a cascade
 * would already have reached it. Three blueprints declare `getDependencies` —
 * NetworkInspector and ReactProfilerSession on `JsRuntimeDebugger`,
 * ChromiumJsRuntimeDebugger on `ChromiumCdp` — and teardown runs
 * dependency → dependents, so all three can arrive via a cascade. Listing them
 * is about what `stopped` names, not about whether they die: an unlisted
 * dependent is torn down silently, which contradicts what the tool documents
 * `stopped` to be.
 *
 * - `AXService` owns the in-sim ax daemon (spawned `--timeout 3600`) and its
 *   socket, and is the only entry that reaps it. An iOS session that only ran
 *   boot/launch/describe also owns `NativeDevtools` — `bootIos` and
 *   `launch-app`'s iOS handler both resolve it unconditionally — so leaving
 *   `AXService` out would not orphan the device, just that daemon.
 * - `TvControl` owns two spawned `--timeout 3600` daemons.
 * - `ScreenRecordingSession` owns an ffmpeg child, an MJPEG frame stream, and
 *   the touch-visualizer overlay it enabled on the device.
 * - `NativeProfilerSession` owns an xctrace child on iOS, and on Android an
 *   on-device perfetto process plus its trace file.
 * - `JsRuntimeDebugger` owns a bound loopback HTTP/WebSocket server, the CDP
 *   socket to Metro, and a log file handle.
 * - `ChromiumJsRuntimeDebugger` owns a bound loopback server, a log handle and
 *   its captured console history — but NOT the CDP socket: its `dispose()`
 *   deliberately leaves that to `ChromiumCdp` (and there is no Metro on the
 *   chromium path). That is precisely why the narrowness note below holds —
 *   disposing `ChromiumCdp` cascades to this one BECAUSE this one does not own
 *   the transport. Its dependency (`ChromiumCdp`) is listed here too, so a
 *   scoped stop reaches it twice over — as it does the two `JsRuntimeDebugger`
 *   dependents, whose own dependency is equally listed. All three are here for
 *   the naming, not for the reaping. What is particular to this one is its URN
 *   SHAPE: `<ns>:<deviceId>`, not port-keyed like the other two dependents, so
 *   it belongs in this list and not in {@link PORT_KEYED_NAMESPACES}.
 *
 * (`AndroidTvControl` is stateless adb shell-outs with a no-op dispose, but is
 * included for symmetry so the snapshot is fully drained.)
 */
export const DEVICE_OWNED_NAMESPACES: readonly string[] = [
  SIMULATOR_SERVER_NAMESPACE,
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
 * plus the TV-control daemons a tvOS udid may own alongside it.
 *
 * Deliberately narrower than {@link DEVICE_OWNED_NAMESPACES}. That tool is also
 * the documented recovery for a wedged transport ("stop it and retry"), and
 * widening it to devtools/AX would make a routine retry silently drop the
 * native-devtools connection another agent's in-progress recording depends on —
 * degrading that flow to coordinate taps, which is the hazard
 * `stop-all-simulator-servers`' `devices` scope exists to prevent. Agents
 * finishing a session call `stop-all-simulator-servers` instead, which drains
 * everything.
 *
 * That narrowness is only as strong as the dependency graph, and on CHROMIUM it
 * does not hold: `ChromiumJsRuntimeDebugger` declares `ChromiumCdp` as a
 * dependency, so disposing the transport tears the debugger down as a dependent
 * along with its captured console history. Nothing here can prevent that
 * without leaving the wedged transport in place, which is the tool's whole
 * purpose; `stop-simulator-server`'s description says so outright instead.
 */
export function transportNamespacesForPlatform(platform: string): readonly string[] {
  if (platform === "chromium") return [CHROMIUM_CDP_NAMESPACE];
  if (platform === "android") return [SIMULATOR_SERVER_NAMESPACE, ANDROID_TV_CONTROL_NAMESPACE];
  // A tvOS UDID is iOS-shaped and can't be told apart from a phone here without
  // an async probe, so cover both.
  return [SIMULATOR_SERVER_NAMESPACE, TV_CONTROL_NAMESPACE];
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
 * Which entry of `deviceIds` owns `urn` within `namespaces`, if any. The device
 * id is compared whole (never split on ":", see {@link URN_SUFFIXES}).
 *
 * Matching is case-insensitive: iOS UDIDs are conventionally upper-case but
 * agents pass through whatever they were given, and a case mismatch must not
 * silently turn a scoped stop into a no-op.
 *
 * That is safe only if no two distinct devices can differ by case alone. Of the
 * id spaces we support, six are structurally case-safe: iOS UDIDs (hex UUID),
 * `emulator-N`, `chromium-cdp-N`, adb-over-wifi `ip:port`, `remote:<UUID>` for
 * ios-remote, and Vega's `amazon-<hex>`. The seventh is an assumption rather
 * than a guarantee: a physical Android serial is `ro.serialno`, which
 * `device-info.ts` notes is vendor-defined and unconstrained, so a vendor could
 * in principle ship two devices differing only in case. Accepted — colliding
 * serials on ONE host would already be indistinguishable to `adb -s`, and the
 * alternative (case-sensitive matching) reintroduces the silent no-op this
 * exists to fix on the id space agents actually mistype, iOS UDIDs.
 *
 * Returns the caller's spelling of the id, so a tool can report which of the
 * ids it was given matched nothing.
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
    // No namespace can contain ":", so at most one can prefix a given URN —
    // a miss here is a miss outright, not a reason to keep scanning.
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
 * that namespace's own URN shape — the same reading {@link deviceIdOwningUrn}
 * matches against, minus the caller's id list. Undefined when no namespace in
 * the set prefixes it.
 */
export function deviceIdOfUrn(urn: string, namespaces: readonly string[]): string | undefined {
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
 * `JsRuntimeDebugger`'s URN embeds the id the caller CONNECTED with, and on a
 * Metro serving two or more devices that cannot be a UDID or serial:
 * `selectTarget` refuses to guess which target a device id means and instructs
 * the caller to re-target with the `logicalDeviceId` Metro echoed — an opaque
 * per-connection handle `list-devices` never mints, and the only id that then
 * resolves the session. A teardown scoped to real device ids therefore leaves
 * that session holding its CDP socket to Metro, a bound loopback console
 * server and a log file handle; and because the caller's serial still matches
 * that device's OTHER services, the serial is not reported `unmatched` either,
 * so the whole thing reads as a clean machine.
 *
 * Which ids those are is not inferred from the URN — it is recorded by the
 * connect that minted it, the one place both ids are known at once (see
 * {@link isLogicalKeyedDevice}). A session another agent opened with its own
 * serial is therefore NOT reported: that id is one `list-devices` hands out, so
 * a scope could have named it, and a session left on someone else's device is
 * that agent's business rather than a scope that cannot express itself.
 */
export function unnameableSessionUrns(urns: readonly string[]): string[] {
  return urns.filter((urn) => isLogicalKeyedDevice(deviceIdOfUrn(urn, PORT_KEYED_NAMESPACES)));
}
