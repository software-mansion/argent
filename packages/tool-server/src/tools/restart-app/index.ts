import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { resolveDevice } from "../../utils/device-info";
import type { RestartAppAndroidServices, RestartAppIosServices, RestartAppResult } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

// Bundle id / package name. Head must be letter or underscore so a bundleId
// like `--user` can't masquerade as a flag inside `am force-stop …`.
const BUNDLE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
// Same alphabet as launch-app's ACTIVITY_PATTERN. Leading `.` is allowed so
// shorthand activities like `.MainActivity` work; leading `-` is forbidden
// for flag-injection reasons.
const ACTIVITY_PATTERN = /^[A-Za-z_.][A-Za-z0-9._/-]*$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe("App identifier. iOS: bundle id. Android: package name."),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe(
      "Android-only: relaunch a non-launcher Activity (e.g. `.SettingsActivity` or `com.example/com.example.SettingsActivity`). If omitted, the app's default launcher activity is used. Ignored on iOS."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const restartAppTool: ToolDefinition<Params, RestartAppResult> = {
  id: "restart-app",
  description: `Terminate then relaunch an app by bundle id / package name.
Use when you need a clean in-memory state without a full reinstall. Also refreshes the native-devtools injection on iOS before the relaunch.
Returns { restarted, bundleId }. Fails if the app is not installed.`,
  alwaysLoad: true,
  searchHint: "terminate relaunch restart reset app bundle id package simulator emulator",
  zodSchema,
  capability,
  // Only iOS needs the native-devtools service for relaunch injection.
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return device.platform === "ios" ? { nativeDevtools: nativeDevtoolsRef(device) } : {};
  },
  execute: dispatchByPlatform<
    RestartAppIosServices,
    RestartAppAndroidServices,
    Params,
    RestartAppResult
  >({
    toolId: "restart-app",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
