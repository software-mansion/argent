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
import { externalClaimForAnyId } from "../../../utils/external-devices";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlArgsForUdid } from "../../../utils/ios-device-sets";
import type { RestartAppParams, RestartAppResult } from "../types";

const execFileAsync = promisify(execFile);

// native-devtools is resolved lazily here instead of via `services()`. tvOS sims
// also classify as platform "ios"; the blueprint's ensureEnv picks the
// TVOSSIMULATOR dylib slice, so injection is correct for both.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, RestartAppParams, RestartAppResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, params, device) => {
      const { udid, bundleId } = params;
      /**
       * Same reasoning as launch-app. native-devtools is a granted mechanism,
       * so resolving it unconditionally would fail the restart on a
       * provider-supplied device that (quite reasonably) withholds injection.
       *
       * Keyed on the provider's claim, not on the `ext:` spelling. The same
       * device named by its raw udid would otherwise take the branch below and
       * fail on a grant the provider withheld, so one device would launch or
       * not depending only on which of its names was used.
       */
      if (!externalClaimForAnyId(device.id)) {
        const ndRef = nativeDevtoolsRef(device);
        const nativeDevtools = await registry.resolveService<NativeDevtoolsApi>(
          ndRef.urn,
          ndRef.options
        );
        const blocked = await precheckNativeDevtools(nativeDevtools, udid);
        if (blocked) return blocked;
      }
      try {
        await execFileAsync("xcrun", await simctlArgsForUdid(udid, ["terminate", udid, bundleId]));
      } catch {
        // App may not be running
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
