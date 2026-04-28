import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeDevtoolsApi } from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";

const execFileAsync = promisify(execFile);

export interface RestartAppParams {
  udid: string;
  bundleId: string;
}

export interface RestartAppResult {
  restarted: boolean;
  bundleId: string;
}

export interface RestartAppServices {
  nativeDevtools: NativeDevtoolsApi;
}

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
