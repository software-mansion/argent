import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { classifyDevice } from "../../utils/platform-detect";
import { ensureDep } from "../../utils/check-deps";
import { runAdb } from "../../utils/adb";

const execFileAsync = promisify(execFile);

const zodSchema = z.object({
  udid: z
    .string()
    .min(1)
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
  bundleId: z
    .string()
    .describe(
      "App identifier that matches the bundle at `appPath`. iOS: bundle id (used to uninstall first so data is cleared). Android: package name (used only in the return payload — the install identifies the app from the APK)."
    ),
  appPath: z
    .string()
    .describe(
      "Path to the app bundle. iOS: `.app` directory (e.g. ./build/.../MyApp.app). Android: `.apk` file (e.g. android/app/build/outputs/apk/debug/app-debug.apk). Relative paths are resolved from the current working directory."
    ),
  grantPermissions: z
    .boolean()
    .optional()
    .describe("Android-only: auto-grant all runtime permissions on install. Ignored on iOS."),
  allowDowngrade: z
    .boolean()
    .optional()
    .describe("Android-only: allow installing a lower versionCode. Ignored on iOS."),
});

export const reinstallAppTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  { reinstalled: boolean; bundleId: string }
> = {
  id: "reinstall-app",
  description: `Install or reinstall an app on the device.
Use for a full reinstall after rebuilding, or to clear app data (iOS clears data on every reinstall; Android preserves data unless the caller wipes it).
Returns { reinstalled, bundleId }. Fails if the app path does not exist or the package does not match the platform (.app for iOS, .apk for Android).`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params) {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);
    if ((await classifyDevice(udid)) === "android") {
      await ensureDep("adb");
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
    await ensureDep("xcrun");
    try {
      await execFileAsync("xcrun", ["simctl", "uninstall", udid, bundleId]);
    } catch {
      // App may not be installed — continue to install
    }
    await execFileAsync("xcrun", ["simctl", "install", udid, absolute]);
    return { reinstalled: true, bundleId };
  },
};
