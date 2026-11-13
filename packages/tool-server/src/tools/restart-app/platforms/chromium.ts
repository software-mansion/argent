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
    // The pid is cleared when the app exits, as after a crash.
    const wasRunning = spec.pid !== undefined;
    try {
      assertElectronAppLaunchable(spec.appPath);
    } catch (err) {
      throw withPrefix(
        err,
        wasRunning
          ? "restart-app did not stop the app, which keeps running: "
          : "restart-app did not relaunch the app, whose process has exited: "
      );
    }
    await killChromiumByPortAndWait(port, spec.pid);
    await assertPortReleased(
      port,
      wasRunning
        ? "restart-app stopped the app but did not relaunch it"
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
      return withPortLock(port, () => restart(port, params));
    },
  };
}

/**
 * The boot's readiness probe accepts whatever answers on the port, so a process
 * still holding it (another runtime on the freed port, or a kill that did not
 * land) would pass for the relaunch while the new copy fails to bind. Probing
 * by binding asks what the relaunch needs, including of a holder that accepts
 * connections but never answers CDP. Chromium listens on 127.0.0.1; on Windows
 * it binds with SO_EXCLUSIVEADDRUSE, which fails beside a holder of 0.0.0.0 or
 * ::, so only there are those probed too. Linux refuses the loopback bind
 * beside such a holder, and macOS grants it and routes loopback to Chromium.
 */
async function assertPortReleased(port: number, lead: string): Promise<void> {
  let held = await bindError(port, "127.0.0.1");
  // One at a time: a dual-stack :: bind collides with a concurrent 0.0.0.0 one.
  for (const host of process.platform === "win32" ? ["0.0.0.0", "::"] : []) {
    if (held) break;
    const err = await bindError(port, host);
    if (err?.code === "EADDRINUSE") held = err;
  }
  if (!held) return;
  throw new FailureError(
    `${lead}: port ${port} is still held ` +
      `(${held.code ?? held.message}), so a new copy could not bind it. Quit the ` +
      `process listening on port ${port}, then retry restart-app. It can be a process of the ` +
      `app that outlived the one Argent started, or a copy the app relaunched itself.`,
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
      `run booted it and stopped it at its end, or the tool-server restarted since the boot ` +
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

function bindError(port: number, host: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => resolve(err));
    srv.listen(port, host, () => srv.close(() => resolve(null)));
  });
}
