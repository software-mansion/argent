import { NotImplementedOnPlatformError } from "../../../utils/capability";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "./ios";

export async function reinstallAppAndroid(
  _services: ReinstallAppServices,
  _params: ReinstallAppParams
): Promise<ReinstallAppResult> {
  throw new NotImplementedOnPlatformError({
    toolId: "reinstall-app",
    platform: "android",
    hint:
      "Use `adb -s <serial> install -r [-d allowDowngrade] [-g grantPermissions] " +
      "<path/to/app.apk>`. The `appPath` param should accept an .apk file when " +
      "the device is Android.",
  });
}
