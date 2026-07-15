import type { ServiceRef, ToolCapability } from "@argent/registry";
import { CHROMIUM_ID_PREFIX, resolveDevice } from "../../utils/device-info";
import { chromiumJsRuntimeDebuggerRef } from "../../blueprints/chromium-js-runtime-debugger";

/**
 * Capability matrix shared by every debugger-* tool that has been ported to
 * Chromium CDP. iOS + Android continue to go through Metro; Chromium goes
 * direct via the page CDP session that boot-device already opened.
 *
 * Vega (Fire TV) also goes through Metro: its React Native is a fork of RN
 * 0.72, whose Hermes serves the legacy inspector-proxy — `/json/list` exposes a
 * `Hermes React Native` target that speaks Runtime + Debugger. Everything in
 * this matrix needs only `Runtime.evaluate`, which that target supports. Note
 * the network inspector rides `Runtime.evaluate` too (it monkey-patches
 * `fetch`, it does not use the CDP `Network` domain), so it needs nothing from
 * the post-0.73 debugger stack. Requires a Debug `.vpkg` + Metro reachable from
 * the device — see the argent-tv-interact skill.
 */
export const DEBUGGER_TOOL_CAPABILITY: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

/**
 * Capability matrix for debugger-* tools that are NOT portable to Chromium —
 * they depend on Metro, the RN inspector, or the React DevTools backend. The
 * absent `chromium` field makes the HTTP capability gate reject them with a
 * clear "not supported on chromium app" message before they ever run.
 *
 * Remote (cloud) sims ARE supported: the app reaches the developer's local
 * Metro through a sim-remote reverse tunnel established lazily in the
 * JsRuntimeDebugger blueprint (every Metro-backed tool funnels through it), so
 * no per-tool transport plumbing is needed here.
 *
 * Vega is deliberately absent even though the plain debugger-* tools do work
 * there (see DEBUGGER_TOOL_CAPABILITY), for two different reasons:
 *
 *   - `debugger-component-tree` and `debugger-inspect-element` deliver their
 *     payload over `Runtime.addBinding` / `Runtime.bindingCalled` (they are the
 *     only two callers of `cdp.evaluateWithBinding`). RN 0.72's Hermes ACKs
 *     `Runtime.addBinding` and never installs the binding — verified on a live
 *     VVD: after connect, `typeof __argent_callback` is still "undefined" — so
 *     no `bindingCalled` ever fires and they would hang until timeout.
 *   - `debugger-reload-metro` and the `react-profiler-*` / `profiler-*` tools do
 *     NOT use the binding. `reload-metro` rides `Page.reload` (with an HTTP
 *     `/reload` fallback), and the capture step — `react-profiler-start` /
 *     `-stop` — drives `Runtime.evaluate` plus the CDP `Profiler` domain; the
 *     remaining profiler tools only read a session already written to disk and
 *     touch no CDP at all. They are gated because that capture path is
 *     unverified against the legacy inspector (and the query tools are useless
 *     without it), not because of a missing binding.
 *
 * Either way, gating them out turns a hang or an unknown into an immediate,
 * explicit "not supported".
 */
export const RN_ONLY_TOOL_CAPABILITY: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
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
