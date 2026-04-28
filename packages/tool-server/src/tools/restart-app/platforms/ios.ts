import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NativeDevtoolsApi } from "../../../blueprints/native-devtools";

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

export async function restartAppIos(
  services: RestartAppServices,
  params: RestartAppParams
): Promise<RestartAppResult> {
  const { udid, bundleId } = params;
  await services.nativeDevtools.ensureEnvReady();
  try {
    await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId]);
  } catch {
    // App may not be running — ignore
  }
  await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId]);
  return { restarted: true, bundleId };
}
