import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../../utils/cross-platform-tool";
import { NATIVE_DEVTOOLS_NAMESPACE } from "../../../../blueprints/native-devtools";
import type { BootDeviceParams, BootDeviceResult, BootDeviceServices } from "../types";

const execFileAsync = promisify(execFile);

// Closure over `registry` because the native-devtools blueprint must be
// resolved AFTER `bootstatus` returns — the factory connects to launchd in
// the running simulator and would fail if the simulator isn't booted yet.
// `dispatchByPlatform`'s declarative `services` field would resolve it
// before execute, breaking that ordering.
export function makeIosImpl(
  registry: Registry
): PlatformImpl<BootDeviceServices, BootDeviceParams, BootDeviceResult> {
  return {
    requires: ["xcrun"],
    handler: async (_services, _params, device) => {
      const udid = device.id;
      await execFileAsync("xcrun", ["simctl", "boot", udid]).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // `simctl boot` errors when the device is already booted — treat as success.
        if (!message.includes("Unable to boot device in current state: Booted")) {
          throw err;
        }
      });
      // `bootstatus -b` blocks until the simulator is fully ready for env setup.
      await execFileAsync("xcrun", ["simctl", "bootstatus", udid, "-b"]);
      // Spin up native-devtools NOW — bootstatus has confirmed launchd is up,
      // so the blueprint factory can reach in and set DYLD_INSERT_LIBRARIES.
      await registry.resolveService(`${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`);
      // `defaults write` + `open Simulator.app` after the env is primed so the
      // UI reflects the injected state on first paint.
      await execFileAsync("defaults", [
        "write",
        "com.apple.iphonesimulator",
        "CurrentDeviceUDID",
        udid,
      ]);
      await execFileAsync("open", ["-a", "Simulator.app"]);
      return { platform: "ios", udid, booted: true };
    },
  };
}
