import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgs } from "../../../utils/simctl";
import type { LaunchAppIosServices, LaunchAppParams, LaunchAppResult } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<LaunchAppIosServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params) => {
    const blocked = await precheckNativeDevtools(services.nativeDevtools, params.udid);
    if (blocked) return blocked;
    await execFileAsync("xcrun", simctlArgs(["launch", params.udid, params.bundleId]));
    return { launched: true, bundleId: params.bundleId };
  },
};
