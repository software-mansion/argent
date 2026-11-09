import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { toCdpNetworkConditions } from "../../../utils/network-conditions";
import { requestedConditions, type NetworkConditionsParams } from "../schema";
import type { ChromiumServices, NetworkConditionsResult } from "../types";

export const chromiumImpl: PlatformImpl<
  ChromiumServices,
  NetworkConditionsParams,
  NetworkConditionsResult
> = {
  async handler(services, params) {
    const conditions = requestedConditions(params);
    await services.chromium.server.network.setConditions(toCdpNetworkConditions(conditions));
    return { scope: "tab", conditions };
  },
};
