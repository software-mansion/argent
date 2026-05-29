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
    await backend.launch(udid, bundleId);
    return { restarted: true, bundleId };
  };
}
