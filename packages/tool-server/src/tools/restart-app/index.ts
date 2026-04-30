import { z } from "zod";
import type { ToolCapability, ToolDefinition } from "@argent/registry";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../blueprints/native-devtools";
import { dispatchByPlatform } from "../../utils/cross-platform-tool";
import { iosImpl, type RestartAppResult, type RestartAppServices } from "./platforms/ios";
import { androidImpl } from "./platforms/android";

const zodSchema = z.object({
  udid: z.string().describe("Simulator UDID"),
  bundleId: z.string().describe("App bundle identifier (e.g. com.apple.MobileSMS)"),
});

type Params = z.infer<typeof zodSchema>;

const capability: ToolCapability = {
  apple: { simulator: true, device: true },
};

export const restartAppTool: ToolDefinition<Params, RestartAppResult> = {
  id: "restart-app",
  description: `Restart an app on the simulator by terminating then relaunching it by bundle ID.
Use when you need a clean in-memory state without a full reinstall. Also refreshes native-devtools launch injection before the relaunch. Returns { restarted, bundleId }. Fails if the bundle ID is not installed on the simulator.`,
  alwaysLoad: true,
  searchHint: "terminate relaunch restart reset app bundle id simulator",
  zodSchema,
  capability,
  services: (params) => ({
    nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`,
  }),
  execute: dispatchByPlatform<RestartAppServices, Params, RestartAppResult>({
    toolId: "restart-app",
    capability,
    ios: iosImpl,
    android: androidImpl,
  }),
};
