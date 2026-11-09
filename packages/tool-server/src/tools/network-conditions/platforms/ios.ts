import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { toCdpNetworkConditions } from "../../../utils/network-conditions";
import {
  precheckNativeDevtools,
  type NativeDevtoolsPrecheckBlock,
} from "../../../blueprints/native-devtools";
import { requestedConditions, type NetworkConditionsParams } from "../schema";
import type { IosServices, NetworkConditionsResult } from "../types";

function missingBundleId(): FailureError {
  return new FailureError("network-conditions on iOS needs `bundleId`: the app to throttle.", {
    error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
    failure_stage: "network_conditions_params",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

function notConnected(bundleId: string): FailureError {
  return new FailureError(`Native devtools not connected for bundleId: ${bundleId}.`, {
    error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED,
    failure_stage: "network_conditions_connection",
    failure_area: "tool_server",
    error_kind: "not_found",
  });
}

export const iosImpl: PlatformImpl<
  IosServices,
  NetworkConditionsParams,
  NetworkConditionsResult | NativeDevtoolsPrecheckBlock
> = {
  requires: ["xcrun"],
  async handler(services, params) {
    const { bundleId } = params;
    if (!bundleId) throw missingBundleId();
    const api = services.nativeDevtools;
    const conditions = requestedConditions(params);

    if (conditions) {
      const blocked = await precheckNativeDevtools(api, params.udid, bundleId);
      if (blocked) return blocked;
      if (!api.isConnected(bundleId)) throw notConnected(bundleId);
    }

    api.setNetworkConditions(bundleId, conditions && toCdpNetworkConditions(conditions));
    return { scope: "app", conditions };
  },
};
