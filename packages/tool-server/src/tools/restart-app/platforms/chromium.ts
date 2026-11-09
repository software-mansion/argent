import * as net from "node:net";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  isLiveServiceState,
  wrapFailure,
  type Registry,
} from "@argent/registry";
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
    try {
      assertElectronAppLaunchable(spec.appPath);
    } catch (err) {
      throw withPrefix(err, "restart-app did not stop the app, which keeps running: ");
    }
    await killChromiumByPortAndWait(port, spec.pid);
    await assertPortReleased(port);
    // After the kill, so a frozen renderer cannot stall the dispose's CDP calls.
    const urn = `${CHROMIUM_CDP_NAMESPACE}:${params.udid}`;
    const entry = registry.getSnapshot().services.get(urn);
    if (entry && isLiveServiceState(entry.state)) await registry.disposeService(urn);
    try {
      await bootElectronApp({ appPath: spec.appPath, port, extraArgs: spec.extraArgs });
    } catch (err) {
      throw withPrefix(err, "restart-app stopped the app but could not relaunch it: ");
    }
    return { restarted: true, bundleId: params.bundleId };
  }

  return {
    handler: async (_services, params) => {
      const port = parseChromiumCdpPort(params.udid);
      if (port === null) {
        throw new FailureError(
          `restart-app got a malformed Chromium device id "${params.udid}". Expected ` +
            `"chromium-cdp-<port>"; take the id from list-devices.`,
          {
            error_code: FAILURE_CODES.CHROMIUM_DEVICE_ID_INVALID,
            failure_stage: "chromium_restart_device_id",
            failure_area: "tool_server",
            error_kind: "validation",
          }
        );
      }
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

/**
 * The boot's readiness probe accepts whatever answers on the port, so a process
 * still holding it (another runtime on the freed port, or a kill that did not
 * land) would pass for the relaunch while the new copy fails to bind. Probing
 * by binding asks exactly what the relaunch needs, including of a holder that
 * accepts connections but never answers CDP.
 */
async function assertPortReleased(port: number): Promise<void> {
  const bindError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => resolve(err));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(null)));
  });
  if (!bindError) return;
  throw new FailureError(
    `restart-app stopped the app but did not relaunch it: port ${port} is still held ` +
      `(${bindError.code ?? bindError.message}), so a new copy could not bind it. Quit the ` +
      `process listening on port ${port} (it can be a leftover process of the app), then ` +
      `retry restart-app.`,
    {
      error_code: FAILURE_CODES.CHROMIUM_RESTART_PORT_IN_USE,
      failure_stage: "chromium_restart_port_check",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

function notBooted(udid: string): FailureError {
  return new FailureError(
    `restart-app can only relaunch an Electron app that boot-device started in this ` +
      `tool-server session, and ${udid} is not one: boot-device did not start it, an e2e run ` +
      `booted it and stopped it at its end, or the tool-server restarted since the boot (an ` +
      `auto-started one exits after 30 idle minutes) and no longer knows how the app was ` +
      `launched. Start the app again: for an Electron app, boot-device with electronAppPath; ` +
      `otherwise quit it if it runs and relaunch it with --remote-debugging-port.`,
    {
      error_code: FAILURE_CODES.CHROMIUM_RESTART_NOT_BOOTED,
      failure_stage: "chromium_restart_spec_lookup",
      failure_area: "tool_server",
      error_kind: "validation",
    }
  );
}

/** `err` with `prefix` on its message and its failure signal kept. */
function withPrefix(err: unknown, prefix: string): unknown {
  const signal = getFailureSignal(err);
  return signal && err instanceof Error ? wrapFailure(err, signal, prefix + err.message) : err;
}
