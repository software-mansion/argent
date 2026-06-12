import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  TypedEventEmitter,
  type DeviceInfo,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { bootstrapDylibPath, bootstrapDylibPathTcp, bootstrapDylibPathTvos } from "@argent/native-devtools-ios";
import { isTvOsSimulator } from "../utils/ios-devices";
import { SIMCTL_SPAWN_TIMEOUT_MS } from "../utils/simctl-config";

export type NativeDevtoolsTransport = "unix" | "tcp";

export const NATIVE_DEVTOOLS_TCP_PORT = Number(process.env.NATIVE_DEVTOOLS_TCP_PORT) || 9230;

const execFileAsync = promisify(execFile);

export const NATIVE_DEVTOOLS_NAMESPACE = "NativeDevtools";

// Max consecutive init failures per service instance before it stops retrying.
export const MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS = 3;

export interface NativeDevtoolsInitFailure {
  attempts: number;
  lastError: string;
  givenUp: boolean;
}

export interface NativeDevtoolsInitFailedResult {
  status: "init_failed";
  message: string;
  attempts: number;
}

export function buildInitFailedResult(
  udid: string,
  failure: NativeDevtoolsInitFailure
): NativeDevtoolsInitFailedResult {
  return {
    status: "init_failed",
    message:
      `Native devtools failed to initialize for ${udid} after ${failure.attempts} attempts. ` +
      `Last error: ${failure.lastError}. ` +
      `Try shutting down and re-booting the simulator, or restart CoreSimulatorService.`,
    attempts: failure.attempts,
  };
}

// Overloads for proper return-type inference.
export type NativeDevtoolsPrecheckBlock =
  | NativeDevtoolsInitFailedResult
  | { status: "restart_required"; message: string };

export async function precheckNativeDevtools(
  api: NativeDevtoolsApi,
  udid: string
): Promise<NativeDevtoolsInitFailedResult | null>;
export async function precheckNativeDevtools(
  api: NativeDevtoolsApi,
  udid: string,
  bundleId: string
): Promise<NativeDevtoolsPrecheckBlock | null>;
export async function precheckNativeDevtools(
  api: NativeDevtoolsApi,
  udid: string,
  bundleId?: string
): Promise<NativeDevtoolsPrecheckBlock | null> {
  const existing = api.getInitFailure();
  if (existing?.givenUp) return buildInitFailedResult(udid, existing);

  try {
    await api.ensureEnvReady();
  } catch {
    const failure = api.getInitFailure();
    if (failure) return buildInitFailedResult(udid, failure);
    return buildInitFailedResult(udid, {
      attempts: 1,
      lastError: "ensureEnvReady threw without recording state",
      givenUp: false,
    });
  }

  if (bundleId !== undefined && (await api.requiresAppRestart(bundleId))) {
    return {
      status: "restart_required",
      message:
        "Native devtools are not injected into the running app. " + "Call restart-app then retry.",
    };
  }

  return null;
}

type NativeDevtoolsFactoryOptions = Record<string, unknown> & {
  device: DeviceInfo;
  transport?: NativeDevtoolsTransport;
};

export function nativeDevtoolsRef(
  device: DeviceInfo,
  { transport = "unix" }: { transport?: NativeDevtoolsTransport } = {}
): {
  urn: string;
  options: NativeDevtoolsFactoryOptions;
} {
  const transportSuffix = transport === "tcp" ? ":tcp" : "";
  return {
    urn: `${NATIVE_DEVTOOLS_NAMESPACE}:${device.id}${transportSuffix}`,
    options: { device, transport },
  };
}

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
  /**
   * Force a fresh `ensureEnv` pass, bypassing the one-shot `ensureEnvReady`
   * latch. `ensureEnvReady` caches success and never runs again, so it cannot
   * notice that an out-of-band simulator reboot wiped `DYLD_INSERT_LIBRARIES`
   * from launchd. Callers that have evidence the env may be stale (e.g. a
   * running app that isn't connected) use this to re-apply it. `ensureEnv` is
   * idempotent, so this is a cheap no-op when the env is already correct.
   */
  reverifyEnv(): Promise<void>;
  getInitFailure(): NativeDevtoolsInitFailure | null;

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
      execFileAsync(
        "xcrun",
        [
          "simctl",
          "spawn",
          udid,
          "defaults",
          "write",
          "com.apple.Accessibility",
          flag,
          "-bool",
          "true",
        ],
        { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
      )
    )
  );
}

async function ensureEnv(
  udid: string,
  endpoint: { transport: "unix"; socketPath: string } | { transport: "tcp"; port: number }
): Promise<void> {
  // Pick the dylib slice that matches the simulator's target platform.
  // tvOS simulators require a TVOSSIMULATOR-platform dylib — injecting the
  // default IOSSIMULATOR slice causes dyld to silently skip the library and
  // native injection never connects.
  const isTvos = await isTvOsSimulator(udid);
  const bootstrapPath = isTvos
    ? bootstrapDylibPathTvos()
    : endpoint.transport === "tcp"
      ? bootstrapDylibPathTcp()
      : bootstrapDylibPath();

  // Read from launchctl inside the simulator (via simctl spawn) instead of
  // `simctl getenv`. The latter silently truncates values longer than 127 bytes,
  // which corrupts the colon-separated path list and causes stale entries to
  // accumulate on every ensureEnv() cycle.
  const result = await execFileAsync(
    "xcrun",
    ["simctl", "spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
    { encoding: "utf8", timeout: SIMCTL_SPAWN_TIMEOUT_MS }
  ).catch((e) => ({ stdout: (e as NodeJS.ErrnoException & { stdout?: string }).stdout ?? "" }));

  const existing = (result.stdout ?? "").trim();
  const updated = buildDyldInsertLibraries(existing, bootstrapPath);

  if (updated !== existing) {
    await execFileAsync(
      "xcrun",
      ["simctl", "spawn", udid, "launchctl", "setenv", "DYLD_INSERT_LIBRARIES", updated],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
    );
  }

  // Always re-set the endpoint env var — deterministic value, cheap no-op if already correct,
  // ensures correctness after tool-server restarts.
  if (endpoint.transport === "tcp") {
    await execFileAsync(
      "xcrun",
      [
        "simctl",
        "spawn",
        udid,
        "launchctl",
        "setenv",
        "NATIVE_DEVTOOLS_IOS_CDP_PORT",
        String(endpoint.port),
      ],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
    );
  } else {
    await execFileAsync(
      "xcrun",
      [
        "simctl",
        "spawn",
        udid,
        "launchctl",
        "setenv",
        "NATIVE_DEVTOOLS_IOS_CDP_SOCKET",
        endpoint.socketPath,
      ],
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS }
    );
  }

  // Ensure the accessibility runtime is enabled so that describeScreen works on iOS 26+.
  await ensureAccessibilityEnabled(udid);
}

async function listRunningUIKitApplicationBundleIds(udid: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], {
    encoding: "utf8",
  });

  const bundleIds = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/UIKitApplication:([^[]+)/);
    if (match) {
      bundleIds.add(match[1].trim());
    }
  }
  return bundleIds;
}

export const nativeDevtoolsBlueprint: ServiceBlueprint<NativeDevtoolsApi, DeviceInfo> = {
  namespace: NATIVE_DEVTOOLS_NAMESPACE,

  getURN(device: DeviceInfo) {
    return `${NATIVE_DEVTOOLS_NAMESPACE}:${device.id}`;
  },

  async factory(_deps, _payload, options) {
    const opts = options as unknown as NativeDevtoolsFactoryOptions | undefined;
    if (!opts?.device) {
      throw new Error(
        `${NATIVE_DEVTOOLS_NAMESPACE}.factory requires a resolved DeviceInfo via options.device. ` +
          `Use nativeDevtoolsRef(device) when registering the service ref, or pass { device } when calling resolveService directly.`
      );
    }

    const { device } = opts;
    const transport: NativeDevtoolsTransport = opts.transport ?? "unix";
    if (device.platform !== "ios") {
      throw new Error(
        `${NATIVE_DEVTOOLS_NAMESPACE} is iOS-only. The target '${device.id}' classifies as ${device.platform} — native-devtools tools (native-describe-screen, native-find-views, etc.) only drive iOS simulators. Pick an iOS udid from list-devices.`
      );
    }

    const udid = device.id;
    const socketPath = getNativeDevtoolsSocketPath(udid);
    const tcpPort = NATIVE_DEVTOOLS_TCP_PORT;
    const endpoint =
      transport === "tcp"
        ? ({ transport: "tcp", port: tcpPort } as const)
        : ({ transport: "unix", socketPath } as const);
    const MAX_LOG_ENTRIES = 1000;
    const connections = new Map<string, AppConnection>();
    const pendingRpc = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    let nextRpcId = 1;
    let envSetup = false;
    let initFailure: NativeDevtoolsInitFailure | null = null;
    let inFlight: Promise<void> | null = null;

    const activatedBundleIds = new Set<string>();
    const events = new TypedEventEmitter<ServiceEvents>();

    // Concurrency guard: a single ensureEnv attempt
    // can exceed the watcher's 10s poll interval. Without
    // collapsing overlapping callers onto one in-flight promise, each poll
    // would spawn its own attempt and inflate `attempts`.
    const noteInitFailure = (err: unknown): void => {
      const lastError = err instanceof Error ? err.message : String(err);
      const attempts = (initFailure?.attempts ?? 0) + 1;
      const givenUp = attempts >= MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS;
      initFailure = { attempts, lastError, givenUp };

      const message = givenUp
        ? `[native-devtools] giving up on ${udid} after ${attempts} attempts: ${lastError}\n`
        : `[native-devtools] init attempt ${attempts}/${MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS} failed for ${udid}: ${lastError}\n`;
      process.stderr.write(message);
    };

    // Runs `ensureEnv` under the in-flight concurrency guard with no latch
    // check. Overlapping callers collapse onto the same promise.
    const runEnsureEnv = (): Promise<void> => {
      if (inFlight) return inFlight;

      inFlight = Promise.resolve()
        .then(() => ensureEnv(udid, endpoint))
        .then(() => {
          envSetup = true;
          initFailure = null;
        })
        .catch((err) => {
          noteInitFailure(err);
          throw err;
        })
        .finally(() => {
          inFlight = null;
        });

      return inFlight;
    };

    // Hot path: skip the simctl round-trips once the env has been applied
    // successfully (or we've given up). Most tool calls hit this.
    const ensureEnvReady = (): Promise<void> => {
      if (envSetup || initFailure?.givenUp) return Promise.resolve();
      return runEnsureEnv();
    };

    // Recovery path: re-apply the env even when the latch says it's already
    // set, so a sim reboot that cleared DYLD_INSERT_LIBRARIES is repaired.
    // Still honours the give-up guard so a hard-failed sim doesn't spin.
    const reverifyEnv = (): Promise<void> => {
      if (initFailure?.givenUp) return Promise.resolve();
      return runEnsureEnv();
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

    // Remove stale socket file from a crashed previous run (unix-only).
    if (transport === "unix") {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* no stale socket to remove; ignore */
      }
    }

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

    if (transport === "tcp") {
      server.listen(tcpPort, "127.0.0.1");
    } else {
      server.listen(socketPath);
    }

    // Tolerate ensureEnv failure: throwing here would leak `server` — the
    // registry's `_teardown` skips dispose when `node.instance` is never set.
    // The watcher retries on subsequent polls.
    await ensureEnvReady().catch(() => {});

    // ── Public API ────────────────────────────────────────────────────────────
    const api: NativeDevtoolsApi = {
      isEnvSetup: () => envSetup,
      socketPath,
      ensureEnvReady,
      reverifyEnv,
      getInitFailure: () => initFailure,

      isConnected: (bundleId) => connections.has(bundleId),
      isAppRunning,
      listConnectedBundleIds: () => [...connections.keys()],

      async requiresAppRestart(bundleId) {
        if (connections.has(bundleId)) return false;
        // Re-verify and re-set env — handles the case where the simulator was
        // rebooted and launchd cleared DYLD_INSERT_LIBRARIES. Must use
        // reverifyEnv (not ensureEnvReady): the latter latches after the first
        // success and would skip re-applying the wiped env.
        await reverifyEnv();
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
        if (transport === "unix") {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            /* best-effort socket cleanup; ignore errors */
          }
        }
        for (const { reject } of pendingRpc.values()) {
          reject(new Error("NativeDevtools service disposed"));
        }
        pendingRpc.clear();
      },
      events,
    };
  },
};
