import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { wrapXcrunError } from "../../../utils/format-error";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<ReinstallAppServices, ReinstallAppParams, ReinstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);
    try {
      await execFileAsync("xcrun", ["simctl", "uninstall", udid, bundleId]);
    } catch {
      // App may not be installed — continue to install
    }
    try {
      await execFileAsync("xcrun", ["simctl", "install", udid, absolute]);
    } catch (err) {
      throw wrapXcrunError("install", err);
    }
    return { reinstalled: true, bundleId };
  },
};
