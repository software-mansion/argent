import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { resolveDevice } from "../../utils/device-info";
import type { LaunchAppAndroidServices, LaunchAppIosServices, LaunchAppResult } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

// Android package grammar is `[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+`;
// iOS bundle ids use the same reverse-DNS shape with dashes allowed. The union
// is letters, digits, underscore, dot, hyphen — but the head must be a letter
// or underscore so a bundleId like `--user` can't masquerade as a flag inside
// `am start -n …` / `cmd package resolve-activity …`.
const BUNDLE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
// Activity names can be `.Foo`, `com.x.y/.Foo`, or `com.x/com.x.Foo`. Same alphabet
// plus `/` as the package/activity separator. `$` and other shell metacharacters
// are deliberately excluded. Leading `-` is also forbidden for flag-injection
// reasons; `.` is allowed as the head so dot-prefixed activities still work.
const ACTIVITY_PATTERN = /^[A-Za-z_.][A-Za-z0-9._/-]*$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe(
      "App identifier. iOS: bundle id (e.g. com.apple.MobileSMS). Android: package name from build.gradle `applicationId` (e.g. com.android.settings)."
    ),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe(
      "Android-only: fully-qualified Activity name (e.g. `.MainActivity` or `com.example/com.example.MainActivity`). If omitted on Android, the app's default launcher activity is used. Ignored on iOS."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const launchAppTool: ToolDefinition<Params, LaunchAppResult> = {
  id: "launch-app",
  description: `Open an app by its bundle id (iOS) or package name (Android).
Use when starting any app — prefer this over tapping home-screen / launcher icons. Also prepares the native-devtools injection on iOS before the app starts.
Returns { launched, bundleId }. Fails if the app is not installed on the target device.

Common iOS bundle ids: com.apple.MobileSMS, com.apple.mobilesafari, com.apple.Preferences, com.apple.Maps, com.apple.camera, com.apple.Photos, com.apple.mobilemail, com.apple.mobilenotes, com.apple.MobileAddressBook
Common Android packages: com.android.settings, com.android.chrome, com.google.android.apps.maps, com.google.android.gm, com.android.vending, com.google.android.dialer, com.google.android.apps.messaging`,
  alwaysLoad: true,
  searchHint: "open start app bundle id package simulator emulator launch",
  zodSchema,
  capability,
  // Only iOS needs the native-devtools service for launch-time injection.
  // Resolving it on Android would force the iOS-only blueprint to spin up.
  services: (params): Record<string, ServiceRef> => {
    const device = resolveDevice(params.udid);
    return device.platform === "ios" ? { nativeDevtools: nativeDevtoolsRef(device) } : {};
  },
  execute: dispatchByPlatform<LaunchAppIosServices, LaunchAppAndroidServices, Params, LaunchAppResult>({
    toolId: "launch-app",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
