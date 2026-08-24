import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { PERMISSION_ACTIONS, PERMISSION_NAMES } from "./types";
import type { SettingsPermissionsResult, SettingsPermissionsServices } from "./types";
import { iosImpl, iosRemoteImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

// Mirror launch-app / restart-app: the leading-letter rule keeps a value like
// `--user` from masquerading as a flag, and the safe alphabet keeps the value
// inert when interpolated into an `adb shell` string (shellQuote is the real
// guard; this is defense in depth).
const BUNDLE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS simulator UDID or Android serial)."),
  action: z
    .enum(PERMISSION_ACTIONS)
    .describe(
      "`grant` pre-authorizes the permission, `deny` refuses it, `reset` returns it to the not-yet-asked state so the app prompts on next use."
    ),
  permission: z
    .enum(PERMISSION_NAMES)
    .describe(
      "The permission to change. `notifications` is Android-only (iOS has no simctl service for it); `reminders` is iOS-only; `camera` works on Android and on iOS only when the target simulator's runtime models the service (varies by simruntime, not by the installed Xcode)."
    ),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe(
      "App to change the permission for — required for every action. iOS: bundle id (e.g. com.example.app). Android: package name. `reset` is per-app too: simctl's device-wide reset (no bundleId) silently leaves existing per-app grants untouched on recent iOS, so the permission is always reset for this one app."
    ),
});

type Params = z.infer<typeof zodSchema>;

const permissionAction = {
  grant: { started: "Granting", completed: "Granted" },
  deny: { started: "Denying", completed: "Denied" },
  reset: { started: "Resetting", completed: "Reset" },
} as const;

const capability: ToolCapability = {
  // `simctl privacy` edits the simulator's TCC store — physical iPhones have no
  // equivalent host-side switch, so no `device: true` on apple.
  apple: { simulator: true },
  // sim-remote runs the same `simctl privacy` verb on a remote simulator, so a
  // sim-remote setup can pre-set permissions too — matching the rest of the
  // launch-app / restart-app / reinstall-app / open-url family.
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
};

export const settingsPermissionsTool: ToolDefinition<Params, SettingsPermissionsResult> = {
  id: "settings-permissions",
  interaction: {
    startedMsg: ({ params }) =>
      `${permissionAction[params.action].started} ${params.permission} permission for ${params.bundleId}`,
    completedMsg: ({ params }) =>
      `${permissionAction[params.action].completed} ${params.permission} permission for ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to ${params.action} ${params.permission} permission for ${params.bundleId}: ${failureSignal.error_code}`,
  },
  description: `Grant, deny, or reset a runtime permission for an app without navigating the system Settings UI. Use during test setup to pre-authorize (or explicitly deny) a service before the app asks, or \`reset\` so the permission dialog appears again on next use. Always per-app: bundleId is required.
Permissions: camera, microphone, photos, contacts, notifications, calendar, location, location-always, media-library, motion, reminders.
iOS simulator: edits the simulator's TCC store, always per-app. \`notifications\` is not supported (no iOS equivalent). \`reset\` is per-app — a device-wide reset is a no-op for existing grants on recent iOS, so it is not offered. \`grant location\`/\`location-always\` needs the app already installed (location auth isn't stored in TCC and isn't applied to a bundle id until the app exists) — enforced on local simulators; a remote simulator can't be probed for install state, so ensure the app is installed there first. Other services can be granted before install.
Android: changes the mapped \`android.permission.*\` runtime permissions (reset also best-effort clears the user-set permission flags). The app must be installed and declare them in its manifest; \`reminders\` has no Android equivalent.
Some permission changes terminate the app if it is running (system behavior on both platforms) — set permissions before launching, or relaunch after.
Returns { action, permission, bundleId, applied, skipped?, unverified? }: \`applied\` lists the platform-level services/permissions actually changed; \`skipped\` (Android) lists mapped permissions that did not take effect, e.g. ones the manifest doesn't declare. On Android this is established by reading the package manager's state back, because recent Android accepts a request for an undeclared permission and silently does nothing; \`unverified\` lists entries that were applied but could not be confirmed on this device. Granting fails if nothing took effect; denying an undeclared permission is already satisfied and is reported in \`skipped\`.`,
  searchHint: "grant deny reset revoke app permissions privacy camera microphone location settings",
  zodSchema,
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
