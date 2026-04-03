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
  description: `Register and install an app on the simulator by first uninstalling then installing from a .app bundle path.
Use for a full reinstall after rebuilding or to clear app data. Returns { reinstalled, bundleId }. Fails if the .app path does not exist or the bundle ID does not match.`,
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
