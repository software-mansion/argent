import * as net from "node:net";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { ChildProcess } from "node:child_process";
import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { pickIosHost, type IosEndpoint } from "../utils/ios-host";

// Moved to ../utils/ax-prefs; re-exported so existing import paths keep working.
export {
  ensureAutomationEnabled,
  isEntitlementBypassActive,
  setAccessibilityPrefsPreBoot,
} from "../utils/ax-prefs";

export const AX_SERVICE_NAMESPACE = "AXService";

export type AXServiceTransport = "unix" | "tcp";

type AxServiceFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
  transport?: AXServiceTransport;
};

/**
 * `ServiceRef` keyed by an already-resolved `DeviceInfo` — the factory's
 * iOS-only check trusts that classification instead of re-running it.
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
  identifier?: string;
}

export interface AXDescribeResponse {
  alertVisible: boolean;
  screenFrame?: { width: number; height: number };
  elements: AXDescribeElement[];
}

export interface AXServiceApi {
  /** Entitlement bypass isn't active (sim booted outside argent) — AX reads may come back empty. */
  degraded: boolean;
  /**
   * `timeoutMs` bounds the read (default {@link DEFAULT_DESCRIBE_TIMEOUT_MS}).
   * A read that times out also retires the daemon: it handles requests
   * serially, so the stuck walk would otherwise hold every later read too.
   */
  describe(opts?: { timeoutMs?: number }): Promise<AXDescribeResponse>;
  alertCheck(): Promise<boolean>;
  ping(): Promise<boolean>;
}

export const DEFAULT_DESCRIBE_TIMEOUT_MS = 10_000;

function getSocketPath(udid: string): string {
  return `/tmp/ax-${udid.slice(0, 8)}.sock`;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Unix: pre-unlink a stale socket so listen() doesn't EADDRINUSE. TCP: an
// undefined `endpoint.port` binds an ephemeral port, written back into
// `endpoint.port` so per-device instances don't collide.
function startListener(
  endpoint: IosEndpoint,
  onConnection: (socket: net.Socket) => void
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    if (endpoint.transport === "unix") {
      try {
        fs.unlinkSync(endpoint.socketPath);
      } catch {
        /* no stale socket to remove; ignore */
      }
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
      reject(
        new FailureError(`ax-service exited with code ${code} before connecting`, {
          error_code: FAILURE_CODES.AX_DAEMON_EXITED_BEFORE_READY,
          failure_stage: "ax_service_spawn_ready",
          failure_area: "tool_server",
          error_kind: "subprocess",
        })
      );
    };

    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new FailureError(
          err instanceof Error ? err.message : String(err),
          {
            error_code: FAILURE_CODES.AX_DAEMON_PROCESS_ERROR,
            failure_stage: "ax_service_spawn_process",
            failure_area: "tool_server",
            error_kind: "subprocess",
          },
          { cause: err instanceof Error ? err : new Error(String(err)) }
        )
      );
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new FailureError("Timed out waiting for ax-service to connect", {
          error_code: FAILURE_CODES.AX_DAEMON_READY_TIMEOUT,
          failure_stage: "ax_service_spawn_ready",
          failure_area: "tool_server",
          error_kind: "timeout",
        })
      );
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
      throw new FailureError(
        `${AX_SERVICE_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use axServiceRef(device) when registering the service ref.`,
        {
          error_code: FAILURE_CODES.AX_FACTORY_OPTIONS_MISSING,
          failure_stage: "ax_service_factory_options",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const { device } = opts;
    if (device.platform !== "ios" && device.platform !== "ios-remote") {
      throw new FailureError(
        `${AX_SERVICE_NAMESPACE} is iOS-only. The target '${device.id}' classifies as ${device.platform} — describe uses uiautomator on Android and the CDP DOM walker on Chromium, neither of which needs this service.`,
        {
          error_code: FAILURE_CODES.AX_WRONG_PLATFORM,
          failure_stage: "ax_service_factory_platform",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }
    if (typeof device.id !== "string" || device.id.length === 0) {
      throw new FailureError(
        `${AX_SERVICE_NAMESPACE}.factory requires a non-empty device.id; got ${JSON.stringify(device.id)}.`,
        {
          error_code: FAILURE_CODES.AX_DEVICE_ID_INVALID,
          failure_stage: "ax_service_factory_device_id",
          failure_area: "tool_server",
          error_kind: "validation",
        }
      );
    }

    const udid = device.id;
    const host = pickIosHost(device);
    // Unix sockets don't bridge the sim-remote tunnel, so remote is TCP-only.
    const transport: AXServiceTransport = host.requiresTcp ? "tcp" : (opts.transport ?? "unix");
    const endpoint: IosEndpoint =
      transport === "tcp"
        ? { transport: "tcp" }
        : { transport: "unix", socketPath: getSocketPath(udid) };
    const events = new TypedEventEmitter<ServiceEvents>();

    const pendingRpc = new Map<number, PendingRpc>();
    let nextRpcId = 1;
    // Highest request id the daemon has answered, including answers to requests
    // whose caller had already given up. Ids are handed out in send order and
    // the daemon replies in that order, so an answer to a LATER id proves the
    // daemon got past the request whose timer is firing: slow, not stuck.
    let lastAnsweredId = 0;
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

    // Listen before spawning; the daemon dials in.
    const server = await startListener(endpoint, (socket) => {
      if (daemonSocket && !daemonSocket.destroyed) {
        // Respawned daemon: the newest connection wins.
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
        lastAnsweredId = Math.max(lastAnsweredId, msg.id);
        const pending = pendingRpc.get(msg.id);
        if (!pending) return;
        pendingRpc.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error !== undefined && msg.error !== null) {
          pending.reject(
            new FailureError(
              typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error),
              {
                error_code: FAILURE_CODES.AX_QUERY_FAILED,
                failure_stage: "ax_service_query_rpc",
                failure_area: "tool_server",
                error_kind: "unknown",
              }
            )
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
            const err = new FailureError("ax-service daemon disconnected", {
              error_code: FAILURE_CODES.AX_DAEMON_PROCESS_ERROR,
              failure_stage: "ax_service_socket_close",
              failure_area: "tool_server",
              error_kind: "subprocess",
            });
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
      // Tunnel before spawn: the daemon dials 127.0.0.1:<port> inside the sim and
      // the tunnel forwards it back to the listener above. No-op on local;
      // `port` was populated by startListener.
      await host.startProxy(udid, endpoint.port!);
    }

    const proc = host.spawnAxDaemon(udid, endpoint);

    // The daemon answers requests one at a time, so a `describe` that never
    // returns (the app's main thread is pinned and the AX walk into it blocks)
    // holds every request queued behind it until the walk ends — measured at a
    // full 10s per queued read. Retiring the instance fails the queue at once
    // and lets the next resolve spawn a fresh daemon (~1s), instead of every
    // read paying the timeout in turn. Skipped when the daemon has answered a
    // later request by the time the timer fires: then it was merely slow, and
    // killing it would cut a healthy read that is in flight right now.
    const retireAfterTimeout = (id: number, err: FailureError): void => {
      if (disposed || lastAnsweredId > id) return;
      disposed = true;
      failPending(err);
      if (daemonSocket && !daemonSocket.destroyed) daemonSocket.destroy();
      if (!proc.killed) proc.kill("SIGTERM");
      events.emit("terminated", err);
    };

    proc.on("exit", (code) => {
      if (disposed) return;
      const err = new FailureError(`ax-service exited with code ${code}`, {
        error_code: FAILURE_CODES.AX_DAEMON_PROCESS_ERROR,
        failure_stage: "ax_service_process_exit",
        failure_area: "tool_server",
        error_kind: "subprocess",
      });
      failPending(err);
      events.emit("terminated", err);
    });
    proc.on("error", (err) => {
      if (disposed) return;
      const error = new FailureError(
        err instanceof Error ? err.message : String(err),
        {
          error_code: FAILURE_CODES.AX_DAEMON_PROCESS_ERROR,
          failure_stage: "ax_service_spawn_process",
          failure_area: "tool_server",
          error_kind: "subprocess",
        },
        { cause: err instanceof Error ? err : new Error(String(err)) }
      );
      failPending(error);
      events.emit("terminated", error);
    });

    try {
      daemonSocket = await waitForDaemonConnection(server, proc, 10_000);
    } catch (err) {
      // Don't leak the listener or the daemon.
      if (!proc.killed) proc.kill("SIGTERM");
      server.close();
      if (endpoint.transport === "unix") {
        try {
          fs.unlinkSync(endpoint.socketPath);
        } catch {
          /* best-effort socket cleanup */
        }
      }
      if (endpoint.transport === "tcp") {
        await host.stopProxy(udid, endpoint.port!);
      }
      throw err;
    }

    function query(command: string, timeoutMs = 5000): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (!daemonSocket || daemonSocket.destroyed) {
          reject(
            new FailureError("ax-service not connected", {
              error_code: FAILURE_CODES.AX_QUERY_FAILED,
              failure_stage: "ax_service_query_socket",
              failure_area: "tool_server",
              error_kind: "subprocess",
            })
          );
          return;
        }
        const id = nextRpcId++;
        const timer = setTimeout(() => {
          if (pendingRpc.has(id)) {
            pendingRpc.delete(id);
            const err = new FailureError(`ax-service query timed out: ${command}`, {
              error_code: FAILURE_CODES.AX_QUERY_TIMEOUT,
              failure_stage: "ax_service_query_socket",
              failure_area: "tool_server",
              error_kind: "timeout",
            });
            reject(err);
            if (command === "describe") retireAfterTimeout(id, err);
          }
        }, timeoutMs);
        pendingRpc.set(id, { resolve, reject, timer });
        daemonSocket.write(JSON.stringify({ id, command }) + "\n");
      });
    }

    const api: AXServiceApi = {
      degraded: !entitlementBypassActive,

      async describe(opts): Promise<AXDescribeResponse> {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_DESCRIBE_TIMEOUT_MS;
        const result = (await query("describe", timeoutMs)) as AXDescribeResponse & {
          error?: string;
        };
        if (result.error) {
          throw new FailureError(`ax-service describe error: ${result.error}`, {
            error_code: FAILURE_CODES.AX_DESCRIBE_ERROR,
            failure_stage: "ax_service_describe",
            failure_area: "tool_server",
            error_kind: "unknown",
          });
        }
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
          } catch {
            /* best-effort socket cleanup */
          }
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
