import { z } from "zod";

import { findExternalDevice, isExternalId } from "../external-devices";
import { canonicalDeviceId } from "./device-alias";

/**
 * React Native's default, used when neither the caller nor a provider names
 * one.
 */
const DEFAULT_METRO_PORT = 8081;

/**
 * The shared `port` parameter of every tool that keys a Metro session on
 * `(port, device_id)`: the debugger family, the network inspector and the
 * React profiler. That pair names the CDP service in its URN and the captured
 * profile on disk, so two tools deriving it differently address different
 * sessions.
 *
 * Deliberately has no zod `.default()`, for two reasons. A default cannot see
 * `device_id`, so it cannot use the port a provider publishes. It would
 * erase the difference between "the caller chose 8081" and "the caller said
 * nothing", which is what {@linkcode metroPort} branches on. Leaving it
 * optional also makes every raw read a type error until it goes through that
 * function.
 */
export const metroPortField = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .optional()
  /**
   * No mention of providers: twenty tools ship this field's text, in every
   * session. "Omit it" is also safer, an agent told the default is 8081 passes
   * 8081, which counts as explicit and beats a provider's port.
   */
  .describe(
    "Metro server port. Optional — omit it to use this device's port, 8081 by default. " +
      "Ignored for Chromium, whose CDP port is encoded in device_id."
  );

/**
 * The Metro port this call should use: caller, then provider, then the React
 * Native default. An explicit port wins so a second bundler stays addressable.
 *
 * The device id is canonicalized first, so a caller forwarding the
 * `logicalDeviceId` from `debugger-connect` still finds its provider. Only
 * provider devices reach the file read.
 */
export function metroPort(params: { device_id?: string; port?: number }): number {
  if (params.port !== undefined) return params.port;

  const deviceId = canonicalDeviceId(params.device_id);

  if (deviceId && isExternalId(deviceId)) {
    const published = findExternalDevice(deviceId)?.metroPort;
    if (published !== undefined) return published;
  }

  return DEFAULT_METRO_PORT;
}

/**
 * The CDP socket a provider wants Argent to attach to, in place of the target
 * Metro advertises. Only the socket comes from the provider: Metro still
 * supplies the session's metadata, so this composes with
 * {@linkcode metroPort}.
 */
export function externalJsDebuggerUrl(deviceId: string): string | undefined {
  if (!isExternalId(deviceId)) return undefined;

  return findExternalDevice(deviceId)?.jsDebugger?.webSocketUrl;
}

/**
 * The port a provider publishes, when it differs from the one being used. An
 * explicit `port` beats it by design, so a Metro-unreachable failure is the
 * only place that disagreement is visible. The blueprint turns this into a
 * hint.
 */
export function publishedMetroPort(deviceId: string, used: number): number | undefined {
  if (!isExternalId(deviceId)) return undefined;

  const published = findExternalDevice(deviceId)?.metroPort;

  return published !== undefined && published !== used ? published : undefined;
}
