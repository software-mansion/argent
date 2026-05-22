import type { ServiceRef, ToolCapability } from "@argent/registry";
import { ELECTRON_ID_PREFIX, resolveDevice } from "../../utils/device-info";
import { electronJsRuntimeDebuggerRef } from "../../blueprints/electron-js-runtime-debugger";

/**
 * Capability matrix shared by every debugger-* tool that has been ported to
 * Electron CDP. iOS + Android continue to go through Metro; Electron goes
 * direct via the page CDP session that boot-device already opened.
 */
export const DEBUGGER_TOOL_CAPABILITY: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  electron: { app: true },
};

/**
 * Capability matrix for debugger-* tools that are NOT portable to Electron —
 * they depend on Metro, the RN inspector, or the React DevTools backend. The
 * absent `electron` field makes the HTTP capability gate reject them with a
 * clear "not supported on electron app" message before they ever run.
 */
export const RN_ONLY_TOOL_CAPABILITY: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

/**
 * Build the debugger service ref for the tool's `services()` callback. Routes
 * Electron device ids to the parallel ElectronJsRuntimeDebugger blueprint (a
 * thin adapter over the existing ElectronCdp session) and falls back to the
 * Metro-driven JsRuntimeDebugger blueprint for iOS / Android. The `port` field
 * is irrelevant for Electron — its CDP port lives inside the device id — so
 * passing 8081 by default in the tools' zodSchemas does no harm.
 */
export function debuggerServiceRef(params: { port: number; device_id?: string }): ServiceRef {
  // Only branch into the Electron blueprint when the device_id explicitly
  // matches the Electron shape. The Metro path is the default — it has to
  // tolerate undefined / empty / malformed ids the same way the original
  // template-literal implementation did, because tests and older callers
  // expect a Metro URN to come back even when device_id is missing.
  if (params.device_id && params.device_id.startsWith(ELECTRON_ID_PREFIX)) {
    const device = resolveDevice(params.device_id);
    return electronJsRuntimeDebuggerRef(device);
  }
  return `JsRuntimeDebugger:${params.port}:${params.device_id}`;
}
