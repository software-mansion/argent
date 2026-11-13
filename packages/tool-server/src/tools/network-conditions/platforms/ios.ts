import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { toCdpNetworkConditions } from "../../../utils/network-conditions";
import { metroPort } from "../../../utils/debugger/metro-port";
import {
  isInjectableBundleId,
  precheckNativeDevtools,
  type NativeDevtoolsApi,
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

function appleApp(bundleId: string): FailureError {
  return new FailureError(
    `${bundleId} is an Apple system app. network-conditions on iOS throttles only a non-Apple app that Argent launched with native devtools.`,
    {
      error_code: FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE,
      failure_stage: "network_conditions_params",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

async function isNotRunning(api: NativeDevtoolsApi, bundleId: string): Promise<boolean> {
  if (api.isConnected(bundleId)) return false;
  const state = await api.appConnectionState(bundleId).catch(() => null);
  return state === "not_running";
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
    if (!isInjectableBundleId(bundleId)) throw appleApp(bundleId);
    const api = services.nativeDevtools;
    const conditions = requestedConditions(params);

    if (conditions || !(await isNotRunning(api, bundleId))) {
      const blocked = await precheckNativeDevtools(api, params.udid, bundleId);
      if (blocked) return blocked;
      if (!api.isConnected(bundleId)) throw notConnected(bundleId);
    }

    const throttle = conditions && {
      conditions: toCdpNetworkConditions(conditions),
      metroPort: metroPort({ device_id: params.udid, port: params.port }),
    };
    await api.setNetworkConditions(bundleId, throttle);
    return { scope: "app", conditions };
  },
};
