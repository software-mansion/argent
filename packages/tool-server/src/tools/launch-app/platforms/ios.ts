import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../../blueprints/native-devtools";
import type { LaunchAppParams, LaunchAppResult, LaunchAppServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<LaunchAppServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["xcrun"],
  services: (params) => ({
    nativeDevtools: `${NATIVE_DEVTOOLS_NAMESPACE}:${params.udid}`,
  }),
  handler: async (services, params) => {
    await services.nativeDevtools.ensureEnvReady();
    await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
    return { launched: true, bundleId: params.bundleId };
  },
};
