import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlLaunch, simctlTerminate } from "../../../utils/sim-remote";
import type { RestartAppIosServices, RestartAppParams, RestartAppResult } from "../types";

export const iosRemoteImpl: PlatformImpl<
  RestartAppIosServices,
  RestartAppParams,
  RestartAppResult
> = {
  requires: ["sim-remote"],
  handler: async (services, params) => {
    const { udid, bundleId } = params;
    const blocked = await precheckNativeDevtools(services.nativeDevtools, udid);
    if (blocked) return blocked;
    try {
      await simctlTerminate(udid, bundleId);
    } catch {
      // App may not be running — ignore.
    }
    await simctlLaunch(udid, bundleId);
    return { restarted: true, bundleId };
  },
};
