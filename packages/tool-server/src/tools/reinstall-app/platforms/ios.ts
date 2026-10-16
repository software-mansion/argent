import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlTargetForUdid } from "../../../utils/ios-device-sets";
import { SIMCTL_KILL_SIGNAL } from "../../../utils/simctl-config";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<ReinstallAppServices, ReinstallAppParams, ReinstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);
    const { nativeId, prefix } = await simctlTargetForUdid(udid);
    try {
      await execFileAsync("xcrun", [...prefix, "uninstall", nativeId, bundleId], {
        timeout: 30_000,
        killSignal: SIMCTL_KILL_SIGNAL,
      });
    } catch {
      // App may not be installed
    }
    try {
      await execFileAsync("xcrun", [...prefix, "install", nativeId, absolute], {
        timeout: 180_000,
        killSignal: SIMCTL_KILL_SIGNAL,
      });
    } catch (err) {
      throw new FailureError(
        `Failed to install iOS app bundle on ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_REINSTALL_INSTALL_FAILED,
          failure_stage: "ios_reinstall_app_simctl_install",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { reinstalled: true, bundleId };
  },
};
