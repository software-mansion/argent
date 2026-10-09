import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import { launchHarmonyApp } from "../../../utils/harmony-apps";
import type { LaunchAppParams, LaunchAppResult, LaunchAppHarmonyServices } from "../types";

/**
 * HarmonyOS launches an app by bundle name, but not by bundle name alone:
 * `aa start -b <bundle>` is an *implicit* start and fails without a matching
 * action, so `launchHarmonyApp` looks the entry ability up first. `activity` is
 * Android-only and ignored — the HarmonyOS equivalent is the ability, which is
 * resolved rather than accepted from the caller, because a bundle's launcher
 * entry is a property of the bundle and not something a caller should have to
 * know.
 *
 * No native-devtools injection exists for the platform, so no service is needed.
 */
export const harmonyImpl: PlatformImpl<LaunchAppHarmonyServices, LaunchAppParams, LaunchAppResult> =
  {
    requires: ["hdc"],
    handler: async (_services, params, device) => {
      await launchHarmonyApp(harmonyConnectKey(device.id), params.bundleId);
      return { launched: true, bundleId: params.bundleId };
    },
  };
