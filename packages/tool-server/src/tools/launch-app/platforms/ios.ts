import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { LaunchAppIosServices, LaunchAppParams, LaunchAppResult } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<LaunchAppIosServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params, device) => {
    // Physical iPhones are driven via CoreDevice — launch through devicectl
    // (the app must already be installed/signed on the device). The
    // native-devtools precheck is simulator-only, so it is skipped here.
    if (device.kind === "device") {
      await execFileAsync("xcrun", [
        "devicectl",
        "device",
        "process",
        "launch",
        "--device",
        params.udid,
        params.bundleId,
      ]);
      return { launched: true, bundleId: params.bundleId };
    }
    const blocked = await precheckNativeDevtools(services.nativeDevtools, params.udid);
    if (blocked) return blocked;
    await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
    return { launched: true, bundleId: params.bundleId };
  },
};
