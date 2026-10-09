import { resolve as resolvePath } from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, runAdb, shellQuote } from "../../../utils/adb";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

// `pm list packages <filter>` matches substrings and exits 0 either way.
async function isInstalled(udid: string, bundleId: string): Promise<boolean> {
  const listing = await adbShell(udid, `pm list packages ${shellQuote(bundleId)}`, {
    timeoutMs: 15_000,
  });
  return listing.split("\n").some((line) => line.trim() === `package:${bundleId}`);
}

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
    // `adb uninstall` fails identically for "not installed" and "cannot be
    // uninstalled", so only an installed package is uninstalled, and must be.
    if (await isInstalled(udid, bundleId)) {
      try {
        await runAdb(["-s", udid, "uninstall", bundleId], { timeoutMs: 30_000 });
      } catch (err) {
        throw new FailureError(
          `Could not uninstall ${bundleId}, so its data was not cleared and nothing was installed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          {
            error_code: FAILURE_CODES.ANDROID_REINSTALL_INSTALL_FAILED,
            failure_stage: "android_reinstall_adb_uninstall",
            failure_area: "tool_server",
            error_kind: "subprocess",
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
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

    // adb takes the package name from the APK, not from bundleId.
    if (!(await isInstalled(udid, bundleId))) {
      throw new FailureError(
        `${appPath} installed, but ${bundleId} is not on the device: the APK's package name is something else, ` +
          `and that package was installed or updated in place with its data kept. Pass the APK's package name as bundleId.`,
        {
          error_code: FAILURE_CODES.ANDROID_REINSTALL_INSTALL_FAILED,
          failure_stage: "android_reinstall_package_mismatch",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    return { reinstalled: true, bundleId };
  },
};
