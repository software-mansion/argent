import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { vegaDevice } from "../../../utils/vega-cli";
import { ensureAutomationToolkitEnabled } from "../../../utils/vega-automation";
import type { RestartAppParams, RestartAppResult, RestartAppVegaServices } from "../types";

/**
 * Restart on Vega is terminate-then-launch by app id. `terminate-app` is
 * non-fatal when the app isn't running (the CLI just force-stops nothing), so
 * a "restart" of a not-yet-started app still ends up launching it. `activity`
 * is Android-only and ignored.
 *
 * The toolkit enable flag is (re)asserted before relaunch (best-effort) so a
 * restart is the canonical way to make an app introspectable by `describe`.
 */
export const vegaImpl: PlatformImpl<RestartAppVegaServices, RestartAppParams, RestartAppResult> = {
  requires: ["vega"],
  handler: async (_services, params) => {
    await ensureAutomationToolkitEnabled(params.udid).catch(() => {});
    await vegaDevice(params.udid, ["terminate-app", "-a", params.bundleId], {
      timeoutMs: 40_000,
    }).catch(() => {});
    await vegaDevice(params.udid, ["launch-app", "-a", params.bundleId], { timeoutMs: 60_000 });
    return { restarted: true, bundleId: params.bundleId };
  },
};
