import { resolve as resolvePath } from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
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
    try {
      await runAdb(["-s", udid, "uninstall", bundleId], { timeoutMs: 30_000 });
    } catch {
      // App may not be installed
    }

    // -r - allow overwrite (no-op after the uninstall above)
    // -d - allow version downgrade
    // -g - grant runtime permissions up front, so no permission prompt
    const args = ["-s", udid, "install", "-r", "-d", "-g", absolute];
    const { stdout, stderr } = await runAdb(args, { timeoutMs: 180_000 });
    const output = `${stdout}\n${stderr}`;
    if (!/Success/i.test(output)) {
      throw new FailureError(`adb install failed: ${output.trim()}`, {
        error_code: FAILURE_CODES.ANDROID_REINSTALL_INSTALL_FAILED,
        failure_stage: "android_reinstall_adb_install",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
    }
    return { reinstalled: true, bundleId };
  },
};
