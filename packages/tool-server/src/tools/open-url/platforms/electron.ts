import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import type { ElectronCdpApi } from "../../../blueprints/electron-cdp";
import type { OpenUrlParams, OpenUrlResult } from "../types";

export interface OpenUrlElectronServices {
  electron: ElectronCdpApi;
}

export const electronImpl: PlatformImpl<OpenUrlElectronServices, OpenUrlParams, OpenUrlResult> = {
  handler: async (services, params) => {
    await services.electron.navigate(params.url);
    // Re-read the viewport — navigating to a route can swap layouts that change
    // window.innerWidth/Height (responsive UIs).
    await services.electron.refreshViewport();
    return { opened: true, url: params.url };
  },
};
