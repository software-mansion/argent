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

// Bundle id / package name. Head must be letter or underscore so a bundleId
// like `--user` can't masquerade as a flag inside `am force-stop …`.
const BUNDLE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
// Same alphabet as launch-app's ACTIVITY_PATTERN. Leading `.` is allowed so
// shorthand activities like `.MainActivity` work; leading `-` is forbidden
// for flag-injection reasons.
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

// `restart-app` resolves native-devtools through `registry` inside the iOS
// handler (closed over below) rather than via the registry's `services()`
// declaration — the same pattern as `describe` / `screenshot`. A tvOS sim
// classifies as platform "ios" by UDID shape; native-devtools is iOS *and*
// tvOS capable, so the handler resolves it for both. Its ensureEnv picks the
// platform-matched DYLD_INSERT_LIBRARIES slice (the TVOSSIMULATOR bootstrap
// for Apple TV sims), so injection is prepared correctly on tvOS too — not
// skipped. Lazy resolution keeps this aligned with the other iOS tools that
// branch on the resolved device inside their handler.
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
Use when you need a clean in-memory state without a full reinstall. Also refreshes the native-devtools injection before the relaunch (the iOS slice on iOS, the tvOS slice on Apple TV); on tvOS, interaction is focus-driven — use the tv-* tools rather than coordinate taps. Not supported on Chromium, where boot-device only starts an app and never stops one: ask the user to quit it, then relaunch once it has exited — boot-device with electronAppPath for Electron, or ask the user to start the browser again on the same CDP port with --remote-debugging-port — then re-read the chromium-cdp-<port> id from boot-device / list-devices, since a relaunch on a new port is a new id, and list-devices only probes 9222, ARGENT_CHROMIUM_PORTS and the ports boot-device opened — if the user names the port, use chromium-cdp-<that port> directly, since the id carries the port. list-devices cannot confirm the exit. Only when the app is gone: a failure naming the port's pages — no page targets, or only devtools:// ones — means it is still up and only lacks a window, so have the user reopen one instead. A detail naming Chromium CDP discovery: GET says nothing answered that port when it says could not connect, which is consistent with the exit but not proof of it, since the app may be back on another port; when it names a status or a bad body the port answered as something that is not a CDP endpoint — an Electron relaunch takes a fresh port, a browser needs one nothing else holds. A detail naming neither the discovery GET nor the port's pages is the CDP socket failing after discovery answered, so the app was up moments ago: have the user check it first. See the guidance on a debugger-status result.
Returns { restarted, bundleId }. Fails if the app is not installed.`,
    alwaysLoad: true,
    searchHint:
      "terminate relaunch restart reset app bundle id package simulator emulator vega tvos fire tv",
    zodSchema,
    capability,
    // ios-remote declares an eager native-devtools service (its handler shares
    // the local iOS relaunch path, which reads `services.nativeDevtools`). Local
    // iOS resolves native-devtools lazily in its handler so a tvOS udid never
    // spins up the iOS-only injection (see header comment); Android and Vega
    // need no service.
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
      // No chromium branch — falls back to the ChromiumServices default.
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
