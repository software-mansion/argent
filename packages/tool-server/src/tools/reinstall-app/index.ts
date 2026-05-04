import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import type { ReinstallAppResult, ReinstallAppServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .describe(
      "App identifier that matches the bundle at `appPath`. iOS: bundle id (used to uninstall first). Android: package name (used to uninstall first; the install itself identifies the app from the APK)."
    ),
  appPath: z
    .string()
    .describe(
      "Path to the app bundle. iOS: `.app` directory (e.g. ./build/.../MyApp.app). Android: `.apk` file (e.g. android/app/build/outputs/apk/debug/app-debug.apk). Relative paths are resolved from the current working directory."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const reinstallAppTool: ToolDefinition<Params, ReinstallAppResult> = {
  id: "reinstall-app",
  description: `Install or reinstall an app on the device. The previous installation (if any) is uninstalled first so app data and runtime permissions are cleared on both platforms.
Use for a full reinstall after rebuilding, or to start from a clean app state.
Returns { reinstalled, bundleId }. Fails if the app path does not exist or the package does not match the platform (.app for iOS, .apk for Android).`,
  zodSchema,
  capability,
  services: () => ({}),
  execute: dispatchByPlatform<ReinstallAppServices, Params, ReinstallAppResult>({
    toolId: "reinstall-app",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
