import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import { PERMISSION_ACTIONS, PERMISSION_NAMES } from "./types";
import type { SettingsPermissionsResult, SettingsPermissionsServices } from "./types";
import { iosImpl, iosRemoteImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const permissionAction = {
  grant: { started: "Granting", completed: "Granted" },
  deny: { started: "Denying", completed: "Denied" },
  reset: { started: "Resetting", completed: "Reset" },
} as const;

const capability: ToolCapability = {
  // `simctl privacy` edits the simulator's TCC store; physical iPhones have no
  // equivalent host-side switch, hence no `device: true`.
  apple: { simulator: true },
  // sim-remote exposes the same `simctl privacy` verb, so remote sims can
  // pre-set permissions too.
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Device id from `list-devices` (iOS simulator UDID or Android serial)."),
  action: z
    .enum(PERMISSION_ACTIONS)
    .describe("`grant` (pre-authorize), `deny`, or `reset` (re-prompt on next use)."),
  permission: z
    .enum(PERMISSION_NAMES)
    .describe("Permission name (`notifications` = Android-only; `reminders` = iOS-only)."),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe("Target app bundle id (iOS) or package name (Android)."),
});

type Params = z.infer<typeof zodSchema>;

export const settingsPermissionsTool: ToolDefinition<Params, SettingsPermissionsResult> = {
  id: "settings-permissions",
  description: `Grant, deny, or reset an app's runtime permission without opening Settings. Use when setting up permissions before launching or triggering a prompt (changing permissions may terminate a running app).
iOS sim: \`grant location\`/\`location-always\` requires the app installed first. Android: app must be installed and declare the mapped permissions in its manifest.
Returns \`{ action, permission, bundleId, applied, skipped? }\`. Fails if nothing could be applied.`,
  zodSchema,
  searchHint: "grant deny reset revoke app permissions privacy camera microphone location settings",
  interaction: {
    startedMsg: ({ params }) =>
      `${permissionAction[params.action].started} ${params.permission} permission for ${params.bundleId}`,
    completedMsg: ({ params }) =>
      `${permissionAction[params.action].completed} ${params.permission} permission for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to ${params.action} ${params.permission} permission for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability,
  services: () => ({}),
  execute: dispatchByPlatform<
    SettingsPermissionsServices,
    SettingsPermissionsServices,
    Params,
    SettingsPermissionsResult
  >({
    toolId: "settings-permissions",
    capability,
    ios: iosImpl,
    iosRemote: iosRemoteImpl,
    android: androidImpl,
  }),
};
