import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { simctlOpenUrl } from "../../../utils/sim-remote";
import type { OpenUrlParams, OpenUrlResult, OpenUrlServices } from "../types";

export const iosRemoteImpl: PlatformImpl<OpenUrlServices, OpenUrlParams, OpenUrlResult> = {
  requires: ["sim-remote"],
  handler: async (_services, params) => {
    await simctlOpenUrl(params.udid, params.url);
    return { opened: true, url: params.url };
  },
};
