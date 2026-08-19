import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlInstall } from "../../../utils/sim-remote";
import { installDownloadedIosApp } from "./ios-shared";
import type { InstallAppParams, InstallAppResult, InstallAppServices } from "../types";

export const iosRemoteImpl: PlatformImpl<InstallAppServices, InstallAppParams, InstallAppResult> = {
  requires: ["sim-remote"],
  handler: (_services, params, _device, options) =>
    installDownloadedIosApp(
      params,
      options?.signal,
      (udid, appPath, signal) => simctlInstall(udid, appPath, { signal }),
      "ios_remote_install_app_from_url"
    ),
};
