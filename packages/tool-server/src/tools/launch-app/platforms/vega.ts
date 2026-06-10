import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { vegaDevice } from "../../../utils/vega-cli";
import type { LaunchAppParams, LaunchAppResult, LaunchAppVegaServices } from "../types";

/**
 * Vega launches an installed interactive component by its app id — the
 * `…​.main` form from the package's manifest.toml (e.g.
 * `com.example.app.main`), which is what `bundleId` carries here. `activity`
 * is Android-only and ignored. There is no native-devtools injection on Vega,
 * so no service is needed.
 */
export const vegaImpl: PlatformImpl<LaunchAppVegaServices, LaunchAppParams, LaunchAppResult> = {
  requires: ["vega"],
  handler: async (_services, params) => {
    await vegaDevice(params.udid, ["launch-app", "-a", params.bundleId], { timeoutMs: 60_000 });
    return { launched: true, bundleId: params.bundleId };
  },
};
