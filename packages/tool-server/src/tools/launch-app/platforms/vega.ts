import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { vegaDevice } from "../../../utils/vega-cli";
import { ensureAutomationToolkitEnabled } from "../../../utils/vega-automation";
import type { LaunchAppParams, LaunchAppResult, LaunchAppVegaServices } from "../types";

/**
 * `bundleId` is the Vega interactive component app id (the `….main` entry from
 * the package's manifest.toml); `activity` is Android-only and ignored, and Vega
 * has no native-devtools injection, hence no services.
 *
 * The automation-toolkit enable flag is only consulted at app launch, so it is
 * set first (best-effort) for `describe` to have an introspection server.
 *
 * `adb` is declared even though only `ensureAutomationToolkitEnabled` uses it: a
 * missing install then fails fast with an install hint instead of silently
 * leaving the launched app un-introspectable, while the `.catch` still tolerates
 * non-dep hiccups (e.g. VVD console-port discovery).
 */
export const vegaImpl: PlatformImpl<LaunchAppVegaServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["vega", "adb"],
  handler: async (_services, params) => {
    await ensureAutomationToolkitEnabled(params.udid).catch(() => {});
    await vegaDevice(params.udid, ["launch-app", "-a", params.bundleId], { timeoutMs: 60_000 });
    return { launched: true, bundleId: params.bundleId };
  },
};
