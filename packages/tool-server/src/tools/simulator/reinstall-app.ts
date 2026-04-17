import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { detectPlatform } from "../../utils/platform-detect";
import { runAdb } from "../../utils/adb";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z
    .string()
    .describe(
      "Device id. For iOS: simulator UDID (UUID shape). For Android: adb serial (e.g. `emulator-5554`)."
    ),
  bundleId: z
    .string()
    .describe(
      "iOS: bundle id to uninstall before installing. Android: package name (used only for clarity in the return payload; `adb install -r` identifies the app from the APK itself). Must match the app at appPath."
    ),
  appPath: z
    .string()
    .describe(
      "Absolute path to the app bundle. iOS: `.app` directory (e.g. ./build/Build/Products/Debug-iphonesimulator/MyApp.app). Android: `.apk` file (e.g. android/app/build/outputs/apk/debug/app-debug.apk)."
    ),
  grantPermissions: z
    .boolean()
    .optional()
    .describe(
      "Android-only: auto-grant all runtime permissions on install (`adb install -g`). Ignored on iOS."
    ),
  allowDowngrade: z
    .boolean()
    .optional()
    .describe(
      "Android-only: allow installing a lower versionCode (`adb install -d`). Ignored on iOS."
    ),
});

export const reinstallAppTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { reinstalled: boolean; bundleId: string }
> = {
  id: "reinstall-app",
  description: `Install or reinstall an app on the device.
iOS: uninstalls the existing bundleId (if present), then \`xcrun simctl install\` from a .app path. Clears app data.
Android: \`adb install -r\` from an APK path. \`-r\` preserves data across installs; pass \`grantPermissions: true\` for \`-g\`.
Returns { reinstalled, bundleId }. Fails if the path does not exist or the package is malformed.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);
    if (detectPlatform(udid) === "android") {
      const args = ["-s", udid, "install", "-r"];
      if (params.allowDowngrade) args.push("-d");
      if (params.grantPermissions) args.push("-g");
      args.push(absolute);
      const { stdout, stderr } = await runAdb(args, { timeoutMs: 180_000 });
      const output = `${stdout}\n${stderr}`;
      if (!/Success/i.test(output)) {
        throw new Error(`adb install failed: ${output.trim()}`);
      }
      return { reinstalled: true, bundleId };
    }
    try {
      await execFileAsync("xcrun", ["simctl", "uninstall", udid, bundleId]);
    } catch {
      // App may not be installed — continue to install
    }
    await execFileAsync("xcrun", ["simctl", "install", udid, absolute]);
    return { reinstalled: true, bundleId };
  },
};
