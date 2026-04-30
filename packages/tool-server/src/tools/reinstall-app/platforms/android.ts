import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "./ios";

export const androidImpl: PlatformImpl<
  ReinstallAppServices,
  ReinstallAppParams,
  ReinstallAppResult
> = {
  requires: ["adb"],
  handler: async () => {
    throw new NotImplementedOnPlatformError({
      toolId: "reinstall-app",
      platform: "android",
      hint:
        "Use `adb -s <serial> install -r [-d allowDowngrade] [-g grantPermissions] " +
        "<path/to/app.apk>`. The `appPath` param should accept an .apk file when " +
        "the device is Android.",
    });
  },
};
