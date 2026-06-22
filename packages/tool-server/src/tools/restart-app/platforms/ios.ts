import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { RestartAppIosServices, RestartAppParams, RestartAppResult } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<RestartAppIosServices, RestartAppParams, RestartAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params, device) => {
    const { udid, bundleId } = params;
    if (device.kind === "device") {
      throw new Error("restart-app is not supported on physical iOS devices.");
    }
    const blocked = await precheckNativeDevtools(services.nativeDevtools, udid);
    if (blocked) return blocked;
    try {
      await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId]);
    } catch {
      // App may not be running — ignore
    }
    try {
      await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId]);
    } catch (err) {
      throw new FailureError(
        `Failed to restart iOS app ${bundleId} on ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_RESTART_LAUNCH_FAILED,
          failure_stage: "ios_restart_app_simctl_launch",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { restarted: true, bundleId };
  },
};
