import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Registry } from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
} from "../../../blueprints/native-devtools";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { isTvOsSimulator } from "../../../utils/ios-devices";
import type { RestartAppParams, RestartAppResult } from "../types";

const execFileAsync = promisify(execFile);

// native-devtools is resolved lazily (through `registry`) rather than declared
// as an eager service, so a tvOS sim — which classifies as platform "ios" by
// UDID shape — never resolves the iOS-only injection. See createRestartAppTool.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, RestartAppParams, RestartAppResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, params, device) => {
      const { udid, bundleId } = params;
      // tvOS has no native-devtools injection — its iOS-built dylib can't load
      // in an Apple TV process, and resolving the service would `setenv` a bad
      // DYLD_INSERT_LIBRARIES into the sim. Skip straight to the relaunch.
      if (!(await isTvOsSimulator(udid))) {
        const ndRef = nativeDevtoolsRef(device);
        const nativeDevtools = await registry.resolveService<NativeDevtoolsApi>(
          ndRef.urn,
          ndRef.options
        );
        const blocked = await precheckNativeDevtools(nativeDevtools, udid);
        if (blocked) return blocked;
      }
      try {
        await execFileAsync("xcrun", ["simctl", "terminate", udid, bundleId]);
      } catch {
        // App may not be running — ignore
      }
      await execFileAsync("xcrun", ["simctl", "launch", udid, bundleId]);
      return { restarted: true, bundleId };
    },
  };
}
