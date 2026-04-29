import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { RestartAppParams, RestartAppResult, RestartAppServices } from "./shared";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<RestartAppServices, RestartAppParams, RestartAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params) => {
    const { udid, bundleId } = params;
    await services.nativeDevtools.ensureEnvReady();
    try {
      await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId]);
    } catch {
      // App may not be running — ignore
    }
    await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId]);
    return { restarted: true, bundleId };
  },
};
