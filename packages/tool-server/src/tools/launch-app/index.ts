import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
import { macosAppRef } from "../../blueprints/macos-app";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../utils/bundle-id";
import type {
  LaunchAppResult,
  LaunchAppVegaServices,
  LaunchAppIosServices,
  LaunchAppHarmonyServices,
} from "./types";
import { makeIosImpl } from "./platforms/ios";
import { iosDeviceImpl } from "./platforms/ios-device";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { androidImpl } from "./platforms/android";
import { chromiumImpl, type LaunchAppChromiumServices } from "./platforms/chromium";
import { vegaImpl } from "./platforms/vega";
import { harmonyImpl } from "./platforms/harmony";
import { macosImpl } from "./platforms/macos";

// The bundleId alphabet plus `/` as the package/activity separator, with `.`
// allowed as the head so `.MainActivity` works. Leading `-` is excluded for the
// same flag-injection reason as bundleId, as are shell metacharacters like `$`.
const ACTIVITY_PATTERN = /^[A-Za-z_.][A-Za-z0-9._/-]*$/;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
  harmony: { device: true },
  macos: { app: true },
};

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe(
      "Target device id from `list-devices` (iOS UDID, Android serial, <flag:harmonyos>HarmonyOS id, </flag:harmonyos><flag:macos-apps>Mac app id, </flag:macos-apps>or Chromium id)."
    ),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe(
      "App identifier. iOS: bundle id. Android: package name from build.gradle `applicationId`. Vega (Fire TV): the interactive component app id from manifest.toml (e.g. com.example.app.main). <flag:harmonyos>HarmonyOS: bundle name as listed by `bm dump -a` (e.g. com.huawei.hmos.calculator). </flag:harmonyos>Chromium: any tag matching the pattern.<flag:macos-apps> Mac app: the bundle id in the device id.</flag:macos-apps>"
    ),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe(
      "Android-only: fully-qualified Activity name (e.g. `.MainActivity` or `com.example/com.example.MainActivity`). If omitted, the app's default launcher activity is used."
    ),
  launchArgs: z
    .array(z.string())
    .optional()
    .describe(
      'Apple simulators<flag:macos-apps>, Mac apps</flag:macos-apps> and physical iPhones: arguments passed to the app process at launch, e.g. `["-FeatureFlag", "YES"]` to override UserDefaults. A running app is relaunched to apply them<flag:macos-apps>, except a Mac app: use restart-app for that. Omitted on a Mac app, a stopped app gets the arguments of its last start</flag:macos-apps>. The call fails, launching nothing, if terminating it does not finish within 15s on a local iOS simulator, or fails for a reason other than the app not running on a remote one.'
    ),
});

type Params = z.infer<typeof zodSchema>;

// native-devtools is resolved through `registry` inside the iOS handler rather
// than declared in `services()` — the same pattern as `describe` / `screenshot`.
// A tvOS sim classifies as platform "ios" by UDID shape, and native-devtools
// covers both: its ensureEnv picks the platform-matched DYLD_INSERT_LIBRARIES
// slice (the TVOSSIMULATOR bootstrap for Apple TV sims), so injection is
// prepared on tvOS too.
export function createLaunchAppTool(registry: Registry): ToolDefinition<Params, LaunchAppResult> {
  return {
    id: "launch-app",
    // Android's device probes plus `am start -W` can outlast the 30s MCP fetch timeout.
    longRunning: true,
    description: `Open an installed app, or confirm the running renderer (Chromium).<flag:macos-apps> On a Mac app it starts the app in the background when it does not run, and leaves a running app as it is.</flag:macos-apps>
Use when starting any app; prefer this over tapping home-screen / launcher icons. Also prepares the native-devtools injection before the app starts (iOS and Apple TV).
Returns { launched, bundleId, <flag:macos-apps>appPath?, args?, </flag:macos-apps>note?, networkCapture? }. Fails if the app is not installed on the target device (iOS / Android<flag:harmonyos> / HarmonyOS</flag:harmonyos>). On a physical iPhone this registers the app every other tool acts on; com.apple.springboard and com.apple.Spotlight register without launching. note warns when runner signing is not ready.<flag:macos-apps> appPath and args (Mac app) are the .app that runs and its arguments; note (Mac app) also says when the app already ran or shows no window.</flag:macos-apps> networkCapture (Android) says whether native network capture followed the launch.
For Chromium, the app is already running behind a CDP port; this call simply refreshes the cached viewport and acknowledges the bundleId tag. To change the visible route, use \`open-url\`.

Common iOS bundle ids: com.apple.MobileSMS, com.apple.mobilesafari, com.apple.Preferences, com.apple.Maps, com.apple.mobileslideshow (Photos), com.apple.MobileAddressBook
Common Android packages: com.android.settings, com.android.chrome, com.google.android.apps.maps, com.google.android.gm, com.android.vending, com.google.android.dialer, com.google.android.apps.messaging`,
    zodSchema,
    alwaysLoad: true,
    searchHint:
      "open start app bundle id package simulator emulator chromium vega launch tvos apple tv fire tv",
    interaction: {
      startedMsg: ({ params }) => `Launching ${params.bundleId}`,
      completedMsg: ({ params }) => `Launched ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to launch ${params.bundleId}: ${failureSignal.error_code}`,
    },
    capability,
    // ios-remote's handler reads `services.nativeDevtools`; local iOS resolves
    // it lazily instead (see header comment).
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "ios-remote") return { nativeDevtools: nativeDevtoolsRef(device) };
      if (device.platform === "chromium") return { chromium: chromiumCdpRef(device) };
      if (device.platform === "macos") return { macosApp: macosAppRef(device) };
      return {};
    },
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      Params,
      LaunchAppResult,
      LaunchAppChromiumServices,
      LaunchAppVegaServices,
      LaunchAppIosServices,
      LaunchAppHarmonyServices
    >({
      toolId: "launch-app",
      capability,
      ios: makeIosImpl(registry),
      iosDevice: iosDeviceImpl,
      iosRemote: iosRemoteImpl,
      android: androidImpl,
      chromium: chromiumImpl,
      vega: vegaImpl,
      harmony: harmonyImpl,
      macos: macosImpl,
    }),
  };
}
