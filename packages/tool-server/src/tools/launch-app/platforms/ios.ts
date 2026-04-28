import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeDevtoolsApi } from "../../../blueprints/native-devtools";

const execFileAsync = promisify(execFile);

export interface LaunchAppParams {
  udid: string;
  bundleId: string;
}

export interface LaunchAppResult {
  launched: boolean;
  bundleId: string;
}

export interface LaunchAppServices {
  nativeDevtools: NativeDevtoolsApi;
}

export async function launchAppIos(
  services: LaunchAppServices,
  params: LaunchAppParams
): Promise<LaunchAppResult> {
  await services.nativeDevtools.ensureEnvReady();
  await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
  return { launched: true, bundleId: params.bundleId };
}
