import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { RestartAppIosServices, RestartAppParams, RestartAppResult } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<RestartAppIosServices, RestartAppParams, RestartAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params, device) => {
    const { udid, bundleId } = params;
    if (device.kind === "device") {
      throw new Error("restart-app is not supported on physical iOS devices.");
    }
    const blocked = await precheckNativeDevtools(services.nativeDevtools, udid);
    if (blocked) return blocked;
    try {
      await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId]);
    } catch {
      // App may not be running — ignore
    }
    await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId]);
    return { restarted: true, bundleId };
  },
};
