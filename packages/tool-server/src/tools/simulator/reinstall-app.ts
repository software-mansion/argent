import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";

const execFileAsync = promisify(execFile);

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

export const reinstallAppTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { reinstalled: boolean; bundleId: string }
> = {
  id: "reinstall-app",
  description: `Update (reinstall) an app on the simulator: uninstall by bundleId, then install from appPath.
Use when you need a clean install after rebuilding, e.g. appPath like "./build/Products/Debug-iphonesimulator/MyApp.app".
Accepts: udid, bundleId, appPath. Returns the reinstalled bundle ID. Fails if the appPath does not exist or is not a valid .app bundle.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const { udid, bundleId, appPath } = params;
    try {
      await execFileAsync("xcrun", ["simctl", "uninstall", udid, bundleId]);
    } catch {
      // App may not be installed — continue to install
    }
    await execFileAsync("xcrun", ["simctl", "install", udid, appPath]);
    return { reinstalled: true, bundleId };
  },
};
