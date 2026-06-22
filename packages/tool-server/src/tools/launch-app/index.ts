import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { chromiumCdpRef } from "../../blueprints/chromium-cdp";
import { resolveDevice } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import type { LaunchAppResult, LaunchAppVegaServices } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";
import { chromiumImpl, type LaunchAppChromiumServices } from "./platforms/chromium";
import { vegaImpl } from "./platforms/vega";

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
    .describe("Target device id from `list-devices` (iOS UDID, Android serial, or Chromium id)."),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe(
      "App identifier. iOS: bundle id (e.g. com.apple.MobileSMS). Android: package name from build.gradle `applicationId` (e.g. com.android.settings). Chromium: arbitrary tag; the call is a no-op since the renderer is already running."
    ),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe(
      "Android-only: fully-qualified Activity name (e.g. `.MainActivity` or `com.example/com.example.MainActivity`). If omitted on Android, the app's default launcher activity is used. Ignored on iOS / Chromium."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
  chromium: { app: true },
  vega: { vvd: true },
};

// `launch-app` resolves native-devtools through `registry` inside the iOS
// handler (closed over below) rather than via the registry's `services()`
// declaration — the same pattern as `describe` / `screenshot`. A tvOS sim
// classifies as platform "ios" by UDID shape; native-devtools is iOS *and*
// tvOS capable, so the handler resolves it for both. Its ensureEnv picks the
// platform-matched DYLD_INSERT_LIBRARIES slice (the TVOSSIMULATOR bootstrap
// for Apple TV sims), so injection is prepared correctly on tvOS too — not
// skipped. Lazy resolution keeps this aligned with the other iOS tools that
// branch on the resolved device inside their handler.
export function createLaunchAppTool(registry: Registry): ToolDefinition<Params, LaunchAppResult> {
  return {
    id: "launch-app",
    description: `Open an app by its bundle id (iOS) or package name (Android), or confirm the running renderer (Chromium).
Use when starting any app — prefer this over tapping home-screen / launcher icons. Also prepares the native-devtools injection before the app starts (the iOS slice on iOS, the tvOS slice on Apple TV); on tvOS, interaction is focus-driven — use the tv-* tools rather than coordinate taps.
Returns { launched, bundleId }. Fails if the app is not installed on the target device (iOS / Android).
For Chromium, the app is already running behind a CDP port; this call simply refreshes the cached viewport and acknowledges the bundleId tag. To change the visible route, use \`open-url\`.
On Vega (Fire TV), pass the interactive component app id from manifest.toml (e.g. com.example.app.main) as bundleId.

Common iOS bundle ids: com.apple.MobileSMS, com.apple.mobilesafari, com.apple.Preferences, com.apple.Maps, com.apple.camera, com.apple.Photos, com.apple.mobilemail, com.apple.mobilenotes, com.apple.MobileAddressBook
Common Android packages: com.android.settings, com.android.chrome, com.google.android.apps.maps, com.google.android.gm, com.android.vending, com.google.android.dialer, com.google.android.apps.messaging`,
    alwaysLoad: true,
    searchHint:
      "open start app bundle id package simulator emulator chromium vega launch tvos apple tv fire tv",
    zodSchema,
    capability,
    // Only Chromium declares an eager service (its CDP session). iOS resolves
    // native-devtools lazily in its handler so a tvOS udid never spins up the
    // iOS-only injection (see header comment); Android and Vega need no service.
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "chromium") return { chromium: chromiumCdpRef(device) };
      return {};
    },
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      Params,
      LaunchAppResult,
      LaunchAppChromiumServices,
      LaunchAppVegaServices
    >({
      toolId: "launch-app",
      capability,
      ios: makeIosImpl(registry),
      android: androidImpl,
      chromium: chromiumImpl,
      vega: vegaImpl,
    }),
  };
}
