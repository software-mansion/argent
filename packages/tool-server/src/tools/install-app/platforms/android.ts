import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { installAndroidPackage, INSTALL_FAILURE_CODES } from "../../../utils/app-install";
import { prepareAndroidRemoteArtifact } from "../artifact";
import type { InstallAppParams, InstallAppResult, InstallAppServices } from "../types";

export const androidImpl: PlatformImpl<InstallAppServices, InstallAppParams, InstallAppResult> = {
  requires: ["adb"],
  handler: async (_services, params, _device, options) => {
    const artifact = await prepareAndroidRemoteArtifact(params, options?.signal);
    try {
      await installAndroidPackage(params.udid, artifact.installablePath, {
        errorCode: INSTALL_FAILURE_CODES.androidRemote,
        failureStage: "android_install_app_from_url",
        signal: options?.signal,
      });
      return { installed: true, bundleId: artifact.bundleId };
    } finally {
      await artifact.cleanup();
    }
  },
};
