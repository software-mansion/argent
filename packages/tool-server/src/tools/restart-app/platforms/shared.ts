import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { SimctlBackend } from "../../../utils/simctl-backend";
import type { RestartAppIosServices, RestartAppParams, RestartAppResult } from "../types";

export function buildIosRestartHandler(backend: SimctlBackend) {
  return async (
    services: RestartAppIosServices,
    params: RestartAppParams
  ): Promise<RestartAppResult> => {
    const { udid, bundleId } = params;
    const blocked = await precheckNativeDevtools(services.nativeDevtools, udid);
    if (blocked) return blocked;
    try {
      await backend.terminate(udid, bundleId);
    } catch {
      // App may not be running
    }
    try {
      await backend.launch(udid, bundleId);
    } catch (err) {
      throw new FailureError(
        `Failed to restart iOS app ${bundleId} on ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_RESTART_LAUNCH_FAILED,
          failure_stage: "ios_restart_app_simctl_launch",
          failure_area: "tool_server",
          error_kind: "subprocess",
          ...subprocessFailureMetadata(err, "xcrun_simctl"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { restarted: true, bundleId };
  };
}
