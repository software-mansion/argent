import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { forgettingUiOrientation } from "../../utils/ios-ui-orientation";
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
      "Device id from `list-devices` (iOS UDID<flag:harmonyos>, HarmonyOS id,</flag:harmonyos> or Android serial)."
    ),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe(
      "Bundle id (iOS), package name (Android), component id (Vega)<flag:harmonyos>, or bundleName (HarmonyOS)</flag:harmonyos>."
    ),
  appPath: z
    .string()
    .describe(
      "Path to `.app` (iOS), `.apk` (Android), `.vpkg` (Vega)<flag:harmonyos>, or `.hap` (HarmonyOS)</flag:harmonyos>."
    ),
});

type Params = z.infer<typeof zodSchema>;

export const reinstallAppTool: ToolDefinition<Params, ReinstallAppResult> = {
  id: "reinstall-app",
  // An uninstall plus install can take minutes, past the 30s MCP fetch timeout.
  longRunning: true,
  description: `Uninstall any existing build and install a fresh app package (clears app data and permissions).
Use when installing a new build or resetting to clean state.
Returns \`{ reinstalled, bundleId }\`. Fails if \`appPath\` is invalid or mismatched with \`bundleId\` (checked before uninstall) or install/uninstall fails.`,
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
    ios: forgettingUiOrientation(iosImpl),
    android: androidImpl,
    iosDevice: iosDeviceImpl,
    iosRemote: forgettingUiOrientation(iosRemoteImpl),
    vega: vegaImpl,
    harmony: harmonyImpl,
  }),
};
