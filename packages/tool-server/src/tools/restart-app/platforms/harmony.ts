import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import { launchHarmonyApp, terminateHarmonyApp } from "../../../utils/harmony-apps";
import type { RestartAppParams, RestartAppResult, RestartAppHarmonyServices } from "../types";

/** `aa force-stop` then `aa start`; a failed stop fails the restart. */
export const harmonyImpl: PlatformImpl<
  RestartAppHarmonyServices,
  RestartAppParams,
  RestartAppResult
> = {
  requires: ["hdc"],
  handler: async (_services, params, device) => {
    const connectKey = harmonyConnectKey(device.id);
    await terminateHarmonyApp(connectKey, params.bundleId);
    await launchHarmonyApp(connectKey, params.bundleId);
    return { restarted: true, bundleId: params.bundleId };
  },
};
