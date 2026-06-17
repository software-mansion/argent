import { z } from "zod";
import type { Registry, ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import type { RestartAppResult } from "./types";
import { makeIosImpl } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

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
  android: { emulator: true, device: true, unknown: true },
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
    description: `Terminate then relaunch an app by bundle id / package name.
Use when you need a clean in-memory state without a full reinstall. Also refreshes the native-devtools injection before the relaunch (the iOS slice on iOS, the tvOS slice on Apple TV); on tvOS, interaction is focus-driven — use the tv-* tools rather than coordinate taps.
Returns { restarted, bundleId }. Fails if the app is not installed.`,
    alwaysLoad: true,
    searchHint: "terminate relaunch restart reset app bundle id package simulator emulator tvos",
    zodSchema,
    capability,
    // No eager service: the iOS handler resolves native-devtools lazily so a
    // tvOS udid never spins up the iOS-only injection (see header comment).
    services: () => ({}),
    execute: dispatchByPlatform<
      Record<string, unknown>,
      Record<string, unknown>,
      Params,
      RestartAppResult
    >({
      toolId: "restart-app",
      capability,
      ios: makeIosImpl(registry),
      android: androidImpl,
    }),
  };
}
