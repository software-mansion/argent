import * as net from "node:net";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { ChildProcess } from "node:child_process";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { pickIosHost, type IosEndpoint } from "../utils/ios-host";

// Re-export AX-pref helpers that used to live here so existing callers
// (boot-device, simulator-server) keep their import paths.
export {
  ensureAutomationEnabled,
  isEntitlementBypassActive,
  setAccessibilityPrefsPreBoot,
} from "../utils/ax-prefs";

export const AX_SERVICE_NAMESPACE = "AXService";

export type AXServiceTransport = "unix" | "tcp";

// Same DeviceInfo-via-options pattern as the other iOS-only blueprints.
type AxServiceFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
  transport?: AXServiceTransport;
};

/**
 * Build the `ServiceRef` for the AX service keyed by an already-resolved
 * `DeviceInfo`. The factory's iOS-only check uses the caller's classification
 * rather than running its own.
 */
export function axServiceRef(
  device: DeviceInfo,
  { transport = "unix" }: { transport?: AXServiceTransport } = {}
): {
  urn: string;
  options: AxServiceFactoryOptions;
} {
  const transportSuffix = transport === "tcp" ? ":tcp" : "";
  return {
    urn: `${AX_SERVICE_NAMESPACE}:${device.id}${transportSuffix}`,
    options: { device, transport },
  };
}

export interface AXDescribeElement {
  label?: string;
  frame?: { x: number; y: number; width: number; height: number };
  tapPoint?: { x: number; y: number };
  traits?: string[];
  value?: string;
}

export interface AXDescribeResponse {
  alertVisible: boolean;
  screenFrame?: { width: number; height: number };
  elements: AXDescribeElement[];
}

export interface AXServiceApi {
  /** True when AX prefs were written but SB hasn't picked them up yet (sim booted outside argent). */
  degraded: boolean;
  describe(): Promise<AXDescribeResponse>;
  alertCheck(): Promise<boolean>;
  ping(): Promise<boolean>;
}

function getSocketPath(udid: string): string {
  return `/tmp/ax-${udid.slice(0, 8)}.sock`;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Listen on the chosen transport. Unix: pre-unlink stale socket from previous
// runs so listen() doesn't EADDRINUSE. TCP: when `endpoint.port` is undefined,
// bind on an OS-assigned ephemeral port and write the realized port back into
// `endpoint.port` so each per-device instance gets its own non-colliding port.
function startListener(
  endpoint: IosEndpoint,
  onConnection: (socket: net.Socket) => void
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    if (endpoint.transport === "unix") {
      try {
        fs.unlinkSync(endpoint.socketPath);
      } catch {}
    }

    const server = net.createServer(onConnection);
    server.once("error", reject);

    const onListening = () => {
      server.off("error", reject);
      if (endpoint.transport === "tcp") {
        const addr = server.address();
        if (addr === null || typeof addr === "string") {
          server.close();
          reject(new Error("ax-service server failed to bind a TCP port"));
          return;
        }
        endpoint.port = addr.port;
      }
      resolve(server);
    };

    if (endpoint.transport === "tcp") {
      server.listen(endpoint.port ?? 0, "127.0.0.1", onListening);
    } else {
      server.listen(endpoint.socketPath, onListening);
    }
  });
}

// Wait for either the daemon's TCP/UDS connection or an early exit.
// Resolves with the connected socket; rejects on timeout or daemon failure.
function waitForDaemonConnection(
  server: net.Server,
  proc: ChildProcess,
  timeoutMs: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const onConnection = (socket: net.Socket) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };

    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`ax-service exited with code ${code} before connecting`));
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Timed out waiting for ax-service to connect"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      server.off("connection", onConnection);
      proc.off("exit", onExit);
      proc.off("error", onError);
    };

    server.on("connection", onConnection);
    proc.on("exit", onExit);
    proc.on("error", onError);
  });
}

export const axServiceBlueprint: ServiceBlueprint<AXServiceApi, DeviceInfo> = {
  namespace: AX_SERVICE_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${AX_SERVICE_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as AxServiceFactoryOptions | undefined;
    if (!opts?.device) {
      throw new Error(
        `${AX_SERVICE_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use axServiceRef(device) when registering the service ref.`
      );
    }

    const { device } = opts;
    if (device.platform !== "ios" && device.platform !== "ios-remote") {
      throw new Error(
        `${AX_SERVICE_NAMESPACE} is iOS-only. The target '${device.id}' classifies as Android — describe falls back to uiautomator on Android, which does not need this service.`
      );
    }
    // Reject before spawning. An undefined `device.id` slips through when an
    // inner tool is invoked via a wrapper that doesn't re-validate the inner
    // schema. Without this guard `getSocketPath(undefined).slice` would crash
    // and `udid.slice` in the stderr handler below would later be fatal.
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new Error(
        `${AX_SERVICE_NAMESPACE}.factory requires a non-empty device.id; got ${JSON.stringify(device.id)}.`
      );
    }

    const udid = device.id;
    const host = pickIosHost(device);
    // Force TCP on remote — unix sockets do not bridge across the QUIC tunnel
    // sim-remote sets up between the orchestrator and the dev's machine.
    const transport: AXServiceTransport = host.requiresTcp ? "tcp" : (opts.transport ?? "unix");
    const endpoint: IosEndpoint =
      transport === "tcp"
        ? { transport: "tcp" }
        : { transport: "unix", socketPath: getSocketPath(udid) };
    const events = new TypedEventEmitter<ServiceEvents>();

    const pendingRpc = new Map<number, PendingRpc>();
    let nextRpcId = 1;
    let daemonSocket: net.Socket | null = null;
    let disposed = false;

    const failPending = (err: Error): void => {
      for (const { reject, timer } of pendingRpc.values()) {
        clearTimeout(timer);
        reject(err);
      }
      pendingRpc.clear();
    };

    const { entitlementBypassActive } = await host.bootstrapAx(udid);

    // Host listens first, then we spawn the daemon and wait for it to dial in.
    const server = await startListener(endpoint, (socket) => {
      if (daemonSocket && !daemonSocket.destroyed) {
        // A second connection (e.g. respawned daemon) replaces the previous one.
        daemonSocket.destroy();
      }
      daemonSocket = socket;

      const rl = readline.createInterface({ input: socket });
      rl.on("line", (raw) => {
        let msg: { id?: number; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }
        if (typeof msg.id !== "number") return;
        const pending = pendingRpc.get(msg.id);
        if (!pending) return;
        pendingRpc.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error !== undefined && msg.error !== null) {
          pending.reject(
            new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error))
          );
        } else {
          pending.resolve(msg.result);
        }
      });

      socket.on("close", () => {
        rl.close();
        if (daemonSocket === socket) {
          daemonSocket = null;
          if (!disposed) {
            const err = new Error("ax-service daemon disconnected");
            failPending(err);
            events.emit("terminated", err);
          }
        }
      });

      socket.on("error", () => {
        // close handler does the cleanup
      });
    });

    if (endpoint.transport === "tcp") {
      // Wire the reverse tunnel BEFORE asking the orchestrator to start the
      // daemon — the daemon will dial 127.0.0.1:<port> inside the simulator
      // and that dial gets QUIC-forwarded back to our host listener above.
      // No-op on local. `port` was populated by startListener.
      await host.startProxy(udid, endpoint.port!);
    }

    const proc = host.spawnAxDaemon(udid, endpoint);

    proc.on("exit", (code) => {
      if (disposed) return;
      const err = new Error(`ax-service exited with code ${code}`);
      failPending(err);
      events.emit("terminated", err);
    });
    proc.on("error", (err) => {
      if (disposed) return;
      failPending(err);
      events.emit("terminated", err);
    });

    try {
      daemonSocket = await waitForDaemonConnection(server, proc, 10_000);
    } catch (err) {
      // Tear down whatever started so we don't leak a server or process.
      if (!proc.killed) proc.kill("SIGTERM");
      server.close();
      if (endpoint.transport === "unix") {
        try {
          fs.unlinkSync(endpoint.socketPath);
        } catch {}
      }
      if (endpoint.transport === "tcp") {
        await host.stopProxy(udid, endpoint.port!);
      }
      throw err;
    }

    function query(command: string, timeoutMs = 5000): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (!daemonSocket || daemonSocket.destroyed) {
          reject(new Error("ax-service not connected"));
          return;
        }
        const id = nextRpcId++;
        const timer = setTimeout(() => {
          if (pendingRpc.has(id)) {
            pendingRpc.delete(id);
            reject(new Error(`ax-service query timed out: ${command}`));
          }
        }, timeoutMs);
        pendingRpc.set(id, { resolve, reject, timer });
        daemonSocket.write(JSON.stringify({ id, command }) + "\n");
      });
    }

    const api: AXServiceApi = {
      degraded: !entitlementBypassActive,

      async describe(): Promise<AXDescribeResponse> {
        const result = (await query("describe", 10_000)) as AXDescribeResponse;
        return {
          alertVisible: result.alertVisible ?? false,
          screenFrame: result.screenFrame,
          elements: result.elements ?? [],
        };
      },

      async alertCheck(): Promise<boolean> {
        const result = (await query("alert_check")) as { alertVisible?: boolean };
        return result.alertVisible ?? false;
      },

      async ping(): Promise<boolean> {
        try {
          const result = (await query("ping", 2000)) as { status?: string };
          return result.status === "ok";
        } catch {
          return false;
        }
      },
    };

    const instance: ServiceInstance<AXServiceApi> = {
      api,
      dispose: async () => {
        disposed = true;
        failPending(new Error("ax-service disposed"));
        if (daemonSocket && !daemonSocket.destroyed) {
          daemonSocket.destroy();
        }
        if (proc && !proc.killed) {
          proc.kill("SIGTERM");
        }
        server.close();
        if (endpoint.transport === "unix") {
          try {
            fs.unlinkSync(endpoint.socketPath);
          } catch {}
        }
        if (endpoint.transport === "tcp") {
          await host.stopProxy(udid, endpoint.port!);
        }
      },
      events,
    };

    return instance;
  },
};
