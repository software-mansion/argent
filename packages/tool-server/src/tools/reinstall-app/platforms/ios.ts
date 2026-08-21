import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { deviceSetForUdid, simctlPrefix } from "../../../utils/ios-device-sets";
import { installLocalIosApp, INSTALL_FAILURE_CODES } from "../../../utils/app-install";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<ReinstallAppServices, ReinstallAppParams, ReinstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params, _device, options) => {
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);
    const prefix = simctlPrefix(await deviceSetForUdid(udid));
    try {
      await execFileAsync("xcrun", [...prefix, "uninstall", udid, bundleId], {
        killSignal: "SIGKILL",
        signal: options?.signal,
      });
    } catch {
      // App may not be installed — continue to install
    }
    await installLocalIosApp(udid, absolute, {
      errorCode: INSTALL_FAILURE_CODES.iosReinstall,
      failureStage: "ios_reinstall_app_simctl_install",
      signal: options?.signal,
      prefix,
    });
    return { reinstalled: true, bundleId };
  },
};
