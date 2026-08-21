import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlInstall, simctlUninstall } from "../../../utils/sim-remote";
import { assertInstallableArtifact } from "../validate-artifact";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

/**
 * Remote analogue of the iOS impl. `sim-remote simctl install` uploads the
 * local `.app` to the orchestrator over QUIC, so this works against a remote
 * sim with no extra staging — the developer points at the same on-disk path
 * they'd use locally.
 */
export const iosRemoteImpl: PlatformImpl<
  ReinstallAppServices,
  ReinstallAppParams,
  ReinstallAppResult
> = {
  requires: ["sim-remote"],
  handler: async (_services, params) => {
    const { udid, bundleId, appPath } = params;
    // No container check here: the simulator lives on the remote host, so the
    // local CoreSimulator layout says nothing about it.
    const absolute = await assertInstallableArtifact(appPath, "ios");
    try {
      await simctlUninstall(udid, bundleId);
    } catch {
      // App may not be installed — continue to install.
    }
    await simctlInstall(udid, absolute);
    return { reinstalled: true, bundleId };
  },
};
