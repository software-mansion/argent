import { FAILURE_CODES, FailureError, subprocessFailureMetadata } from "@argent/registry";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import { SIM_REMOTE_TIMEOUT_MS, simRemoteExecError } from "../../../utils/sim-remote";
import {
  SIMCTL_NOTHING_TO_TERMINATE,
  tolerateNothingToTerminate,
  type SimctlBackend,
} from "../../../utils/simctl-backend";
import type { LaunchAppIosServices, LaunchAppParams, LaunchAppResult } from "../types";

export function buildIosLaunchHandler(backend: SimctlBackend) {
  return async (
    services: LaunchAppIosServices,
    params: LaunchAppParams
  ): Promise<LaunchAppResult> => {
    const blocked = await precheckNativeDevtools(services.nativeDevtools, params.udid);
    if (blocked) return blocked;
    // A plain launch only foregrounds an app that is already running, so the
    // arguments would be dropped. Terminate first to apply them.
    if (params.launchArgs?.length) {
      try {
        await tolerateNothingToTerminate(
          backend.terminate(params.udid, params.bundleId),
          SIMCTL_NOTHING_TO_TERMINATE
        );
      } catch (err) {
        // Any other failure, timeout or transport error included, may leave the app running to drop the args.
        const exec = simRemoteExecError(err);
        const timedOut = exec.killed === true;
        throw new FailureError(
          timedOut
            ? `Terminating iOS app ${params.bundleId} on ${params.udid} to apply launchArgs did not finish within ${SIM_REMOTE_TIMEOUT_MS / 1000}s.`
            : `Terminating iOS app ${params.bundleId} on ${params.udid} to apply launchArgs failed.`,
          {
            error_code: FAILURE_CODES.IOS_LAUNCH_SIMCTL_FAILED,
            failure_stage: "ios_launch_app_simctl_terminate",
            failure_area: "tool_server",
            error_kind: timedOut ? "timeout" : "subprocess",
            ...subprocessFailureMetadata(exec, "sim_remote"),
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        );
      }
    }
    try {
      await backend.launch(params.udid, params.bundleId, params.launchArgs);
    } catch (err) {
      const exec = simRemoteExecError(err);
      const timedOut = exec.killed === true;
      throw new FailureError(
        timedOut
          ? `Launching iOS app ${params.bundleId} on ${params.udid} did not finish within ${SIM_REMOTE_TIMEOUT_MS / 1000}s.`
          : `Failed to launch iOS app ${params.bundleId} on ${params.udid}.`,
        {
          error_code: FAILURE_CODES.IOS_LAUNCH_SIMCTL_FAILED,
          failure_stage: "ios_launch_app_simctl_launch",
          failure_area: "tool_server",
          error_kind: timedOut ? "timeout" : "subprocess",
          ...subprocessFailureMetadata(exec, "sim_remote"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { launched: true, bundleId: params.bundleId };
  };
}
