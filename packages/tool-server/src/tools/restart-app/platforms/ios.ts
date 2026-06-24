import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgs } from "../../../utils/simctl";
import type { RestartAppIosServices, RestartAppParams, RestartAppResult } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<RestartAppIosServices, RestartAppParams, RestartAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params) => {
    const { udid, bundleId } = params;
    const blocked = await precheckNativeDevtools(services.nativeDevtools, udid);
    if (blocked) return blocked;
    try {
      await execFileAsync("xcrun", simctlArgs(["terminate", udid, bundleId]));
    } catch {
      // App may not be running — ignore
    }
    await execFileAsync("xcrun", simctlArgs(["launch", udid, bundleId]));
    return { restarted: true, bundleId };
  },
};
