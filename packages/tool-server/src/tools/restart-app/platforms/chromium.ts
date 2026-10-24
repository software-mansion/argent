import { FAILURE_CODES, FailureError, isLiveServiceState, type Registry } from "@argent/registry";
import type { PlatformImpl } from "../../../utils/cross-platform-tool";
import { parseChromiumCdpPort } from "../../../utils/device-info";
import { CHROMIUM_CDP_NAMESPACE } from "../../../blueprints/chromium-cdp";
import {
  assertElectronAppLaunchable,
  bootElectronApp,
  electronLaunchSpec,
  killChromiumByPortAndWait,
} from "../../devices/boot-electron";
import type { RestartAppParams, RestartAppResult } from "../types";

/**
 * Per-port tail of in-flight restarts. Overlapping restarts would spawn two
 * instances on one port, and the readiness probe would accept either.
 */
const restarts = new Map<number, Promise<unknown>>();

/**
 * Relaunch an Electron app this tool-server booted, on the same port, so the
 * device id stays valid. `bundleId` is only echoed back. A Chromium runtime
 * started any other way has no recorded launch, so there is nothing to
 * relaunch it from.
 */
export function makeChromiumImpl(
  registry: Registry
): PlatformImpl<Record<string, unknown>, RestartAppParams, RestartAppResult> {
  async function restart(port: number, params: RestartAppParams): Promise<RestartAppResult> {
    const spec = electronLaunchSpec(port);
    if (!spec) throw notBooted(params.udid);
    assertElectronAppLaunchable(spec.appPath);
    await killChromiumByPortAndWait(port, spec.pid);
    // After the kill, so a frozen renderer cannot stall the dispose's CDP calls.
    const urn = `${CHROMIUM_CDP_NAMESPACE}:${params.udid}`;
    const entry = registry.getSnapshot().services.get(urn);
    if (entry && isLiveServiceState(entry.state)) await registry.disposeService(urn);
    await bootElectronApp({ appPath: spec.appPath, port, extraArgs: spec.extraArgs });
    return { restarted: true, bundleId: params.bundleId };
  }

  return {
    handler: async (_services, params) => {
      const port = parseChromiumCdpPort(params.udid);
      if (port === null) throw notBooted(params.udid);
      const run = (restarts.get(port) ?? Promise.resolve())
        .catch(() => {})
        .then(() => restart(port, params));
      restarts.set(port, run);
      try {
        return await run;
      } finally {
        if (restarts.get(port) === run) restarts.delete(port);
      }
    },
  };
}

function notBooted(udid: string): FailureError {
  return new FailureError(
    `restart-app can only relaunch an Electron app that boot-device started in this ` +
      `tool-server session, and ${udid} is not one. Quit the app and relaunch it ` +
      `with --remote-debugging-port (for an Electron app, boot-device with electronAppPath).`,
    {
      error_code: FAILURE_CODES.CHROMIUM_RESTART_NOT_BOOTED,
      failure_stage: "chromium_restart_spec_lookup",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}
