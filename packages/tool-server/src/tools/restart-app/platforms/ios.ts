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
import { assertPhysicalIosEnabled } from "../../../blueprints/simulator-server";
import { subprocessOutputTail } from "../../../utils/format-error";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import type { RestartAppParams, RestartAppResult } from "../types";

const execFileAsync = promisify(execFile);

// native-devtools is resolved lazily (through `registry`) rather than declared
// as an eager service. It is iOS *and* tvOS capable: the blueprint's ensureEnv
// picks the platform-matched DYLD_INSERT_LIBRARIES slice (the TVOSSIMULATOR
// bootstrap for Apple TV sims), so resolving it here injects correctly on both.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, RestartAppParams, RestartAppResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, params, device) => {
      const { udid, bundleId } = params;
      if (device.kind === "device") {
        // A physical iPhone restarts through devicectl, which relaunches the app
        // as it is installed. The simulator path restarts *through*
        // native-devtools so the process comes back injected; that injection is
        // simulator-only, so there is nothing to preserve here and a plain
        // relaunch is the whole operation. Like every devicectl-backed tool, this
        // enforces the opt-in itself, since no simulator-server ref is built on
        // this path to run the gate.
        assertPhysicalIosEnabled();
        try {
          await execFileAsync("xcrun", [
            "devicectl",
            "device",
            "process",
            "launch",
            "--terminate-existing",
            "--device",
            udid,
            bundleId,
          ]);
        } catch (err) {
          // devicectl's own lines first: they separate "not installed" from
          // "locked" from a signing failure, and the metadata below records only
          // exit code / signal, so nothing else carries them to the caller.
          const detail = subprocessOutputTail(err);
          throw new FailureError(
            `Failed to restart ${bundleId} on physical iOS device ${udid} via devicectl.` +
              (detail ? ` devicectl: ${detail}.` : "") +
              ` Most often the app is not installed on the device, or not signed for it.`,
            {
              error_code: FAILURE_CODES.IOS_RESTART_LAUNCH_FAILED,
              failure_stage: "ios_restart_app_devicectl_launch",
              failure_area: "tool_server",
              error_kind: "subprocess",
              ...subprocessFailureMetadata(err, "xcrun_devicectl"),
            },
            { cause: err instanceof Error ? err : new Error(String(err)) }
          );
        }
        return { restarted: true, bundleId };
      }
      const ndRef = nativeDevtoolsRef(device);
      const nativeDevtools = await registry.resolveService<NativeDevtoolsApi>(
        ndRef.urn,
        ndRef.options
      );
      const blocked = await precheckNativeDevtools(nativeDevtools, udid);
      if (blocked) return blocked;
      try {
        await execFileAsync("xcrun", await simctlArgsForUdid(udid, ["terminate", udid, bundleId]));
      } catch {
        // App may not be running — ignore
      }
      try {
        await execFileAsync("xcrun", await simctlArgsForUdid(udid, ["launch", udid, bundleId]));
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
}
