import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import { assertPhysicalIosEnabled } from "../../../blueprints/core-device";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { LaunchAppIosServices, LaunchAppParams, LaunchAppResult } from "../types";

const execFileAsync = promisify(execFile);

export const iosImpl: PlatformImpl<LaunchAppIosServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["xcrun"],
  handler: async (services, params, device) => {
    // Physical iPhones are driven via CoreDevice — launch through devicectl
    // (the app must already be installed/signed on the device). The
    // native-devtools precheck is simulator-only, so it is skipped here.
    if (device.kind === "device") {
      // Unlike the CoreDevice-routed tools, launch-app shells devicectl directly
      // (no CoreDevice service), so it must enforce the opt-in flag itself —
      // otherwise it would be the one physical-iOS operation reachable while the
      // feature is disabled.
      assertPhysicalIosEnabled();
      try {
        await execFileAsync("xcrun", [
          "devicectl",
          "device",
          "process",
          "launch",
          "--device",
          params.udid,
          params.bundleId,
        ]);
      } catch (err) {
        // The dominant failure here is "app not installed/signed on the device".
        // Without this wrap, devicectl's verbose multi-line blob surfaces raw as
        // a 500; emit a structured FailureError with a clean message + telemetry
        // instead (mirroring the simctl branch below).
        throw new FailureError(
          `Failed to launch ${params.bundleId} on physical iOS device ${params.udid} via devicectl — the app must already be installed and signed on the device.`,
          {
            error_code: FAILURE_CODES.IOS_LAUNCH_DEVICECTL_FAILED,
            failure_stage: "ios_launch_app_devicectl_launch",
            failure_area: "tool_server",
            error_kind: "subprocess",
            ...subprocessFailureMetadata(err, "xcrun_devicectl"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
      return { launched: true, bundleId: params.bundleId };
    }
    const blocked = await precheckNativeDevtools(services.nativeDevtools, params.udid);
    if (blocked) return blocked;
    try {
      await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
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
