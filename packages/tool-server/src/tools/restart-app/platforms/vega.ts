import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { vegaDevice } from "../../../utils/vega-cli";
import { ensureAutomationToolkitEnabled } from "../../../utils/vega-automation";
import type { RestartAppParams, RestartAppResult, RestartAppVegaServices } from "../types";

/**
 * `activity` is Android-only and ignored.
 *
 * The automation-toolkit enable flag is only consulted at app launch, so it is
 * set first (best-effort) for `describe` to have an introspection server after
 * the relaunch.
 *
 * `adb` is declared even though only `ensureAutomationToolkitEnabled` uses it: a
 * missing install then fails fast with an install hint instead of silently
 * leaving the app un-introspectable, while the `.catch` still tolerates non-dep
 * hiccups (e.g. VVD console-port discovery).
 */
export const vegaImpl: PlatformImpl<RestartAppVegaServices, RestartAppParams, RestartAppResult> = {
  requires: ["vega", "adb"],
  handler: async (_services, params) => {
    await ensureAutomationToolkitEnabled(params.udid).catch(() => {});
    await vegaDevice(params.udid, ["terminate-app", "-a", params.bundleId], {
      timeoutMs: 40_000,
    }).catch(() => {});
    await vegaDevice(params.udid, ["launch-app", "-a", params.bundleId], { timeoutMs: 60_000 });
    return { restarted: true, bundleId: params.bundleId };
  },
};
