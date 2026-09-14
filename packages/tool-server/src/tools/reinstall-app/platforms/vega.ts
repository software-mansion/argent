import { resolve as resolvePath } from "node:path";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { vegaDevice } from "../../../utils/vega-cli";
import type { ReinstallAppParams, ReinstallAppResult, ReinstallAppServices } from "../types";

/**
 * Uninstalls first (swallowing the not-installed case) to match the clean-wipe
 * semantics of the iOS/Android branches. `bundleId` is the Vega interactive
 * component app id (e.g. com.example.app.main); `appPath` is a `.vpkg`.
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
      // `install-app` prints one result line per phase ("Installing/Updating '…'
      // ...success", "Activating '…' ...failed"), so a later phase can fail after an
      // earlier `...success`: require a success marker AND no failed one.
      const output = `${stdout}\n${stderr}`;
      const succeeded = /\.\.\.\s*success\b/i.test(output);
      const failed = /\.\.\.\s*failed\b/i.test(output);
      if (!succeeded || failed) {
        throw new FailureError(`vega install-app failed: ${output.trim()}`, {
          error_code: FAILURE_CODES.VEGA_CLI_COMMAND_FAILED,
          failure_stage: "vega_reinstall_install_app",
          failure_area: "tool_server",
          error_kind: "subprocess",
          failure_command: "vega",
        });
      }
      return { reinstalled: true, bundleId };
    },
  };
