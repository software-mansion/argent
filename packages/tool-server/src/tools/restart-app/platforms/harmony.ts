import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { harmonyConnectKey } from "../../../utils/device-info";
import { launchHarmonyApp, terminateHarmonyApp } from "../../../utils/harmony-apps";
import type { RestartAppParams, RestartAppResult, RestartAppHarmonyServices } from "../types";

/**
 * Restart on HarmonyOS is `aa force-stop` then a resolved `aa start`.
 *
 * Neither is tolerated: a stop that fails is a stop that did not happen, and the
 * launch that follows would then no-op on the still-running app and report
 * `restarted: true` for its old process. Stopping an app that was never launched
 * needs no tolerance — `aa force-stop` succeeds on it (see
 * `terminateHarmonyApp`), so a restart of a cold app is still a start.
 * `activity` is Android-only and ignored — the HarmonyOS entry ability is
 * resolved from the bundle.
 */
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
