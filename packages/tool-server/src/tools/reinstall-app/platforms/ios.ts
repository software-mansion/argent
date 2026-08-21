import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { deviceSetForUdid, simctlPrefix } from "../../../utils/ios-device-sets";
import { assertInstallableArtifact, assertNotInsideDeviceContainer } from "../validate-artifact";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<ReinstallAppServices, ReinstallAppParams, ReinstallAppResult> = {
  requires: ["xcrun"],
  handler: async (_services, params) => {
    const { udid, bundleId, appPath } = params;
    // Both checks run before the uninstall — see validate-artifact.ts. The
    // container check is the one that catches installing from the simulator's
    // own container, where the uninstall deletes the source bundle.
    const absolute = await assertInstallableArtifact(appPath, "ios");
    await assertNotInsideDeviceContainer(absolute, udid);
    const prefix = simctlPrefix(await deviceSetForUdid(udid));
    try {
      await execFileAsync("xcrun", [...prefix, "uninstall", udid, bundleId]);
    } catch {
      // App may not be installed — continue to install
    }
    try {
      await execFileAsync("xcrun", [...prefix, "install", udid, absolute]);
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
