import * as net from "node:net";
import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { promisify } from "node:util";
import { execFile, ChildProcess } from "node:child_process";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { axServiceBinaryPath, axServiceBinaryPathTcp } from "@argent/native-devtools-ios";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "../utils/simctl-config";
import { activeIosDeviceSetPath, simctlArgs } from "../utils/simctl";

const execFileAsync = promisify(execFile);

export const AX_SERVICE_NAMESPACE = "AXService";

export type AXServiceTransport = "unix" | "tcp";

export const AX_SERVICE_TCP_PORT = Number(process.env.AX_SERVICE_TCP_PORT) || 9231;

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

type AXEndpoint = { transport: "unix"; socketPath: string } | { transport: "tcp"; port: number };

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export async function ensureAutomationEnabled(udid: string): Promise<void> {
  await execFileAsync(
    "xcrun",
    simctlArgs([
      "spawn",
      udid,
      "defaults",
      "write",
      "com.apple.Accessibility",
      "AutomationEnabled",
      "-bool",
      "true",
    ]),
    { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
  );
}

/**
 * Check whether `IgnoreAXServerEntitlements` is active on this sim.
 *
 * iOS 26.5+: SB's AX server rejects unentitled MIG clients with
 * kAXError -25215. The pref disables the check, but SB caches it at
 * init — writing it post-boot has no effect until the next restart.
 * The only effective path is the pre-boot plist write in boot-device.
 *
 * This read-only probe tells the caller whether the pre-boot write
 * happened so describe can surface a degraded-quality hint when it didn't.
 */
export async function isEntitlementBypassActive(udid: string): Promise<boolean> {
  return execFileAsync(
    "xcrun",
    simctlArgs([
      "spawn",
      udid,
      "defaults",
      "read",
      "com.apple.Accessibility",
      "IgnoreAXServerEntitlements",
    ]),
    { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
  )
    .then(({ stdout }) => stdout.trim() === "1")
    .catch(() => false);
}

/**
 * Host-side `com.apple.Accessibility` plist inside the sim's data container.
 * Writeable while Shutdown; in-sim cfprefsd overwrites it once Booted.
 */
function accessibilityPlistPath(udid: string): string {
  return path.join(
    activeIosDeviceSetPath(),
    udid,
    "data/Library/Preferences/com.apple.Accessibility.plist"
  );
}

/**
 * Write the four AX prefs to the sim's host plist BEFORE `simctl boot` so SB
 * caches them at AX-server init and never needs the disruptive kickstart
 * (which kills the foreground app and dismisses in-flight system alerts).
 *
 * All four are required on a freshly-erased sim:
 * - `IgnoreAXServerEntitlements` bypasses the iOS 26.5+ kAXErrorNotEntitled check.
 * - `AutomationEnabled` opts the simctl-spawned ax-service in as an AX client.
 * - `AccessibilityEnabled` + `ApplicationAccessibilityEnabled` gate the AT
 *   subsystem bootstrap. Without them SB never spawns `AccessibilityUIServer`
 *   and describe returns an empty ROOT even though the entitlement check passes
 *   (reproduced on a wiped iPhone 17e: AccessibilityUIServer active count = 0
 *   without these two; auto-spawns at boot with them).
 *
 * Caller must ensure the sim is Shutdown — in-sim cfprefsd would otherwise
 * overwrite this file on flush.
 */
export async function setAccessibilityPrefsPreBoot(udid: string): Promise<void> {
  const plistPath = accessibilityPlistPath(udid);
  await fsAsync.mkdir(path.dirname(plistPath), { recursive: true });
  const exists = await fsAsync
    .access(plistPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await execFileAsync("plutil", ["-create", "binary1", plistPath]);
  }
  for (const key of [
    "AutomationEnabled",
    "IgnoreAXServerEntitlements",
    "AccessibilityEnabled",
    "ApplicationAccessibilityEnabled",
  ]) {
    await execFileAsync("plutil", ["-replace", key, "-bool", "true", plistPath]);
  }
}

// Listen on the chosen transport. Unix: pre-unlink stale socket from previous
// runs so listen() doesn't EADDRINUSE.
function startListener(
  endpoint: AXEndpoint,
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
      resolve(server);
    };

    if (endpoint.transport === "tcp") {
      server.listen(endpoint.port, "127.0.0.1", onListening);
    } else {
      server.listen(endpoint.socketPath, onListening);
    }
  });
}

function spawnDaemon(udid: string, endpoint: AXEndpoint): ChildProcess {
  const binaryPath =
    endpoint.transport === "tcp" ? axServiceBinaryPathTcp() : axServiceBinaryPath();

  const endpointArgs =
    endpoint.transport === "tcp"
      ? ["--port", String(endpoint.port)]
      : ["--socket", endpoint.socketPath];

  const proc = execFile(
    "xcrun",
    simctlArgs(["spawn", udid, binaryPath, ...endpointArgs, "--timeout", "3600"]),
    { encoding: "utf8" }
  ) as ChildProcess;

  // Defense-in-depth: a missing udid here would crash the process —
  // throwing inside an async listener bypasses promise rejection and
  // bubbles up as `uncaughtException`, which the tool-server treats as
  // fatal. Tag with "?" instead of dereferencing.
  const udidTag = typeof udid === "string" && udid.length > 0 ? udid.slice(0, 8) : "?";
  proc.stderr?.on("data", (data: string) => {
    process.stderr.write(`[ax-service ${udidTag}] ${data}`);
  });

  return proc;
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
    if (device.platform !== "ios") {
      throw new Error(
        `${AX_SERVICE_NAMESPACE} is iOS-only. The target '${device.id}' classifies as ${device.platform} — describe uses uiautomator on Android and the CDP DOM walker on Chromium, neither of which needs this service.`
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
    const transport: AXServiceTransport = opts.transport ?? "unix";
    const endpoint: AXEndpoint =
      transport === "tcp"
        ? { transport: "tcp", port: AX_SERVICE_TCP_PORT }
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

    await ensureAutomationEnabled(udid);
    const entitlementBypassActive = await isEntitlementBypassActive(udid);

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

    const proc = spawnDaemon(udid, endpoint);

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
        } catch {
          /* best-effort socket cleanup; ignore errors */
        }
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
          } catch {
            /* best-effort socket cleanup; ignore errors */
          }
        }
      },
      events,
    };

    return instance;
  },
};
