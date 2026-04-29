import { z } from "zod";
import type { DeviceInfo, Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../../utils/cross-platform-tool";
import { resolveDevice } from "../../../utils/device-info";
import type { BootDeviceParams, BootDeviceResult, BootDeviceServices } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

// NOTE on mutual exclusion: `udid` and `avdName` are exactly-one — but zod's
// `.refine()` returns a ZodEffects that our Registry ToolDefinition type does
// not accept (it requires a ZodObject so the JSON Schema generator can walk
// `.shape`). The exactly-one check therefore lives inside the platform-detection
// callback below and surfaces with a specific error message on the first call.
// We restate the constraint in each field's `.describe()` so MCP clients still
// see it in the generated tool docs even if their JSON-schema inspector ignores
// the runtime validation.
const zodSchema = z.object({
  udid: z
    .string()
    .optional()
    .describe(
      "iOS: simulator UDID to boot (from `list-devices`). Provide exactly one of `udid` or `avdName`."
    ),
  avdName: z
    .string()
    .optional()
    .describe(
      "Android: AVD name to launch a new emulator from (from `list-devices` → `avds[].name`). Provide exactly one of `udid` or `avdName`."
    ),
  coldBoot: z
    .boolean()
    .optional()
    .describe(
      "Android-only: force a full cold boot and skip the AVD snapshot. Defaults to false — the tool first probes the default_boot snapshot with `-check-snapshot-loadable`, hot-boots with `-force-snapshot-load` and a tight deadline, and falls back to a cold boot on any hot-boot failure. Pass true to skip the hot-boot attempt entirely. Ignored on iOS."
    ),
  noWindow: z
    .boolean()
    .optional()
    .describe(
      "Android-only: launch the emulator headless (no UI window). Useful for CI. Defaults to false so you can see boot progress. Ignored on iOS."
    ),
  bootTimeoutMs: z
    .number()
    .int()
    .min(30_000)
    .max(900_000)
    .optional()
    .describe(
      "Android-only: overall budget for the full boot sequence. Defaults to 480000 (8 min). Clamped to [30s, 15min]. Ignored on iOS."
    ),
});

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

// boot-device doesn't have a single `udid` to classify because the Android
// branch is creating the device, not targeting an existing one. Derive the
// platform from which optional input is set so `dispatchByPlatform` can route
// uniformly — the rest of the tool stays free of internal platform branching.
function deriveDevice(params: BootDeviceParams): DeviceInfo {
  const hasUdid = Boolean(params.udid);
  const hasAvd = Boolean(params.avdName);
  if (hasUdid === hasAvd) {
    throw new Error("Provide exactly one of `udid` (iOS) or `avdName` (Android).");
  }
  if (hasUdid) {
    return resolveDevice(params.udid!);
  }
  return { id: params.avdName!, platform: "android", kind: "emulator" };
}

export function createBootDeviceTool(
  registry: Registry
): ToolDefinition<BootDeviceParams, BootDeviceResult> {
  const dispatch = dispatchByPlatform<BootDeviceServices, BootDeviceParams, BootDeviceResult>({
    toolId: "boot-device",
    capability,
    device: deriveDevice,
    ios: makeIosImpl(registry),
    android: androidImpl,
  });

  return {
    id: "boot-device",
    description: `Start an iOS simulator or launch an Android emulator and wait until it is ready to accept interactions.
Pick the platform by which argument you pass: 'udid' for an iOS simulator from list-devices, or 'avdName' for an Android AVD (a serial is assigned automatically).
Use at the start of a session once you have picked a target.
Returns a tagged payload: { platform: 'ios', udid, booted } or { platform: 'android', serial, avdName, booted, coldBoot }.
Android boots take 2–10 minutes depending on machine and cold/warm state; if any boot stage fails, the tool terminates the emulator it spawned so the next retry starts clean.`,
    zodSchema,
    capability,
    services: dispatch.services,
    execute: dispatch.execute,
  };
}
