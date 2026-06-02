import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
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
    try {
      await backend.launch(params.udid, params.bundleId);
    } catch (err) {
      throw new FailureError(
        `Failed to launch iOS app ${params.bundleId} on ${params.udid}.`,
        {
          error_code: FAILURE_CODES.IOS_LAUNCH_SIMCTL_FAILED,
          failure_stage: "ios_launch_app_simctl_launch",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { launched: true, bundleId: params.bundleId };
  };
}
