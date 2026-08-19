import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { installLocalIosApp, INSTALL_FAILURE_CODES } from "../../../utils/app-install";
import { installDownloadedIosApp } from "./ios-shared";
import type { InstallAppParams, InstallAppResult, InstallAppServices } from "../types";

export const iosImpl: PlatformImpl<InstallAppServices, InstallAppParams, InstallAppResult> = {
  requires: ["xcrun"],
  handler: (_services, params, _device, options) =>
    installDownloadedIosApp(
      params,
      options?.signal,
      (udid, appPath, signal) =>
        installLocalIosApp(udid, appPath, {
          errorCode: INSTALL_FAILURE_CODES.iosRemote,
          failureStage: "ios_install_app_from_url",
          signal,
        }),
      "ios_install_app_from_url"
    ),
};
