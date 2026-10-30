import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import { launchHarmonyApp } from "../../../utils/harmony-apps";
import type { LaunchAppParams, LaunchAppResult, LaunchAppHarmonyServices } from "../types";

/** The entry ability is resolved from the bundle; `activity` is ignored. */
export const harmonyImpl: PlatformImpl<LaunchAppHarmonyServices, LaunchAppParams, LaunchAppResult> =
  {
    requires: ["hdc"],
    handler: async (_services, params, device) => {
      await launchHarmonyApp(harmonyConnectKey(device.id), params.bundleId);
      return { launched: true, bundleId: params.bundleId };
    },
  };
