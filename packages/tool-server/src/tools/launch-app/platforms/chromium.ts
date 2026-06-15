import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { LaunchAppParams, LaunchAppResult } from "../types";

export interface LaunchAppChromiumServices {
  chromium: ChromiumCdpApi;
}

/**
 * Chromium's "app" is the already-running process behind the CDP port. There's
 * no concept of installing or launching a separate bundle inside one Chromium
 * instance — the renderer is already there from `boot-device`. This handler
 * therefore acts as a no-op that confirms the connection and returns the
 * canonical bundleId passed by the caller, so workflows that always call
 * `launch-app` after `boot-device` (matching the iOS / Android pattern) keep
 * working without special-casing Chromium.
 *
 * If callers want to navigate the renderer to a route, they should use
 * `open-url` instead.
 */
export const chromiumImpl: PlatformImpl<
  LaunchAppChromiumServices,
  LaunchAppParams,
  LaunchAppResult
> = {
  handler: async (services, params) => {
    // Touch the viewport so a stale cached size doesn't trip the next tap if
    // the renderer window was resized between boot-device and launch-app.
    await services.chromium.refreshViewport();
    return { launched: true, bundleId: params.bundleId };
  },
};
