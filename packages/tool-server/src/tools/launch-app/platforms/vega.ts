import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { vegaDevice } from "../../../utils/vega-cli";
import { ensureAutomationToolkitEnabled } from "../../../utils/vega-automation";
import type { LaunchAppParams, LaunchAppResult, LaunchAppVegaServices } from "../types";

/**
 * Vega launches an installed interactive component by its app id — the
 * `…​.main` form from the package's manifest.toml (e.g.
 * `com.example.app.main`), which is what `bundleId` carries here. `activity`
 * is Android-only and ignored. There is no native-devtools injection on Vega,
 * so no service is needed.
 *
 * We set the automation-toolkit enable flag *before* launching (best-effort) so
 * the launched app attaches the introspection server `describe` reads — the flag
 * is only consulted at app launch.
 */
export const vegaImpl: PlatformImpl<LaunchAppVegaServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["vega"],
  handler: async (_services, params) => {
    await ensureAutomationToolkitEnabled(params.udid).catch(() => {});
    await vegaDevice(params.udid, ["launch-app", "-a", params.bundleId], { timeoutMs: 60_000 });
    return { launched: true, bundleId: params.bundleId };
  },
};
