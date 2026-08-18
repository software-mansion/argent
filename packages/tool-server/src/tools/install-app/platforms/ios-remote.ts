import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlInstall } from "../../../utils/sim-remote";
import { prepareIosRemoteArtifact } from "../artifact";
import type { InstallAppParams, InstallAppResult, InstallAppServices } from "../types";

export const iosRemoteImpl: PlatformImpl<InstallAppServices, InstallAppParams, InstallAppResult> = {
  requires: ["sim-remote"],
  handler: async (_services, params, _device, options) => {
    const artifact = await prepareIosRemoteArtifact(params, options?.signal);
    try {
      await simctlInstall(params.udid, artifact.installablePath);
      return { installed: true, bundleId: artifact.bundleId };
    } catch (error) {
      throw new FailureError(
        `Failed to install downloaded iOS app bundle on ${params.udid}.`,
        {
          error_code: FAILURE_CODES.IOS_INSTALL_FAILED,
          failure_stage: "ios_remote_install_app_from_url",
          failure_area: "tool_server",
          error_kind: "subprocess",
          failure_command: "unknown",
        },
        { cause: error instanceof Error ? error : new Error(String(error)) }
      );
    } finally {
      await artifact.cleanup();
    }
  },
};
