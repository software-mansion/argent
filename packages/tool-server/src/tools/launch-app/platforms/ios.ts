import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Registry } from "@argent/registry";
import {
  nativeDevtoolsRef,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
} from "../../../blueprints/native-devtools";
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
      const ndRef = nativeDevtoolsRef(device);
      const nativeDevtools = await registry.resolveService<NativeDevtoolsApi>(
        ndRef.urn,
        ndRef.options
      );
      const blocked = await precheckNativeDevtools(nativeDevtools, params.udid);
      if (blocked) return blocked;
      await execFileAsync("xcrun", ["simctl", "launch", params.udid, params.bundleId]);
      return { launched: true, bundleId: params.bundleId };
    },
  };
}
