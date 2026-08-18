import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { runAdb } from "../../../utils/adb";
import { prepareAndroidRemoteArtifact } from "../artifact";
import type { InstallAppParams, InstallAppResult, InstallAppServices } from "../types";

export const androidImpl: PlatformImpl<InstallAppServices, InstallAppParams, InstallAppResult> = {
  requires: ["adb"],
  handler: async (_services, params, _device, options) => {
    const artifact = await prepareAndroidRemoteArtifact(params, options?.signal);
    try {
      const { stdout, stderr } = await runAdb(
        ["-s", params.udid, "install", "-r", "-d", "-g", artifact.installablePath],
        { timeoutMs: 180_000 }
      );
      const output = `${stdout}\n${stderr}`;
      if (!/Success/i.test(output)) {
        throw new FailureError(`adb install failed: ${output.trim()}`, {
          error_code: FAILURE_CODES.ANDROID_INSTALL_FAILED,
          failure_stage: "android_install_app_from_url",
          failure_area: "tool_server",
          error_kind: "subprocess",
          failure_command: "adb",
        });
      }
      return { installed: true, bundleId: artifact.bundleId };
    } finally {
      await artifact.cleanup();
    }
  },
};
