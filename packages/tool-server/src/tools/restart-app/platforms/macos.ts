import type { MacosAppApi } from "../../../blueprints/macos-app";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { assertLaunchTargetsDevice } from "../../../utils/macos-apps";
import type { RestartAppParams, RestartAppResult } from "../types";

/**
 * Quits the app and starts it again in the background, from the same `.app`
 * with `launchArgs`, else with the arguments of its last start, also when a
 * copy runs without the library (the `note` says so). A refused restart leaves
 * the app running.
 */
export const macosImpl: PlatformImpl<
  { macosApp: MacosAppApi },
  RestartAppParams,
  RestartAppResult
> = {
  handler: async (services, params, device) => {
    const bundleId = assertLaunchTargetsDevice(params.bundleId, device);
    const { args, note } = await services.macosApp.launch({
      takeOver: true,
      args: params.launchArgs,
    });
    return { restarted: true, bundleId, args, ...(note ? { note } : {}) };
  },
};
