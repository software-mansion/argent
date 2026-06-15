import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ChromiumCdpApi } from "../../../blueprints/chromium-cdp";
import type { OpenUrlParams, OpenUrlResult } from "../types";

export interface OpenUrlChromiumServices {
  chromium: ChromiumCdpApi;
}

export const chromiumImpl: PlatformImpl<OpenUrlChromiumServices, OpenUrlParams, OpenUrlResult> = {
  handler: async (services, params) => {
    await services.chromium.navigate(params.url);
    // Re-read the viewport — navigating to a route can swap layouts that change
    // window.innerWidth/Height (responsive UIs).
    await services.chromium.refreshViewport();
    return { opened: true, url: params.url };
  },
};
