import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { runAdb } from "../../../utils/adb";
import { installAndroidPackage, INSTALL_FAILURE_CODES } from "../../../utils/app-install";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

export const androidImpl: PlatformImpl<
  ReinstallAppServices,
  ReinstallAppParams,
  ReinstallAppResult
> = {
  requires: ["adb"],
  handler: async (_services, params, _device, options) => {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);

    // Match iOS semantics: uninstall first so the reinstall is a clean wipe.
    // `pm uninstall` is non-fatal if the package isn't installed (returns
    // "Failure [DELETE_FAILED_INTERNAL_ERROR]" or similar); swallow that case.
    try {
      await runAdb(["-s", udid, "uninstall", bundleId], {
        timeoutMs: 30_000,
        signal: options?.signal,
      });
    } catch {
      // App may not be installed — continue to install
    }

    // -r - Allow app overwriting (no-op after uninstall, but harmless)
    // -d - Allow installations with lower versions
    // -g - Prevent permissions popup
    await installAndroidPackage(udid, absolute, {
      errorCode: INSTALL_FAILURE_CODES.androidReinstall,
      failureStage: "android_reinstall_adb_install",
      signal: options?.signal,
    });
    return { reinstalled: true, bundleId };
  },
};
