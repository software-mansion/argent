import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { macosAppRef } from "../../blueprints/macos-app";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import type {
  RestartAppResult,
  RestartAppVegaServices,
  RestartAppIosServices,
  RestartAppHarmonyServices,
} from "./types";
import { makeIosImpl } from "./platforms/ios";
import { iosDeviceImpl } from "./platforms/ios-device";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { androidImpl } from "./platforms/android";
import { vegaImpl } from "./platforms/vega";
import { harmonyImpl } from "./platforms/harmony";
import { macosImpl } from "./platforms/macos";

// Same alphabet as launch-app's ACTIVITY_PATTERN: leading `.` for shorthand
// activities like `.MainActivity`, no leading `-` (flag injection).
const ACTIVITY_PATTERN = /^[A-Za-z_.][A-Za-z0-9._/-]*$/;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
  harmony: { device: true },
  macos: { app: true },
};

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS UDID<flag:macos-apps>, Mac app id</flag:macos-apps><flag:harmonyos>, HarmonyOS id,</flag:harmonyos> or Android serial)."
    ),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe(
      "App identifier. iOS: bundle id. Android: package name. Vega: interactive component app id.<flag:harmonyos> HarmonyOS: bundle name.</flag:harmonyos><flag:macos-apps> Mac app: the bundle id in the device id.</flag:macos-apps>"
    ),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe(
      "Android-only: relaunch a non-launcher Activity (e.g. `.SettingsActivity` or `com.example/com.example.SettingsActivity`). If omitted, the app's default launcher activity is used."
    ),
  launchArgs: z
    .array(z.string())
    .optional()
    .describe(
      'Apple simulators<flag:macos-apps>, Mac apps</flag:macos-apps> and physical iPhones: arguments passed to the app process at launch, e.g. `["-FeatureFlag", "YES"]` to override UserDefaults.<flag:macos-apps> Omitted on a Mac app, the app gets the arguments of its last start.</flag:macos-apps>'
    ),
});

type Params = z.infer<typeof zodSchema>;

// Local iOS resolves native-devtools inside the handler rather than via
// `services()`. A tvOS sim classifies as platform "ios", and native-devtools
// covers it too (ensureEnv injects the TVOSSIMULATOR dylib slice).
export function createRestartAppTool(registry: Registry): ToolDefinition<Params, RestartAppResult> {
  return {
    id: "restart-app",
    // Android's device probes, force-stop and `am start -W` can outlast the 30s MCP fetch timeout.
    longRunning: true,
    description: `Terminate then relaunch an app on iOS, Android, <flag:harmonyos>HarmonyOS, </flag:harmonyos><flag:macos-apps>macOS, </flag:macos-apps>or Vega.
Use when you need a clean in-memory state without a full reinstall. The relaunch also refreshes the native-devtools injection (iOS and Apple TV).<flag:macos-apps> On a Mac app it quits the app and starts the same .app again in the background.</flag:macos-apps>
Returns { restarted, bundleId, <flag:macos-apps>appPath?, args?, note?, </flag:macos-apps>networkCapture? }. networkCapture (Android, and local iOS simulators where capture stays on for later processes) says whether native network capture followed the launch.<flag:macos-apps> appPath and args (Mac app) are the .app that runs and its arguments; note (Mac app) warns about the start, for example a force-quit or no window.</flag:macos-apps> Fails if the app is not installed, on a local iOS simulator if terminating it does not finish within 15s, or on a remote simulator if terminating it fails for a reason other than the app not running.`,
    zodSchema,
    alwaysLoad: true,
    searchHint:
      "terminate relaunch restart reset app bundle id package simulator emulator vega tvos fire tv<flag:harmonyos> harmony harmonyos</flag:harmonyos>",
    interaction: {
      startedMsg: ({ params }) => `Restarting ${params.bundleId}`,
      completedMsg: ({ params }) => `Restarted ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to restart ${params.bundleId}: ${failureSignal.error_code}`,
    },
    capability,
    // Only ios-remote's handler reads `services.nativeDevtools`, so only it
    // needs an eager declaration.
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "ios-remote") return { nativeDevtools: nativeDevtoolsRef(device) };
      if (device.platform === "macos") return { macosApp: macosAppRef(device) };
      return {};
    },
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      Params,
      RestartAppResult,
      // No chromium branch.
      Record<string, unknown>,
      RestartAppVegaServices,
      RestartAppIosServices,
      RestartAppHarmonyServices
    >({
      toolId: "restart-app",
      capability,
      ios: makeIosImpl(registry),
      iosDevice: iosDeviceImpl,
      iosRemote: iosRemoteImpl,
      android: androidImpl,
      vega: vegaImpl,
      harmony: harmonyImpl,
      macos: macosImpl,
    }),
  };
}
