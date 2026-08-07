import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import type { ReinstallAppResult, ReinstallAppServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { vegaImpl } from "./platforms/vega";

// Mirror launch-app / restart-app: the leading-letter rule keeps a value like
// `--user` from masquerading as a flag. Execution uses execFile with an argv
// array (no shell), so this is a consistency guard, not an injection fix.
const BUNDLE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe(
      "App identifier that matches the bundle at `appPath`. iOS: bundle id (used to uninstall first). Android: package name (used to uninstall first; the install itself identifies the app from the APK). Vega: interactive component app id (e.g. com.example.app.main), used to uninstall first."
    ),
  appPath: z
    .string()
    .describe(
      "Path to the app bundle. iOS: `.app` directory (e.g. ./build/.../MyApp.app). Android: `.apk` file (e.g. android/app/build/outputs/apk/debug/app-debug.apk). Vega: `.vpkg` file. Relative paths are resolved from the current working directory."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
};

export const reinstallAppTool: ToolDefinition<Params, ReinstallAppResult> = {
  id: "reinstall-app",
  interaction: {
    startedMsg: ({ params }) => `Reinstalling ${params.bundleId}`,
    completedMsg: ({ params }) => `Reinstalled ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to reinstall ${params.bundleId}: ${failureSignal.error_code}`,
  },
  description: `Install or reinstall an app on the device. The previous installation (if any) is uninstalled first so app data and runtime permissions are cleared.
Use for a full reinstall after rebuilding, or to start from a clean app state.
Returns { reinstalled, bundleId }. The artifact is checked before anything is uninstalled, so a wrong path leaves the current installation in place: fails if the app path does not exist or does not match the platform (.app bundle directory for iOS, .apk file for Android, .vpkg file for Vega). A device can still reject a well-formed artifact at install time (wrong ABI, minimum OS version, signature mismatch), and in that case the previous installation is already gone.`,
  zodSchema,
  capability,
  fileInputs: [{ target: "appPath", path: "${appPath}", kind: "tar-upload" }],
  services: () => ({}),
  execute: dispatchByPlatform<
    ReinstallAppServices,
    ReinstallAppServices,
    Params,
    ReinstallAppResult,
    // No chromium branch — falls back to the ChromiumServices default.
    Record<string, unknown>,
    ReinstallAppServices,
    ReinstallAppServices
  >({
    toolId: "reinstall-app",
    capability,
    ios: iosImpl,
    android: androidImpl,
    iosRemote: iosRemoteImpl,
    vega: vegaImpl,
  }),
};
