import { z } from "zod";
import type { Registry, ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { macosAppRef } from "../../blueprints/macos-app";
import { nativeDevtoolsRef } from "../../blueprints/native-devtools";
import { resolveDevice } from "../../utils/device-info";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { forgettingUiOrientation } from "../../utils/ios-ui-orientation";
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
import { makeChromiumImpl } from "./platforms/chromium";
import { macosImpl } from "./platforms/macos";

// Same alphabet as launch-app's ACTIVITY_PATTERN: leading `.` for shorthand
// activities like `.MainActivity`, no leading `-` (flag injection).
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
    .min(1)
    .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
    .describe(
      "App identifier (iOS<flag:macos-apps>/Mac app</flag:macos-apps> bundle id, Android package name, Vega interactive component app id<flag:harmonyos>, HarmonyOS bundle name</flag:harmonyos>; on Chromium any tag, echoed back)."
    ),
  activity: z
    .string()
    .regex(ACTIVITY_PATTERN, "activity may only contain letters, digits, '.', '_', '-' and '/'")
    .optional()
    .describe("Android only: Activity name to relaunch (default: launcher activity)."),
  launchArgs: z
    .array(z.string())
    .optional()
    .describe('Apple targets only: process launch args, e.g. `["-FeatureFlag", "YES"]`.'),
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
    description: `Terminate and relaunch an app (also refreshes native-devtools injection on iOS/tvOS).<flag:macos-apps> On a Mac app, quits and restarts the same .app in the background.</flag:macos-apps> On Chromium, relaunches only an Electron app this tool-server session booted (\`boot-device\` or an e2e run), on the same port and device id.
Use when you need a clean in-memory app state without reinstalling. Returns { restarted, bundleId, <flag:macos-apps>kind?, </flag:macos-apps>appPath?, args?, <flag:macos-apps>note?, </flag:macos-apps>networkCapture? } (on Chromium, \`appPath\` and \`args\` are the boot's path and \`electronArgs\`). Fails if the app is not installed or fails to terminate.`,
    zodSchema,
    alwaysLoad: true,
    searchHint:
      "terminate relaunch restart reset app bundle id package simulator emulator vega tvos fire tv chromium electron<flag:harmonyos> harmony harmonyos</flag:harmonyos>",
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
      Record<string, unknown>,
      RestartAppVegaServices,
      RestartAppIosServices,
      RestartAppHarmonyServices
    >({
      toolId: "restart-app",
      capability,
      ios: forgettingUiOrientation(makeIosImpl(registry)),
      iosDevice: iosDeviceImpl,
      iosRemote: forgettingUiOrientation(iosRemoteImpl),
      android: androidImpl,
      chromium: makeChromiumImpl(registry),
      vega: vegaImpl,
      harmony: harmonyImpl,
      macos: macosImpl,
    }),
  };
}
