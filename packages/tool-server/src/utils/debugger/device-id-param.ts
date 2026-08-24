import { z } from "zod";
import { canonicalDeviceId } from "./device-alias";

/**
 * A `device_id` parameter that accepts either id namespace the Metro-family
 * tools deal in.
 *
 * `debugger-connect` returns a Metro `logicalDeviceId`, and when several devices
 * share one Metro the debugger tools instruct the user to pass it. But profiler
 * sessions are keyed by the list-devices id (the simulator UDID or adb serial),
 * and `classifyDevice` decides platform purely from an id's shape — an opaque
 * logicalDeviceId matches no known shape, so it falls through to "android"
 * (utils/device-info.ts:52). Following the debugger tools' own advice therefore
 * built an Android session for an iOS device: the wrong service, not merely the
 * wrong word in a message (#618).
 *
 * Canonicalizing here rather than inside each tool is what makes it stick. The
 * registry parses params exactly once and hands the SAME object to `services()`
 * and to `execute()` (packages/registry/src/registry.ts:125-153), so one
 * transform covers URN construction, the platform branch, and every id the tool
 * forwards to a platform impl — including the ones passed straight to `adb` and
 * `simctl` as a serial. Canonicalizing in `services()` alone would leave those
 * disagreeing with each other.
 *
 * Deliberately NOT done inside `resolveDevice`: that is the lowest-level
 * identity primitive, used by ~60 call sites that can only ever receive a
 * list-devices id, and making it consult a mutable alias map would make the same
 * input resolve differently depending on whether a debugger had connected.
 *
 * The transform is invisible on the wire — `zodObjectToJsonSchema` derives the
 * published schema with `io: "input"`, which keeps the `string`, the
 * `minLength` and the description and drops the transform.
 */
export function metroDeviceIdParam(description: string) {
  return z
    .string()
    .min(1, "device_id must not be empty")
    .describe(description)
    .transform((id: string) => canonicalDeviceId(id) ?? id);
}
