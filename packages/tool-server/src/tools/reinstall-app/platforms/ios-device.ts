import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { InvalidToolInputError } from "../../../utils/capability";
import {
  clearCurrentIosDeviceApp,
  isSessionOnlySystemUi,
} from "../../../utils/ios-device/app-session";
import { ensureDeviceReady, installApp, uninstallApp } from "../../../utils/ios-device/devicectl";
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

    await ensureDeviceReady(params.udid);
    await uninstallApp(params.udid, params.bundleId);

    // Uninstall killed the process. Clear the session even if install fails.
    clearCurrentIosDeviceApp(params.udid, params.bundleId);
    await installApp(params.udid, resolvePath(params.appPath));

    return {
      reinstalled: true,
      bundleId: params.bundleId,
    };
  },
};
