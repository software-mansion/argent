import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import {
  clearCurrentIosDeviceApp,
  isSessionOnlySystemUi,
} from "../../../utils/ios-device/app-session";
import { ensureDeviceReady, installApp, uninstallApp } from "../../../utils/ios-device/devicectl";
import { assertInstallableArtifact } from "../validate-artifact";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

/**
 * Reinstall an app on a physical iOS device with devicectl.
 * The .app must be a device build signed for this device.
 */
export const iosDeviceImpl: PlatformImpl<
  ReinstallAppServices,
  ReinstallAppParams,
  ReinstallAppResult
> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    // Reject system UI before contacting the device. It is not an installed bundle.
    if (isSessionOnlySystemUi(params.bundleId)) {
      throw new InvalidToolInputError(
        `${params.bundleId} is system UI: it is always running and cannot be reinstalled. ` +
          "Use launch-app to put it under automation."
      );
    }

    // Validate BEFORE the uninstall, which is irreversible and takes the app's data with it.
    const absolute = await assertInstallableArtifact(params.appPath, "ios-device");

    await ensureDeviceReady(params.udid);
    await uninstallApp(params.udid, params.bundleId);

    // Uninstall killed the process. Clear the session even if install fails.
    clearCurrentIosDeviceApp(params.udid, params.bundleId);
    await installApp(params.udid, absolute);

    return {
      reinstalled: true,
      bundleId: params.bundleId,
    };
  },
};
