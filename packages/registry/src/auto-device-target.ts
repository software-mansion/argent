/**
 * The one arg name auto-targeting fills in. `device_id` — the debugger and
 * profiler spelling — is deliberately absent even though it holds the same
 * `list-devices` id: those tools address a Metro/CDP session pinned by an
 * earlier `debugger-connect` or `*-profiler-start`, so the device to use is the
 * one that call named, not whichever is booted now.
 */
export const AUTO_DEVICE_TARGET_PARAM = "udid";

/** Appended to the param's own description, so the model reads the rule per tool. */
const AUTO_DEVICE_TARGET_HINT =
  "Optional: omit it and the server runs against the one booted device this tool supports. " +
  "Pass it to choose between several, or when the call is refused as ambiguous.";

/**
 * Rewrite a derived JSON Schema so `udid` reads as optional and says why, or
 * return it unchanged when the tool declares no required `udid`.
 *
 * Driven off the derived schema rather than a per-tool flag: the set is exactly
 * "tools that demand a device id they cannot work without", and a flag on each
 * of the ~37 of them is ~37 chances to forget one. Which tools are in it is
 * pinned by tool-server/test/auto-device-target.test.ts, so one joining or
 * leaving is a reviewed change rather than a silent one.
 *
 * A tool whose `udid` is ALREADY optional is left alone, because there the
 * absence means something of its own — `boot-device` without one boots by
 * `avdName`, and filling a device in would silently change which call was made.
 */
export function relaxAutoDeviceTarget(
  inputSchema: Record<string, unknown>
): Record<string, unknown> {
  const properties = inputSchema.properties;
  const required = inputSchema.required;
  if (!properties || typeof properties !== "object") return inputSchema;
  if (!Array.isArray(required) || !required.includes(AUTO_DEVICE_TARGET_PARAM)) return inputSchema;

  const props = properties as Record<string, unknown>;
  const udid = props[AUTO_DEVICE_TARGET_PARAM];
  if (!udid || typeof udid !== "object") return inputSchema;
  // Eight of these descriptions end without a terminator; joined on a bare space
  // the hint runs straight on from the last word ("...Simulator UDID Optional:").
  const described = (udid as { description?: unknown }).description;
  const trimmed = typeof described === "string" ? described.trim() : "";
  const prefix = trimmed ? `${/[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`} ` : "";

  const remaining = (required as string[]).filter((k) => k !== AUTO_DEVICE_TARGET_PARAM);
  const relaxed: Record<string, unknown> = {
    ...inputSchema,
    properties: {
      ...props,
      [AUTO_DEVICE_TARGET_PARAM]: { ...udid, description: `${prefix}${AUTO_DEVICE_TARGET_HINT}` },
    },
    required: remaining,
  };
  // `udid` was the only required arg on ten of these. The generator omits
  // `required` entirely when it would be empty, and draft-04 validators reject
  // an empty array outright, so drop the key rather than advertise `[]`.
  if (remaining.length === 0) delete relaxed.required;
  return relaxed;
}
