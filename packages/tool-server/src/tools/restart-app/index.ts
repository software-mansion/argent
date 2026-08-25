import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import type { RestartAppResult, RestartAppVegaServices, RestartAppIosServices } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { iosRemoteImpl } from "./platforms/ios-remote";
import { androidImpl } from "./platforms/android";
import { vegaImpl } from "./platforms/vega";

// Head must be a letter or `_` so a bundleId like `--user` can't masquerade as
// a flag inside `am force-stop …`.
const BUNDLE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
// Same alphabet as launch-app's ACTIVITY_PATTERN: leading `.` for shorthand
// activities like `.MainActivity`, no leading `-` (flag injection).
const ACTIVITY_PATTERN = /^[A-Za-z_.][A-Za-z0-9._/-]*$/;

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .min(1)
    .regex(BUNDLE_ID_PATTERN, "bundleId may only contain letters, digits, '.', '_' and '-'")
    .describe("App identifier. iOS: bundle id. Android: package name."),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe(
      "Android-only: relaunch a non-launcher Activity (e.g. `.SettingsActivity` or `com.example/com.example.SettingsActivity`). If omitted, the app's default launcher activity is used. Ignored on iOS."
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  appleRemote: { simulator: true },
  android: { emulator: true, device: true, unknown: true },
  vega: { vvd: true },
};

// Local iOS resolves native-devtools inside the handler rather than via
// `services()`. A tvOS sim classifies as platform "ios", and native-devtools
// covers it too (ensureEnv injects the TVOSSIMULATOR dylib slice).
export function createRestartAppTool(registry: Registry): ToolDefinition<Params, RestartAppResult> {
  return {
    id: "restart-app",
    interaction: {
      startedMsg: ({ params }) => `Restarting ${params.bundleId}`,
      completedMsg: ({ params }) => `Restarted ${params.bundleId}`,
      failedMsg: ({ params, failureSignal }) =>
        `Failed to restart ${params.bundleId}: ${failureSignal.error_code}`,
    },
    description: `Terminate then relaunch an app by bundle id / package name.
Use when you need a clean in-memory state without a full reinstall. Also refreshes the native-devtools injection before the relaunch (the iOS slice on iOS, the tvOS slice on Apple TV); on tvOS, interaction is focus-driven — use the tv-* tools rather than coordinate taps.
Returns { restarted, bundleId }. Fails if the app is not installed.`,
    alwaysLoad: true,
    searchHint:
      "terminate relaunch restart reset app bundle id package simulator emulator vega tvos fire tv",
    zodSchema,
    capability,
    // Only ios-remote's handler reads `services.nativeDevtools`, so only it
    // needs an eager declaration.
    services: (params): Record<string, ServiceRef> => {
      const device = resolveDevice(params.udid);
      if (device.platform === "ios-remote") return { nativeDevtools: nativeDevtoolsRef(device) };
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
      RestartAppIosServices
    >({
      toolId: "restart-app",
      capability,
      ios: makeIosImpl(registry),
      iosRemote: iosRemoteImpl,
      android: androidImpl,
      vega: vegaImpl,
    }),
  };
}
