import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
import { macosAppRef } from "../../blueprints/macos-app";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { forgettingUiOrientation } from "../../utils/ios-ui-orientation";
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
  macos: { app: true, catalyst: true },
};

const zodSchema = z.object({
  udid: z.string().min(1).describe("Target device id from `list-devices`."),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe(
      "App identifier (iOS<flag:macos-apps>/Mac app</flag:macos-apps> bundle id, Android package name, Vega interactive component app id from manifest.toml e.g. `com.example.app.main`,<flag:harmonyos> HarmonyOS bundle name from `bm dump -a`,</flag:harmonyos> or Chromium tag)."
    ),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe("Android only: Activity name (default: launcher activity)."),
  launchArgs: z
    .array(z.string())
    .optional()
    .describe(
      'Apple targets only: process launch args, e.g. `["-FeatureFlag", "YES"]`. Relaunches running simulators/phones to apply.'
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
    description: `Open an installed app, or refresh a Chromium target (use \`open-url\` to navigate Chromium).<flag:macos-apps> On a Mac app, starts it in the background if stopped.</flag:macos-apps> Also prepares native-devtools injection on iOS/tvOS and registers the active app on physical iPhones (\`com.apple.springboard\` registers without launching so \`describe\` can read system dialogs).
Use when starting an app; prefer this over tapping home-screen icons.
Returns { launched, bundleId, <flag:macos-apps>kind?, appPath?, args?, </flag:macos-apps>note?, networkCapture? }. Fails if the app is not installed.
Common iOS ids: com.apple.Preferences, com.apple.mobilesafari, com.apple.MobileSMS, com.apple.Maps, com.apple.mobileslideshow, com.apple.MobileAddressBook.
Common Android packages: com.android.settings, com.android.chrome, com.google.android.apps.maps.`,
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
      ios: forgettingUiOrientation(makeIosImpl(registry)),
      iosDevice: iosDeviceImpl,
      iosRemote: forgettingUiOrientation(iosRemoteImpl),
      android: androidImpl,
      chromium: chromiumImpl,
      vega: vegaImpl,
      harmony: harmonyImpl,
      macos: macosImpl,
    }),
  };
}
