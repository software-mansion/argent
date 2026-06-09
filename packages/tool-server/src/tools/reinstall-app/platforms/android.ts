import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { runAdb } from "../../../utils/adb";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

export const androidImpl: PlatformImpl<
  ReinstallAppServices,
  ReinstallAppParams,
  ReinstallAppResult
> = {
  requires: ["adb"],
  handler: async (_services, params) => {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);

    // Match iOS semantics: uninstall first so the reinstall is a clean wipe.
    // `pm uninstall` is non-fatal if the package isn't installed (returns
    // "Failure [DELETE_FAILED_INTERNAL_ERROR]" or similar); swallow that case.
    try {
      await runAdb(["-s", udid, "uninstall", bundleId], { timeoutMs: 30_000 });
    } catch {
      // App may not be installed — continue to install
    }

    // -r - Allow app overwriting (no-op after uninstall, but harmless)
    // -d - Allow installations with lower versions
    // -g - Prevent permissions popup
    const args = ["-s", udid, "install", "-r", "-d", "-g", absolute];
    const { stdout, stderr } = await runAdb(args, { timeoutMs: 180_000 });
    const output = `${stdout}\n${stderr}`;
    if (!/Success/i.test(output)) {
      throw new Error(`adb install failed: ${output.trim()}`);
    }
    return { reinstalled: true, bundleId };
  },
};
