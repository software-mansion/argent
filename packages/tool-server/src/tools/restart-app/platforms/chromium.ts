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
import { signalGroup } from "../../../utils/process-kill";
import { CHROMIUM_CDP_NAMESPACE } from "../../../blueprints/chromium-cdp";
import {
  assertElectronAppLaunchable,
  bootElectronApp,
  electronLaunchSpec,
  heldPortError,
  killChromiumByPortAndWait,
  withPortLock,
} from "../../devices/boot-electron";
import type { RestartAppParams, RestartAppResult } from "../types";

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
    // The pid is cleared when the launcher exits, as after a crash, but the
    // rest of its group can live on and hold the port.
    const wasRunning =
      spec.pid !== undefined || (spec.pgid !== undefined && signalGroup(spec.pgid, 0));
    try {
      await assertElectronAppLaunchable(spec);
    } catch (err) {
      throw withPrefix(
        err,
        wasRunning
          ? "restart-app did not stop the app, which keeps running: "
          : "restart-app did not relaunch the app, whose process has exited: "
      );
    }
    await killChromiumByPortAndWait(port, wasRunning ? spec.pgid : undefined);
    await assertPortReleased(
      port,
      wasRunning
        ? "restart-app stopped the copy of the app that Argent started but did not relaunch it"
        : "restart-app did not relaunch the app"
    );
    // After the kill, so a frozen renderer cannot stall the dispose's CDP calls.
    const urn = `${CHROMIUM_CDP_NAMESPACE}:${params.udid}`;
    const entry = registry.getSnapshot().services.get(urn);
    if (entry && isLiveServiceState(entry.state)) await registry.disposeService(urn);
    try {
      await bootElectronApp({ appPath: spec.appPath, port, extraArgs: spec.extraArgs });
    } catch (err) {
      throw withPrefix(
        err,
        wasRunning
          ? "restart-app stopped the app but could not relaunch it: "
          : "restart-app could not relaunch the app: "
      );
    }
    return {
      restarted: true,
      bundleId: params.bundleId,
      appPath: spec.appPath,
      args: spec.extraArgs,
    };
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
      return withPortLock(port, () => restart(port, params));
    },
  };
}

/**
 * Fail when the kill left the port held: by another runtime on the freed port,
 * or a process the kill did not reach ({@link heldPortError}).
 */
async function assertPortReleased(port: number, lead: string): Promise<void> {
  const held = await heldPortError(port);
  if (!held) return;
  throw new FailureError(
    `${lead}: port ${port} is still held ` +
      `(${held.code ?? held.message}), so a new copy could not bind it. Check which process ` +
      `listens on port ${port} before you quit it: a copy the app relaunched itself runs ` +
      `outside the process group Argent started, and any other program there may be one you ` +
      `did not start. Once the port is free, retry restart-app.`,
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
    `restart-app can only relaunch an Electron app that this tool-server session booted ` +
      `(boot-device, or an e2e run), and ${udid} is not one: argent did not boot it, an e2e ` +
      `run booted it and stopped it at its end, a boot-device on its port failed since, or ` +
      `the tool-server restarted since the boot ` +
      `(an auto-started one exits after 30 idle minutes) and no longer knows how the app was ` +
      `launched. Quit the app if it still runs, then start it again: for an Electron app, ` +
      `boot-device with electronAppPath; otherwise relaunch it with --remote-debugging-port.`,
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
