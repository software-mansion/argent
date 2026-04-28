import { z } from "zod";
import type { ServiceRef, ToolCapability, ToolDefinition } from "@argent/registry";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { classifyDevice } from "../../utils/device-info";
import { iosImpl, type RestartAppResult, type RestartAppServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

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
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
};

export const restartAppTool: ToolDefinition<Params, RestartAppResult> = {
  id: "restart-app",
  description: `Terminate then relaunch an app by bundle id / package name.
Use when you need a clean in-memory state without a full reinstall. Also refreshes the native-devtools injection on iOS before the relaunch.
Returns { restarted, bundleId }. Fails if the app is not installed.`,
  alwaysLoad: true,
  searchHint: "terminate relaunch restart reset app bundle id package simulator emulator",
  zodSchema,
  capability,
  // Only iOS needs the native-devtools service for relaunch injection.
  services: (params): Record<string, ServiceRef> =>
    classifyDevice(params.udid) === "ios"
      ? { nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}` }
      : {},
  execute: dispatchByPlatform<RestartAppServices, Params, RestartAppResult>({
    toolId: "restart-app",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
