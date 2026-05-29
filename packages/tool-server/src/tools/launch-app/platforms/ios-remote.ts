import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlLaunch as simRemoteLaunch } from "../../../utils/sim-remote";
import type { LaunchAppIosServices, LaunchAppParams, LaunchAppResult } from "../types";

/**
 * Remote analogue of `iosImpl`. Routes through `sim-remote simctl launch`
 * instead of `xcrun simctl launch`; the native-devtools precheck is shared.
 */
export const iosRemoteImpl: PlatformImpl<LaunchAppIosServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["sim-remote"],
  handler: async (services, params) => {
    const blocked = await precheckNativeDevtools(services.nativeDevtools, params.udid);
    if (blocked) return blocked;
    await simRemoteLaunch(params.udid, params.bundleId);
    return { launched: true, bundleId: params.bundleId };
  },
};
