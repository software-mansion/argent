import * as net from "node:net";
import * as fs from "node:fs";
import * as readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TypedEventEmitter, type ServiceBlueprint, type ServiceEvents } from "@argent/registry";
import { bootstrapDylibPath } from "@argent/native-devtools-ios";

const execFileAsync = promisify(execFile);

export const NATIVE_DEVTOOLS_NAMESPACE = "NativeDevtools";

export interface NetworkEvent {
  method: string;
  params: unknown;
  timestamp: number;
}

export type ViewInspectorMethod =
  | "ViewHierarchy.getFullHierarchy"
  | "ViewHierarchy.findViews"
  | "ViewHierarchy.viewAtPoint"
  | "ViewHierarchy.userInteractableViewAtPoint"
  | "ViewHierarchy.describeScreen";

export interface NativeDevtoolsApi {
  // Simulator-level
  isEnvSetup(): boolean;
  readonly socketPath: string;

  // App-level — all keyed by bundleId
  isConnected(bundleId: string): boolean;
  /**
   * Returns true if the app needs to be restarted before native features are available.
   * Async because when not connected it re-verifies and re-sets the launchd env —
   * this handles the simulator-reboot case where DYLD_INSERT_LIBRARIES was silently cleared.
   */
  requiresAppRestart(bundleId: string): Promise<boolean>;
  /**
   * Activates NSURLProtocol network interception for a specific app.
   * Idempotent — safe to call multiple times. Sticky: if the app is killed
   * and relaunched, network inspection is automatically re-enabled on reconnect.
   */
  activateNetworkInspection(bundleId: string): void;
  getNetworkLog(bundleId: string): NetworkEvent[];
  clearNetworkLog(bundleId: string): void;
  queryViewHierarchy(
    bundleId: string,
    method: ViewInspectorMethod,
    params?: Record<string, unknown>
  ): Promise<unknown>;
}

interface AppConnection {
  socket: net.Socket;
  networkLog: NetworkEvent[];
}

function getNativeDevtoolsSocketPath(udid: string): string {
  // Deterministic, short — well under the 104-char macOS Unix socket limit
  // /tmp/argent-nd-XXXXXXXX.sock = 28 chars
  return `/tmp/argent-nd-${udid.slice(0, 8)}.sock`;
}

async function ensureEnv(udid: string, socketPath: string): Promise<void> {
  const bootstrapPath = bootstrapDylibPath();

  // xcrun simctl getenv exits non-zero when the var is unset — suppress rejection
  const result = await execFileAsync("xcrun", ["simctl", "getenv", udid, "DYLD_INSERT_LIBRARIES"], {
    encoding: "utf8",
  }).catch((e) => ({ stdout: (e as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "" }));

  const existing = (result.stdout ?? "").trim();
  const entries = existing ? existing.split(":") : [];

  if (!entries.includes(bootstrapPath)) {
    const updated = [...entries, bootstrapPath].join(":");
    await execFileAsync("xcrun", [
      "simctl",
      "spawn",
      udid,
      "launchctl",
      "setenv",
      "DYLD_INSERT_LIBRARIES",
      updated,
    ]);
  }

  // Always re-set the socket path — deterministic value, cheap no-op if already correct,
  // ensures correctness after tool-server restarts.
  await execFileAsync("xcrun", [
    "simctl",
    "spawn",
    udid,
    "launchctl",
    "setenv",
    "NATIVE_DEVTOOLS_IOS_CDP_SOCKET",
    socketPath,
  ]);
}

export const nativeDevtoolsBlueprint: ServiceBlueprint<NativeDevtoolsApi, string> = {
  namespace: NATIVE_DEVTOOLS_NAMESPACE,

  getURN(udid: string) {
    return `${NATIVE_DEVTOOLS_NAMESPACE}:${udid}`;
  },

  async factory(_deps, udid) {
    const socketPath = getNativeDevtoolsSocketPath(udid);
    const MAX_LOG_ENTRIES = 1000;
    const connections = new Map<string, AppConnection>();
    const pendingRpc = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    let nextRpcId = 1;
    let envSetup = false;

    const activatedBundleIds = new Set<string>();
    const events = new TypedEventEmitter<ServiceEvents>();

    // Remove stale socket file from a crashed previous run
    try {
      fs.unlinkSync(socketPath);
    } catch {}

    // ── Socket server ─────────────────────────────────────────────────────────
    const server = net.createServer((socket) => {
      let bundleId: string | null = null;
      const rl = readline.createInterface({ input: socket });

      rl.on("line", (raw) => {
        let msg: { type: string; payload: any };
        try {
          msg = JSON.parse(raw);
        } catch {
          return;
        }

        // ── Handshake (must be first message) ──
        if (bundleId === null) {
          if (msg.type !== "Control") return;
          bundleId = msg.payload.bundleId as string;

          // If the same app reconnects (e.g. fast restart), close the old socket
          const existing = connections.get(bundleId);
          if (existing) {
            existing.socket.destroy();
          }

          connections.set(bundleId, { socket, networkLog: [] });

          // Re-activate network inspection if it was previously enabled for this app
          if (activatedBundleIds.has(bundleId)) {
            socket.write(
              JSON.stringify({
                type: "Control",
                payload: { command: "activateNetworkInspection" },
              }) + "\n"
            );
          }
          return;
        }

        // ── CDP Network.* events ──
        if (msg.type === "CDP") {
          const p = msg.payload;
          // Unsolicited events have method but no id
          if (p.method && p.id === undefined) {
            const conn = connections.get(bundleId);
            if (conn) {
              if (conn.networkLog.length >= MAX_LOG_ENTRIES) {
                conn.networkLog.shift();
              }
              conn.networkLog.push({
                method: p.method,
                params: p.params,
                timestamp: Date.now(),
              });
            }
          }
        }

        // ── ViewInspector RPC responses ──
        if (msg.type === "ViewInspector") {
          const p = msg.payload;
          const pending = pendingRpc.get(p.id);
          if (!pending) return;
          pendingRpc.delete(p.id);
          if (p.error) pending.reject(new Error(p.error.message));
          else pending.resolve(p.result);
        }
      });

      socket.on("close", () => {
        rl.close();
        if (bundleId !== null) {
          // Only delete if this socket is still the active one —
          // a fast reconnect may have already replaced it
          if (connections.get(bundleId)?.socket === socket) {
            connections.delete(bundleId);
          }
        }
      });

      socket.on("error", () => {
        // errors are handled via the close event
      });
    });

    server.listen(socketPath);

    // ── ensureEnv — runs once at factory init ─────────────────────────────────
    await ensureEnv(udid, socketPath);
    envSetup = true;

    // ── Public API ────────────────────────────────────────────────────────────
    const api: NativeDevtoolsApi = {
      isEnvSetup: () => envSetup,
      socketPath,

      isConnected: (bundleId) => connections.has(bundleId),

      async requiresAppRestart(bundleId) {
        if (connections.has(bundleId)) return false;
        // Re-verify and re-set env — handles the case where the simulator was
        // rebooted and launchd cleared DYLD_INSERT_LIBRARIES
        await ensureEnv(udid, socketPath);
        return true;
      },

      activateNetworkInspection(bundleId) {
        activatedBundleIds.add(bundleId);
        const conn = connections.get(bundleId);
        if (conn) {
          conn.socket.write(
            JSON.stringify({
              type: "Control",
              payload: { command: "activateNetworkInspection" },
            }) + "\n"
          );
        }
      },

      getNetworkLog: (bundleId) => [...(connections.get(bundleId)?.networkLog ?? [])],

      clearNetworkLog: (bundleId) => {
        const conn = connections.get(bundleId);
        if (conn) conn.networkLog.length = 0;
      },

      queryViewHierarchy(bundleId, method, params = {}) {
        const conn = connections.get(bundleId);
        if (!conn) {
          return Promise.reject(
            new Error("Native devtools not connected for bundleId: " + bundleId)
          );
        }
        const id = nextRpcId++;
        return new Promise((resolve, reject) => {
          pendingRpc.set(id, { resolve, reject });
          conn.socket.write(
            JSON.stringify({
              type: "ViewInspector",
              payload: { id, method, params },
            }) + "\n"
          );
          setTimeout(() => {
            if (pendingRpc.has(id)) {
              pendingRpc.delete(id);
              reject(new Error(`ViewInspector RPC timed out: ${method}`));
            }
          }, 5000);
        });
      },
    };

    return {
      api,
      dispose: async () => {
        for (const { socket } of connections.values()) {
          socket.destroy();
        }
        connections.clear();
        activatedBundleIds.clear();
        server.close();
        try {
          fs.unlinkSync(socketPath);
        } catch {}
        for (const { reject } of pendingRpc.values()) {
          reject(new Error("NativeDevtools service disposed"));
        }
        pendingRpc.clear();
      },
      events,
    };
  },
};
