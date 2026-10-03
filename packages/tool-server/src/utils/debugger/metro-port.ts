import { z } from "zod";

import { externalClaimForAnyId } from "../external-devices";
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

  if (deviceId) {
    const published = externalClaimForAnyId(deviceId)?.metroPort;
    if (published !== undefined) return published;
  }

  return DEFAULT_METRO_PORT;
}

/**
 * Whether {@linkcode metroPort} had to RESOLVE this call's port instead of being
 * handed one.
 *
 * A resolved port is read from the provider's descriptor, so two identical calls
 * can get different answers as the provider withdraws or re-ports the device; a
 * caller's own port is returned verbatim and cannot move. Readers of the
 * reaped-session store need that difference. A key built from a resolved port
 * may no longer be the one the session was filed under, so a miss there is
 * forgivable; a key built from a named port that misses is a different session,
 * and answering it with another port's record would hand a healthy session a
 * stranger's crash.
 */
export function metroPortWasResolved(params: { device_id?: string; port?: number }): boolean {
  return params.port === undefined;
}

/**
 * Whether `port` is the one a call naming no port resolves for this device — so
 * a session on it is the session such a call addresses, and a later one may
 * address it by a different port.
 *
 * Not the same question as who supplied the port. A caller that names the port
 * resolution would have picked anyway is on that same session, while one that
 * omits it on a device no descriptor claims still holds a port that moves the
 * moment a provider claims it. Both are what the answer turns on, and neither
 * follows from `params.port` being set.
 *
 * Ask while the claim is live, at connect. A provider withdrawing the device is
 * itself one of the things that ends a session, so by the time that session's
 * dispose runs the descriptor the port came from may already be gone — and this
 * would then answer for a resolution nothing ran.
 */
export function isResolvedMetroPort(deviceId: string, port: number): boolean {
  return metroPort({ device_id: deviceId }) === port;
}

/**
 * The CDP socket a provider wants Argent to attach to, in place of the target
 * Metro advertises. Only the socket comes from the provider: Metro still
 * supplies the session's metadata, so this composes with
 * {@linkcode metroPort}.
 *
 * Answers for the raw serial / udid as well as the `ext:` id. Missing that, a
 * caller naming a claimed device the way `adb devices` does would open its own
 * CDP connection to Metro's target. Inspector-proxy admits one debugger per
 * device, so that evicts the provider's and the two reconnect in a loop.
 */
export function externalJsDebuggerUrl(deviceId: string): string | undefined {
  return externalClaimForAnyId(deviceId)?.jsDebugger?.webSocketUrl;
}

/**
 * The port a provider publishes, when it differs from the one being used. An
 * explicit `port` beats it by design, so a Metro-unreachable failure is the
 * only place that disagreement is visible. The blueprint turns this into a
 * hint.
 */
export function publishedMetroPort(deviceId: string, used: number): number | undefined {
  const published = externalClaimForAnyId(deviceId)?.metroPort;

  return published !== undefined && published !== used ? published : undefined;
}
