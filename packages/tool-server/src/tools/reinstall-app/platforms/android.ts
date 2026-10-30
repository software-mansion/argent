import { resolve as resolvePath } from "node:path";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { adbShell, runAdb, shellQuote } from "../../../utils/adb";
import { assertApk } from "../validate-app";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

// `pm list packages <filter>` matches substrings, exits 0 either way and ends
// lines with `\r\n` before API 24. `-u` adds packages that are hidden or
// uninstalled for one user only, e.g. a system app removed for user 0.
async function isInstalled(udid: string, bundleId: string): Promise<boolean> {
  const listing = await adbShell(udid, `pm list packages -u ${shellQuote(bundleId)}`, {
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
    await assertApk(absolute, bundleId);

    // Match iOS semantics: uninstall first so the reinstall is a clean wipe.
    // adb's verdict is not trusted: it fails alike for "not installed" and
    // "cannot be uninstalled", exits 0 on failure before API 24, and reports
    // Success for an updated system app while only removing the update.
    const uninstall = await runAdb(["-s", udid, "uninstall", bundleId], {
      timeoutMs: 30_000,
    }).then(
      ({ stdout, stderr }) => `${stdout}\n${stderr}`.trim(),
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    );
    const stillInstalled = await isInstalled(udid, bundleId).catch((err: unknown) => {
      throw new FailureError(
        `Could not check whether \`adb uninstall\` removed ${bundleId}, so nothing was installed and the app may be gone. ` +
          `adb uninstall said: ${uninstall}. The check failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          error_kind: "subprocess",
          ...getFailureSignal(err),
          error_code: FAILURE_CODES.ANDROID_REINSTALL_UNINSTALL_FAILED,
          failure_stage: "android_reinstall_check_uninstall",
          failure_area: "tool_server",
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    });
    if (stillInstalled) {
      throw new FailureError(
        `${bundleId} is still on the device after \`adb uninstall\`, so nothing was installed. ` +
          `A system app or an active device admin cannot be uninstalled, and keeps its data. ` +
          `An updated system app only loses its update, and its data too when the update was a newer version. ` +
          `adb uninstall said: ${uninstall}`,
        {
          error_code: FAILURE_CODES.ANDROID_REINSTALL_UNINSTALL_FAILED,
          failure_stage: "android_reinstall_adb_uninstall",
          failure_area: "tool_server",
          error_kind: "subprocess",
        }
      );
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
