import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import type { SimctlBackend } from "../../../utils/simctl-backend";
import type { RestartAppIosServices, RestartAppParams, RestartAppResult } from "../types";

/**
 * Shared iOS handler for both local (`xcrun simctl`) and remote
 * (`sim-remote simctl`) branches. Termination is best-effort — the app may not
 * be running. Only the simctl verbs differ between branches, parametrised via
 * `backend`.
 */
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
      // App may not be running — ignore.
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
