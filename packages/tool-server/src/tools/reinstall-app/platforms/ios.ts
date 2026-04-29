import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type {
  ReinstallAppParams,
  ReinstallAppResult,
  ReinstallAppServices,
} from "../types";

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
    await execFileAsync("xcrun", ["simctl", "install", udid, absolute]);
    return { reinstalled: true, bundleId };
  },
};
