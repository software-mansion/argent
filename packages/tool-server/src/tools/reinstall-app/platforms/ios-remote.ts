import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlInstall, simctlUninstall } from "../../../utils/sim-remote";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

/**
 * Remote analogue of the iOS impl: `sim-remote simctl install` uploads the local
 * `.app` to the orchestrator, so the same on-disk path works against a remote sim.
 */
export const iosRemoteImpl: PlatformImpl<
  ReinstallAppServices,
  ReinstallAppParams,
  ReinstallAppResult
> = {
  requires: ["sim-remote"],
  handler: async (_services, params) => {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);
    try {
      await simctlUninstall(udid, bundleId);
    } catch {
      // App may not be installed — continue to install.
    }
    await simctlInstall(udid, absolute);
    return { reinstalled: true, bundleId };
  },
};
