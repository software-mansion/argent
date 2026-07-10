import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<ReinstallAppServices, ReinstallAppParams, ReinstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params, device) => {
    if (device.kind === "device") {
      const absolute = resolvePath(params.appPath);
      try {
        await execFileAsync("xcrun", [
          "devicectl",
          "device",
          "uninstall",
          "app",
          "--device",
          params.udid,
          params.bundleId,
        ]);
      } catch {
        // App may not be installed — continue to install.
      }
      try {
        await execFileAsync("xcrun", [
          "devicectl",
          "device",
          "install",
          "app",
          "--device",
          params.udid,
          absolute,
        ]);
      } catch (err) {
        throw new FailureError(
          `Failed to install signed iOS app bundle on physical device ${params.udid}.`,
          {
            error_code: FAILURE_CODES.IOS_REINSTALL_INSTALL_FAILED,
            failure_stage: "ios_reinstall_app_devicectl_install",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "xcrun_devicectl"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
      return { reinstalled: true, bundleId: params.bundleId };
    }
    const { udid, bundleId, appPath } = params;
    const absolute = resolvePath(appPath);
    try {
      await execFileAsync("xcrun", ["simctl", "uninstall", udid, bundleId]);
    } catch {
      // App may not be installed — continue to install
    }
    try {
      await execFileAsync("xcrun", ["simctl", "install", udid, absolute]);
    } catch (err) {
      throw new FailureError(
        `Failed to install iOS app bundle on ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_REINSTALL_INSTALL_FAILED,
          failure_stage: "ios_reinstall_app_simctl_install",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { reinstalled: true, bundleId };
  },
};
