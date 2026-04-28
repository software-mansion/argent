import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import {
  reinstallAppIos,
  type ReinstallAppResult,
  type ReinstallAppServices,
} from "./platforms/ios";
import { reinstallAppAndroid } from "./platforms/android";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z
    .string()
    .describe(
      "App bundle identifier to uninstall (e.g. com.example.MyApp). Must match the app at appPath."
    ),
  appPath: z
    .string()
    .describe(
      "Absolute or relative path to the .app bundle to install (e.g. ./build/Build/Products/Debug-iphonesimulator/MyApp.app)"
    ),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
};

export const reinstallAppTool: ToolDefinition<Params, ReinstallAppResult> = {
  id: "reinstall-app",
  description: `Register and install an app on the simulator by first uninstalling then installing from a .app bundle path.
Use for a full reinstall after rebuilding or to clear app data. Returns { reinstalled, bundleId }. Fails if the .app path does not exist or the bundle ID does not match.`,
  zodSchema,
  capability,
  services: () => ({}),
  execute: dispatchByPlatform<ReinstallAppServices, Params, ReinstallAppResult>({
    toolId: "reinstall-app",
    capability,
    ios: reinstallAppIos,
    android: reinstallAppAndroid,
  }),
};
