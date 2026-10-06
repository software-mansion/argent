import { z } from "zod";
import { canonicalDeviceId } from "./device-alias";

/**
 * A `device_id` parameter that accepts either id namespace: the `list-devices`
 * id (simulator UDID or adb serial) these tools key sessions by, and the Metro
 * `logicalDeviceId` `debugger-connect` returns and the debugger tools tell the
 * user to pass when several devices share one Metro. `classifyDevice` decides
 * platform purely from an id's shape, so an opaque logicalDeviceId falls
 * through to "android" and builds an Android session for an iOS device (#618).
 *
 * Canonicalizing in the param rather than per tool is what makes it stick: the
 * registry parses params once and hands the SAME object to `services()` and
 * `execute()`, so one transform covers URN construction, the platform branch,
 * and every id forwarded to a platform impl — including those passed to `adb`
 * and `simctl` as a serial.
 *
 * Deliberately NOT done inside `resolveDevice`: that is the lowest-level
 * identity primitive, used by call sites that can only ever receive a
 * list-devices id, and making it consult a mutable alias map would make the
 * same input resolve differently depending on whether a debugger had connected.
 *
 * Invisible on the wire — `zodObjectToJsonSchema` derives the published schema
 * with `io: "input"`, which keeps the string, the `minLength` and the
 * description and drops the transform.
 */
export function metroDeviceIdParam(description: string) {
  return z
    .string()
    .min(1, "device_id must not be empty")
    .describe(description)
    .transform((id: string) => canonicalDeviceId(id) ?? id);
}
