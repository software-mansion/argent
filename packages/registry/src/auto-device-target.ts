/**
 * The one arg name auto-targeting fills in. `device_id` is deliberately absent:
 * on the debugger and profiler tools that spell it, it is a Metro/CDP LOGICAL
 * device id, which is neither a simulator UDID nor an adb serial and cannot be
 * read off `list-devices` at all.
 */
export const AUTO_DEVICE_TARGET_PARAM = "udid";

/** Appended to the param's own description, so the model reads the rule per tool. */
const AUTO_DEVICE_TARGET_HINT =
  "Optional when exactly one booted device supports this tool: omit it and the server " +
  "resolves that device. Pass it whenever several are booted, or to name one explicitly.";

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
  const described = (udid as { description?: unknown }).description;
  const prefix = typeof described === "string" && described ? `${described} ` : "";

  return {
    ...inputSchema,
    properties: {
      ...props,
      [AUTO_DEVICE_TARGET_PARAM]: { ...udid, description: `${prefix}${AUTO_DEVICE_TARGET_HINT}` },
    },
    required: (required as string[]).filter((k) => k !== AUTO_DEVICE_TARGET_PARAM),
  };
}
