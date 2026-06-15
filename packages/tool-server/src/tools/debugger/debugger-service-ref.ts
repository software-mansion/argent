import type { ServiceRef, ToolCapability } from "@argent/registry";
import { CHROMIUM_ID_PREFIX, resolveDevice } from "../../utils/device-info";
import { chromiumJsRuntimeDebuggerRef } from "../../blueprints/chromium-js-runtime-debugger";

/**
 * Capability matrix shared by every debugger-* tool that has been ported to
 * Chromium CDP. iOS + Android continue to go through Metro; Chromium goes
 * direct via the page CDP session that boot-device already opened.
 */
export const DEBUGGER_TOOL_CAPABILITY: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
};

/**
 * Capability matrix for debugger-* tools that are NOT portable to Chromium —
 * they depend on Metro, the RN inspector, or the React DevTools backend. The
 * absent `chromium` field makes the HTTP capability gate reject them with a
 * clear "not supported on chromium app" message before they ever run.
 */
export const RN_ONLY_TOOL_CAPABILITY: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

/**
 * Build the debugger service ref for the tool's `services()` callback. Routes
 * Chromium device ids to the parallel ChromiumJsRuntimeDebugger blueprint (a
 * thin adapter over the existing ChromiumCdp session) and falls back to the
 * Metro-driven JsRuntimeDebugger blueprint for iOS / Android. The `port` field
 * is irrelevant for Chromium — its CDP port lives inside the device id — so
 * passing 8081 by default in the tools' zodSchemas does no harm.
 */
export function debuggerServiceRef(params: { port: number; device_id?: string }): ServiceRef {
  // Only branch into the Chromium blueprint when the device_id explicitly
  // matches the Chromium shape. The Metro path is the default — it has to
  // tolerate undefined / empty / malformed ids the same way the original
  // template-literal implementation did, because tests and older callers
  // expect a Metro URN to come back even when device_id is missing.
  if (params.device_id && params.device_id.startsWith(CHROMIUM_ID_PREFIX)) {
    const device = resolveDevice(params.device_id);
    return chromiumJsRuntimeDebuggerRef(device);
  }
  return `JsRuntimeDebugger:${params.port}:${params.device_id}`;
}
