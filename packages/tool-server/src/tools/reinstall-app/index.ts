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
      "App identifier that matches the bundle at `appPath`. iOS: bundle id (used to uninstall first so data is cleared). Android: package name (used only in the return payload — the install identifies the app from the APK)."
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

const dispatch = dispatchByPlatform<ReinstallAppServices, Params, ReinstallAppResult>({
  toolId: "reinstall-app",
  capability,
  ios: iosImpl,
  android: androidImpl,
});

export const reinstallAppTool: ToolDefinition<Params, ReinstallAppResult> = {
  id: "reinstall-app",
  description: `Install or reinstall an app on the device.
Use for a full reinstall after rebuilding, or to clear app data (iOS clears data on every reinstall; Android preserves data unless the caller wipes it).
Returns { reinstalled, bundleId }. Fails if the app path does not exist or the package does not match the platform (.app for iOS, .apk for Android).`,
  zodSchema,
  capability,
  services: dispatch.services,
  execute: dispatch.execute,
};
