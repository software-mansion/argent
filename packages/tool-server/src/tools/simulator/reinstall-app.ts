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
  description: `Run a full app reinstall on the simulator: uninstall the existing version then install fresh from a .app bundle path.
Use when the app binary has been rebuilt (e.g. after a native code change), or to clear app data and the container directory for a clean slate.

Parameters: udid — simulator UDID; bundleId — the app's bundle ID (e.g. com.example.MyApp); appPath — absolute path to the .app bundle (e.g. /path/to/MyApp.app).
Example: { "udid": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890", "bundleId": "com.example.MyApp", "appPath": "/path/to/Debug-iphonesimulator/MyApp.app" }
Returns { reinstalled: true, bundleId }. If the app was not installed the uninstall step is silently skipped. Fails if appPath does not exist or the simulator is not booted.`,
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
