import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  type DeviceInfo,
} from "@argent/registry";
import { precheckNativeDevtools } from "../../../blueprints/native-devtools";
import { enableAppAccessibilityBeforeLaunch } from "../../../utils/ios-host";
import { SIM_REMOTE_TIMEOUT_MS, simRemoteExecError } from "../../../utils/sim-remote";
import {
  SIMCTL_NOTHING_TO_TERMINATE,
  tolerateNothingToTerminate,
  type SimctlBackend,
} from "../../../utils/simctl-backend";
import type { RestartAppIosServices, RestartAppParams, RestartAppResult } from "../types";

export function buildIosRestartHandler(backend: SimctlBackend) {
  return async (
    services: RestartAppIosServices,
    params: RestartAppParams,
    device: DeviceInfo
  ): Promise<RestartAppResult> => {
    const { udid, bundleId } = params;
    const blocked = await precheckNativeDevtools(services.nativeDevtools, udid);
    if (blocked) return blocked;
    // Alongside the terminate below: the launch needs both done, neither needs the other.
    const accessibility = enableAppAccessibilityBeforeLaunch(device);
    try {
      await tolerateNothingToTerminate(
        backend.terminate(udid, bundleId),
        SIMCTL_NOTHING_TO_TERMINATE
      );
    } catch (err) {
      // Any other failure, timeout or transport error included, may have left the old process up.
      const exec = simRemoteExecError(err);
      const timedOut = exec.killed === true;
      throw new FailureError(
        timedOut
          ? `Terminating iOS app ${bundleId} on ${udid} did not finish within ${SIM_REMOTE_TIMEOUT_MS / 1000}s, so it was not restarted.`
          : `Terminating iOS app ${bundleId} on ${udid} failed, so it was not restarted.`,
        {
          error_code: FAILURE_CODES.IOS_RESTART_TERMINATE_FAILED,
          failure_stage: "ios_restart_app_simctl_terminate",
          failure_area: "tool_server",
          error_kind: timedOut ? "timeout" : "subprocess",
          ...subprocessFailureMetadata(exec, "sim_remote"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    await accessibility;
    try {
      await backend.launch(udid, bundleId, params.launchArgs);
    } catch (err) {
      const exec = simRemoteExecError(err);
      const timedOut = exec.killed === true;
      throw new FailureError(
        timedOut
          ? `Relaunching iOS app ${bundleId} on ${udid} did not finish within ${SIM_REMOTE_TIMEOUT_MS / 1000}s.`
          : `Failed to restart iOS app ${bundleId} on ${udid}.`,
        {
          error_code: FAILURE_CODES.IOS_RESTART_LAUNCH_FAILED,
          failure_stage: "ios_restart_app_simctl_launch",
          failure_area: "tool_server",
          error_kind: timedOut ? "timeout" : "subprocess",
          ...subprocessFailureMetadata(exec, "sim_remote"),
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
    }
    return { restarted: true, bundleId };
  };
}
