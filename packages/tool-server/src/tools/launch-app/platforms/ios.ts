import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeDevtoolsApi } from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";

const execFileAsync = promisify(execFile);

export interface LaunchAppParams {
  udid: string;
  bundleId: string;
  /** Android-only: ignored on iOS. */
  activity?: string;
}

export interface LaunchAppResult {
  launched: boolean;
  bundleId: string;
}

export interface LaunchAppServices {
  nativeDevtools: NativeDevtoolsApi;
}

export const iosImpl: PlatformImpl<LaunchAppServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params) => {
    await services.nativeDevtools.ensureEnvReady();
    await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
    return { launched: true, bundleId: params.bundleId };
  },
};
