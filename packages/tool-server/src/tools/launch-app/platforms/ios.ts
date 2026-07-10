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
import { assertPhysicalIosEnabled } from "../../../blueprints/core-device";
import {
  physicalIosAutomationRef,
  type PhysicalIosAutomationApi,
} from "../../../blueprints/physical-ios-automation";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { LaunchAppParams, LaunchAppResult } from "../types";

const execFileAsync = promisify(execFile);

// native-devtools is resolved lazily (through `registry`) rather than declared
// as an eager service. It is iOS *and* tvOS capable: the blueprint's ensureEnv
// picks the platform-matched DYLD_INSERT_LIBRARIES slice (the TVOSSIMULATOR
// bootstrap for Apple TV sims), so resolving it here injects correctly on both.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, LaunchAppParams, LaunchAppResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, params, device) => {
      // Launch physical apps through devicectl while warming the WDA control
      // session. The app must already be installed/signed on the device.
      if (device.kind === "device") {
        // launch-app shells devicectl before resolving a tool-declared service,
        // so it enforces the opt-in flag itself.
        assertPhysicalIosEnabled();
        try {
          const ref = physicalIosAutomationRef(device);
          // Warm the persistent WDA transport while devicectl launches the app.
          // This moves the one-time XCTest session startup out of the first tap
          // so steady-state control registration matches simulator cadence.
          await Promise.all([
            registry.resolveService<PhysicalIosAutomationApi>(ref.urn, ref.options),
            execFileAsync("xcrun", [
              "devicectl",
              "device",
              "process",
              "launch",
              "--device",
              params.udid,
              params.bundleId,
            ]),
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
      const ndRef = nativeDevtoolsRef(device);
      const nativeDevtools = await registry.resolveService<NativeDevtoolsApi>(
        ndRef.urn,
        ndRef.options
      );
      const blocked = await precheckNativeDevtools(nativeDevtools, params.udid);
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
}
