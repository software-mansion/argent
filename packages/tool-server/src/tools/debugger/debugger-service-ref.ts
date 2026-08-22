import type { ServiceRef, ToolCapability } from "@argent/registry";
import { CHROMIUM_ID_PREFIX, resolveDevice } from "../../utils/device-info";
import { chromiumJsRuntimeDebuggerRef } from "../../blueprints/chromium-js-runtime-debugger";
import { canonicalDeviceId } from "../../utils/debugger/device-alias";

/**
 * For tools that work on every platform including Chromium: iOS / Android /
 * Vega go through Metro, Chromium goes direct over CDP.
 *
 * Vega (Fire TV) works because everything in this matrix needs only
 * `Runtime.evaluate`, which the legacy Hermes inspector in its RN 0.72 fork
 * serves — the network inspector included, since it monkey-patches `fetch`
 * rather than using the CDP `Network` domain. Requires a Debug `.vpkg` + Metro
 * reachable from the device; see the argent-tv-interact skill.
 */
export const DEBUGGER_TOOL_CAPABILITY: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

/**
 * For debugger-* tools that are NOT portable to Chromium — they depend on
 * Metro, the RN inspector, or the React DevTools backend. The absent `chromium`
 * field makes the capability gate reject them with a clear "not supported on
 * chromium app" before they ever run.
 *
 * Remote (cloud) sims ARE supported: the JsRuntimeDebugger blueprint opens a
 * sim-remote reverse tunnel to the developer's local Metro lazily, so no
 * per-tool transport plumbing is needed here.
 *
 * Vega is deliberately absent even though the plain debugger-* tools do work
 * there (see DEBUGGER_TOOL_CAPABILITY), for two different reasons:
 *
 *   - `debugger-component-tree` and `debugger-inspect-element` are the only two
 *     callers of `cdp.evaluateWithBinding`. RN 0.72's Hermes ACKs
 *     `Runtime.addBinding` and never installs the binding — verified on a live
 *     VVD: after connect, `typeof __argent_callback` is still "undefined" — so
 *     no `bindingCalled` ever fires and they would hang until timeout.
 *   - `debugger-reload-metro` and the `react-profiler-*` / `profiler-*` tools do
 *     NOT use the binding; they are gated because their paths are unverified
 *     against the legacy inspector.
 */
export const RN_ONLY_TOOL_CAPABILITY: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

/**
 * Debugger service ref for a tool's `services()` callback. `port` is irrelevant
 * for Chromium — its CDP port lives inside the device id — so the 8081 default
 * in the tools' zodSchemas does no harm.
 */
export function debuggerServiceRef(params: { port: number; device_id?: string }): ServiceRef {
  // Collapse a forwarded logicalDeviceId back onto the id its device was
  // connected with, so it resolves to the one open debugger instance rather
  // than minting a second URN. See utils/debugger/device-alias.ts.
  const deviceId = canonicalDeviceId(params.device_id);
  // The Metro path is the default, and has to tolerate undefined / empty /
  // malformed ids: pre-chromium tests and older callers expect a Metro URN back
  // even when device_id is missing.
  if (deviceId && deviceId.startsWith(CHROMIUM_ID_PREFIX)) {
    const device = resolveDevice(deviceId);
    return chromiumJsRuntimeDebuggerRef(device);
  }
  return `JsRuntimeDebugger:${params.port}:${deviceId}`;
}
