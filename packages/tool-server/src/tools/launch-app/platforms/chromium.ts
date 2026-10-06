import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { LaunchAppParams, LaunchAppResult } from "../types";

export interface LaunchAppChromiumServices {
  chromium: ChromiumCdpApi;
}

/**
 * Nothing to launch: the renderer is already running from `boot-device`, so this
 * just echoes the caller's bundleId, letting the iOS / Android "launch-app after
 * boot-device" pattern work unchanged. Use `open-url` to navigate the renderer.
 */
export const chromiumImpl: PlatformImpl<
  LaunchAppChromiumServices,
  LaunchAppParams,
  LaunchAppResult
> = {
  handler: async (services, params) => {
    // The cached viewport drives normalized -> pixel gesture math, and the window
    // may have been resized since boot-device.
    await services.chromium.refreshViewport();
    return { launched: true, bundleId: params.bundleId };
  },
};
