import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { launchAppIos, type LaunchAppResult, type LaunchAppServices } from "./platforms/ios";
import { launchAppAndroid } from "./platforms/android";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("App bundle identifier (e.g. com.apple.MobileSMS)"),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
};

export const launchAppTool: ToolDefinition<Params, LaunchAppResult> = {
  id: "launch-app",
  description: `Open an app on the simulator by bundle ID.
Use when starting any app — prefer this over tapping home-screen icons. Also prepares native-devtools launch injection before the app starts. Returns { launched, bundleId }. Fails if the bundle ID is not installed on the simulator.

Common bundle IDs:
- Messages:  com.apple.MobileSMS
- Safari:    com.apple.mobilesafari
- Settings:  com.apple.Preferences
- Maps:      com.apple.Maps
- Camera:    com.apple.camera
- Photos:    com.apple.Photos
- Mail:      com.apple.mobilemail
- Notes:     com.apple.mobilenotes
- Clock:     com.apple.mobiletimer
- Calendar:  com.apple.mobilecal
- Contacts:  com.apple.MobileAddressBook`,
  alwaysLoad: true,
  searchHint: "open start app bundle id simulator launch",
  zodSchema,
  capability,
  services: (params) => ({
    nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`,
  }),
  execute: dispatchByPlatform<LaunchAppServices, Params, LaunchAppResult>({
    toolId: "launch-app",
    capability,
    ios: launchAppIos,
    android: launchAppAndroid,
  }),
};
