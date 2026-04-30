import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";

const execFileAsync = promisify(execFile);

export interface ReinstallAppParams {
  udid: string;
  bundleId: string;
  appPath: string;
}

export interface ReinstallAppResult {
  reinstalled: boolean;
  bundleId: string;
}

export type ReinstallAppServices = Record<string, never>;

export const iosImpl: PlatformImpl<ReinstallAppServices, ReinstallAppParams, ReinstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    const { udid, bundleId, appPath } = params;
    try {
      await execFileAsync("xcrun", ["simctl", "uninstall", udid, bundleId]);
    } catch {
      // App may not be installed — continue to install
    }
    await execFileAsync("xcrun", ["simctl", "install", udid, appPath]);
    return { reinstalled: true, bundleId };
  },
};
