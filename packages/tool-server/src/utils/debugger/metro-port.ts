import { z } from "zod";

import { externalClaimForAnyId } from "../external-devices";
import { canonicalDeviceId } from "./device-alias";

/**
 * React Native's default, used when neither the caller nor a provider names
 * one.
 */
const DEFAULT_METRO_PORT = 8081;

/**
 * The schemas {@linkcode markMetroPort} marked. A WeakSet, not zod metadata:
 * `.meta()` would be printed into every tool's advertised JSON Schema.
 */
const METRO_PORT_SCHEMAS = new WeakSet<z.ZodType>();

/**
 * Mark a schema as a Metro port, so an e2e run's `metroPort` replaces it (see
 * `bindRunArgs` in flows/flow-device). Only for a field that means the Metro
 * server port on every platform the tool runs on: `boot-device`'s `port` is an
 * emulator console port and stays unmarked.
 */
export function markMetroPort<T extends z.ZodType>(schema: T): T {
  METRO_PORT_SCHEMAS.add(schema);
  return schema;
}

/**
 * Whether `schema` is a marked Metro port or a clone of one. `.describe()`
 * returns a clone whose `_zod.parent` is the schema it was cloned from, so a
 * tool that rewords {@linkcode metroPortField} still counts.
 */
export function isMetroPortSchema(schema: unknown): boolean {
  for (let s = schema as z.ZodType | undefined; s; s = s._zod.parent as z.ZodType | undefined) {
    if (METRO_PORT_SCHEMAS.has(s)) return true;
  }
  return false;
}

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
export const metroPortField = markMetroPort(
  z.coerce
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
      "Metro port. Omit it to use this device's port (8081 by default). " +
        "Ignored for Chromium, whose CDP port is in device_id."
    )
);

/**
 * `e2e-execute`'s `metroPort`: a number, or a decimal string for the callers
 * that send numbers as text. Stricter than {@linkcode metroPortField}, whose
 * `z.coerce` turns `true` into 1 and `[8097]` into 8097: this value replaces
 * the port of every Metro step in the run, so a typo must fail the run rather
 * than pick a port.
 */
export const runMetroPortField = z
  .preprocess(
    (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value),
    z.number().int().min(1).max(65535)
  )
  .optional();

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
