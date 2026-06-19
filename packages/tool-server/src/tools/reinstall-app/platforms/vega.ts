import { resolve as resolvePath } from "node:path";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { vegaDevice } from "../../../utils/vega-cli";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

/**
 * Vega installs a `.vpkg` package via `install-app -p <path>`. To match the
 * clean-wipe semantics of the iOS/Android branches we uninstall first (by app
 * id), swallowing the not-installed case. `bundleId` is the interactive
 * component app id (e.g. com.example.app.main); `appPath` is the `.vpkg`.
 */
export const vegaImpl: PlatformImpl<ReinstallAppServices, ReinstallAppParams, ReinstallAppResult> =
  {
    requires: ["vega"],
    handler: async (_services, params) => {
      const { udid, bundleId, appPath } = params;
      const absolute = resolvePath(appPath);

      await vegaDevice(udid, ["uninstall-app", "-a", bundleId], { timeoutMs: 60_000 }).catch(
        () => {}
      );

      const { stdout, stderr } = await vegaDevice(udid, ["install-app", "-p", absolute], {
        timeoutMs: 180_000,
      });
      // `install-app` prints "Installing/Updating '…' ...success" on success.
      // Anchor on the `...success` line so failure phrases like "unsuccessful"
      // or "was not successful" can't read as success.
      const output = `${stdout}\n${stderr}`;
      if (!/\.\.\.\s*success\b/i.test(output)) {
        throw new Error(`vega install-app failed: ${output.trim()}`);
      }
      return { reinstalled: true, bundleId };
    },
  };
