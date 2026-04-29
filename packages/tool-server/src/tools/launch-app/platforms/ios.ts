import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { LaunchAppParams, LaunchAppResult, LaunchAppServices } from "./shared";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<LaunchAppServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params) => {
    await services.nativeDevtools.ensureEnvReady();
    await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
    return { launched: true, bundleId: params.bundleId };
  },
};
