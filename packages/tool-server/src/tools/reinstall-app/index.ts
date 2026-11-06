import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import type { ReinstallAppResult, ReinstallAppServices } from "./types";
import { iosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";
import { iosDeviceImpl } from "./platforms/ios-device";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { vegaImpl } from "./platforms/vega";
import { harmonyImpl } from "./platforms/harmony";

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
  harmony: { device: true },
};

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS UDID<flag:harmonyos>, HarmonyOS id,</flag:harmonyos> or Android serial)."
    ),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe(
      "App identifier, used to uninstall the previous installation. iOS: bundle id. Android: package name. Vega: interactive component app id (e.g. com.example.app.main).<flag:harmonyos> HarmonyOS: bundle name (`app.bundleName` in the `.hap`).</flag:harmonyos>"
    ),
  appPath: z
    .string()
    .describe(
      "Path to the app bundle. iOS: `.app` directory (e.g. ./build/.../MyApp.app). Android: `.apk` file (e.g. android/app/build/outputs/apk/debug/app-debug.apk). Vega: `.vpkg` file.<flag:harmonyos> HarmonyOS: `.hap` file.</flag:harmonyos> Relative paths are resolved from the current working directory."
    ),
});

type Params = z.infer<typeof zodSchema>;

export const reinstallAppTool: ToolDefinition<Params, ReinstallAppResult> = {
  id: "reinstall-app",
  description: `Install or reinstall an app on the device. The previous installation (if any) is uninstalled first so app data and runtime permissions are cleared.
Use for a full reinstall after rebuilding, or to start from a clean app state.
Returns { reinstalled, bundleId }. Fails if \`appPath\` does not exist or is not the platform's package, or \`bundleId\` does not match it (not checked on Vega or a remote simulator); these checks run before anything is uninstalled.`,
  zodSchema,
  interaction: {
    startedMsg: ({ params }) => `Reinstalling ${params.bundleId}`,
    completedMsg: ({ params }) => `Reinstalled ${params.bundleId}`,
    failedMsg: ({ params, failureSignal }) =>
      `Failed to reinstall ${params.bundleId}: ${failureSignal.error_code}`,
  },
  capability,
  fileInputs: [{ target: "appPath", path: "${appPath}", kind: "tar-upload" }],
  services: () => ({}),
  execute: dispatchByPlatform<
    ReinstallAppServices,
    ReinstallAppServices,
    Params,
    ReinstallAppResult,
    // No chromium branch; placeholder so the vega/ios-remote slots line up.
    Record<string, unknown>,
    ReinstallAppServices,
    ReinstallAppServices,
    ReinstallAppServices
  >({
    toolId: "reinstall-app",
    capability,
    ios: iosImpl,
    android: androidImpl,
    iosDevice: iosDeviceImpl,
    iosRemote: iosRemoteImpl,
    vega: vegaImpl,
    harmony: harmonyImpl,
  }),
};
