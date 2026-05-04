import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { wrapXcrunError } from "../../../utils/format-error";
import type { LaunchAppIosServices, LaunchAppParams, LaunchAppResult } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<LaunchAppIosServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params) => {
    await services.nativeDevtools.ensureEnvReady();
    try {
      await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
    } catch (err) {
      throw wrapXcrunError("launch", err);
    }
    return { launched: true, bundleId: params.bundleId };
  },
};
