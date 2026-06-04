import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { SimctlBackend } from "../../../utils/simctl-backend";
import type { LaunchAppIosServices, LaunchAppParams, LaunchAppResult } from "../types";

/**
 * Shared iOS handler used by both the local (`xcrun simctl`) and remote
 * (`sim-remote simctl`) branches. The native-devtools precheck and the
 * launched-payload shape are identical between the two; only the simctl
 * verbs differ — parametrised via `backend`.
 */
export function buildIosLaunchHandler(backend: SimctlBackend) {
  return async (
    services: LaunchAppIosServices,
    params: LaunchAppParams
  ): Promise<LaunchAppResult> => {
    const blocked = await precheckNativeDevtools(services.nativeDevtools, params.udid);
    if (blocked) return blocked;
    await backend.launch(params.udid, params.bundleId);
    return { launched: true, bundleId: params.bundleId };
  };
}
