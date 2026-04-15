import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
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

type InspectorMethod = ViewInspectorMethod | "Application.getState";

export type NativeApplicationState = "active" | "inactive" | "background" | "unknown";

export interface NativeAppState {
  bundleId: string;
  applicationState: NativeApplicationState;
  foregroundActiveSceneCount: number;
  foregroundInactiveSceneCount: number;
  backgroundSceneCount: number;
  unattachedSceneCount: number;
  isFrontmostCandidate: boolean;
}

export interface NativeDevtoolsApi {
  // Simulator-level
  isEnvSetup(): boolean;
  readonly socketPath: string;
  ensureEnvReady(): Promise<void>;

  // App-level — all keyed by bundleId
  isConnected(bundleId: string): boolean;
  isAppRunning(bundleId: string): Promise<boolean>;
  listConnectedBundleIds(): string[];
  /**
   * Conservative helper for native feature tools.
   * Returns false only when the current running app process is already connected.
   * When not connected it re-verifies and re-sets the launchd env, which handles
   * the simulator-reboot case where DYLD_INSERT_LIBRARIES was silently cleared.
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
  getAppState(bundleId: string): Promise<NativeAppState>;
  detectFrontmostBundleId(): Promise<string | null>;
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

/** Current bootstrap filename; `libInjectionBootstrap.dylib` is legacy (pre-rename) and still stripped when merging env. */
const ARGENT_BOOTSTRAP_DYLIB_BASENAMES = new Set([
  "libArgentInjectionBootstrap.dylib",
  "libInjectionBootstrap.dylib",
]);

function getNativeDevtoolsSocketPath(udid: string): string {
  // Deterministic, short — well under the 104-char macOS Unix socket limit
  // /tmp/argent-nd-XXXXXXXX.sock = 28 chars
  return `/tmp/argent-nd-${udid.slice(0, 8)}.sock`;
}

function splitDyldInsertLibraries(value: string): string[] {
  return value
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Strips Argent bootstrap dylibs (by basename, including the legacy pre-rename name)
 * and entries that don't exist on disk (truncated artifacts from the simctl getenv
 * 127-byte bug, stale paths from old installs, etc.).
 * Entries starting with '@' (loader-path references) are always preserved.
 * Third-party dylibs present on disk (e.g. SimCam) are kept verbatim.
 */
function shouldPreserveDyldInsertLibrariesEntry(entry: string, bootstrapPath: string): boolean {
  if (entry === bootstrapPath) {
    return false;
  }

  if (ARGENT_BOOTSTRAP_DYLIB_BASENAMES.has(path.basename(entry))) {
    return false;
  }

  if (entry.startsWith("@")) {
    return true;
  }

  return fs.existsSync(entry);
}

export function buildDyldInsertLibraries(currentValue: string, bootstrapPath: string): string {
  const preserved = splitDyldInsertLibraries(currentValue).filter((entry) =>
    shouldPreserveDyldInsertLibrariesEntry(entry, bootstrapPath)
  );
  return [...preserved, bootstrapPath].join(":");
}

async function ensureAccessibilityEnabled(udid: string): Promise<void> {
  // iOS 26+ requires AccessibilityEnabled and ApplicationAccessibilityEnabled to be set
  // in the simulator's defaults for SwiftUI to populate the accessibility tree.
  // Without these flags, all UIAccessibility APIs return nil/0 for SwiftUI views.
  const flags = ["AccessibilityEnabled", "ApplicationAccessibilityEnabled"];
  await Promise.all(
    flags.map((flag) =>
      execFileAsync("xcrun", [
        "simctl",
        "spawn",
        udid,
        "defaults",
        "write",
        "com.apple.Accessibility",
        flag,
        "-bool",
        "true",
      ])
    )
  );
}

async function ensureEnv(udid: string, socketPath: string): Promise<void> {
  const bootstrapPath = bootstrapDylibPath();

  // Read from launchctl inside the simulator (via simctl spawn) instead of
  // `simctl getenv`. The latter silently truncates values longer than 127 bytes,
  // which corrupts the colon-separated path list and causes stale entries to
  // accumulate on every ensureEnv() cycle.
  const result = await execFileAsync(
    "xcrun",
    ["simctl", "spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
    { encoding: "utf8" }
  ).catch((e) => ({ stdout: (e as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "" }));

  const existing = (result.stdout ?? "").trim();
  const updated = buildDyldInsertLibraries(existing, bootstrapPath);

  if (updated !== existing) {
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

  // Ensure the accessibility runtime is enabled so that describeScreen works on iOS 26+.
  await ensureAccessibilityEnabled(udid);
}

async function listRunningUIKitApplicationBundleIds(udid: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], {
    encoding: "utf8",
  });

  const bundleIds = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/UIKitApplication:([^\[]+)/);
    if (match) {
      bundleIds.add(match[1].trim());
    }
  }
  return bundleIds;
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

    const ensureEnvReady = async (): Promise<void> => {
      await ensureEnv(udid, socketPath);
      envSetup = true;
    };

    const isAppRunning = async (bundleId: string): Promise<boolean> => {
      const runningBundleIds = await listRunningUIKitApplicationBundleIds(udid);
      return runningBundleIds.has(bundleId);
    };

    function sendViewInspectorRpc(
      targetBundleId: string,
      method: InspectorMethod,
      params: Record<string, unknown> = {}
    ): Promise<unknown> {
      const conn = connections.get(targetBundleId);
      if (!conn) {
        return Promise.reject(
          new Error("Native devtools not connected for bundleId: " + targetBundleId)
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
    }

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
    await ensureEnvReady();

    // ── Public API ────────────────────────────────────────────────────────────
    const api: NativeDevtoolsApi = {
      isEnvSetup: () => envSetup,
      socketPath,
      ensureEnvReady,

      isConnected: (bundleId) => connections.has(bundleId),
      isAppRunning,
      listConnectedBundleIds: () => [...connections.keys()],

      async requiresAppRestart(bundleId) {
        if (connections.has(bundleId)) return false;
        // Re-verify and re-set env — handles the case where the simulator was
        // rebooted and launchd cleared DYLD_INSERT_LIBRARIES
        await ensureEnvReady();
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

      async getAppState(bundleId) {
        const result = (await sendViewInspectorRpc(bundleId, "Application.getState")) as {
          applicationState?: NativeApplicationState;
          foregroundActiveSceneCount?: number;
          foregroundInactiveSceneCount?: number;
          backgroundSceneCount?: number;
          unattachedSceneCount?: number;
          isFrontmostCandidate?: boolean;
        };
        return {
          bundleId,
          applicationState: result.applicationState ?? "unknown",
          foregroundActiveSceneCount: result.foregroundActiveSceneCount ?? 0,
          foregroundInactiveSceneCount: result.foregroundInactiveSceneCount ?? 0,
          backgroundSceneCount: result.backgroundSceneCount ?? 0,
          unattachedSceneCount: result.unattachedSceneCount ?? 0,
          isFrontmostCandidate: result.isFrontmostCandidate ?? false,
        };
      },

      async detectFrontmostBundleId() {
        const bundleIds = [...connections.keys()];
        if (bundleIds.length === 0) return null;

        const states = await Promise.all(
          bundleIds.map(async (bundleId) => {
            try {
              return await api.getAppState(bundleId);
            } catch {
              return null;
            }
          })
        );

        const appStates = states.filter((state): state is NativeAppState => state !== null);
        const strongCandidates = appStates.filter(
          (state) => state.applicationState === "active" || state.foregroundActiveSceneCount > 0
        );
        if (strongCandidates.length === 1) {
          return strongCandidates[0].bundleId;
        }

        const weakCandidates = appStates.filter(
          (state) => state.applicationState === "inactive" || state.foregroundInactiveSceneCount > 0
        );
        if (strongCandidates.length === 0 && weakCandidates.length === 1) {
          return weakCandidates[0].bundleId;
        }

        return null;
      },

      queryViewHierarchy(bundleId, method, params = {}) {
        return sendViewInspectorRpc(bundleId, method, params);
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
