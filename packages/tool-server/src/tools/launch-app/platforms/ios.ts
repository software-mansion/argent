import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type Registry,
} from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
} from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import type { LaunchAppParams, LaunchAppResult } from "../types";

const execFileAsync = promisify(execFile);

// tvOS sims classify as platform "ios" and land in this branch too;
// native-devtools covers them — its env setup picks the TVOSSIMULATOR dylib
// slice for Apple TV sims.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, LaunchAppParams, LaunchAppResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, params, device) => {
      const ndRef = nativeDevtoolsRef(device);
      const nativeDevtools = await registry.resolveService<NativeDevtoolsApi>(
        ndRef.urn,
        ndRef.options
      );
      const blocked = await precheckNativeDevtools(nativeDevtools, params.udid);
      if (blocked) return blocked;
      try {
        await execFileAsync(
          "xcrun",
          await simctlArgsForUdid(params.udid, ["launch", params.udid, params.bundleId])
        );
      } catch (err) {
        throw new FailureError(
          `Failed to launch iOS app ${params.bundleId} on ${params.udid}.`,
          {
            error_code: FAILURE_CODES.IOS_LAUNCH_SIMCTL_FAILED,
            failure_stage: "ios_launch_app_simctl_launch",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "xcrun_simctl"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
      return { launched: true, bundleId: params.bundleId };
    },
  };
}
