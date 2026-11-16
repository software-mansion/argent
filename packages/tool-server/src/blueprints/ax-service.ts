import * as net from "node:net";
import * as fs from "node:fs";
import { ChildProcess } from "node:child_process";
import { attachNdjsonReader, reportDroppedFrameToStderr } from "../utils/ndjson-socket";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  subprocessFailureMetadata,
  TypedEventEmitter,
  type DeviceInfo,
  type FailureSignal,
  type ServiceBlueprint,
  type ServiceInstance,
  type ServiceEvents,
} from "@argent/registry";
import { assertExternalCapability } from "../utils/external-devices";
import { pickIosHost, type IosEndpoint } from "../utils/ios-host";

// Moved to ../utils/ax-prefs; re-exported so existing import paths keep working.
export { ensureAutomationEnabled, setAccessibilityPrefsPreBoot } from "../utils/ax-prefs";

export const AX_SERVICE_NAMESPACE = "AXService";

type AXServiceTransport = "unix" | "tcp";

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
  /** The VoiceOver hint. Only `describe` sends it, and a daemon older than this field does not. */
  hint?: string;
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

/** A `tree` node, in document order; `parentIndex` names its accessibility parent. */
export interface AXTreeNode extends Omit<AXDescribeElement, "hint"> {
  index: number;
  parentIndex?: number;
  roleDescription?: string;
  covered?: boolean;
  /** An XCUIElementType value. */
  elementType?: number;
  placeholder?: string;
  /** The input shows its placeholder: it holds no text, and `value` is the placeholder. */
  hintShowing?: boolean;
  /** Roots only. */
  bundleId?: string;
}

export interface AXTreeResponse {
  alertVisible: boolean;
  screenFrame?: { width: number; height: number };
  nodes: AXTreeNode[];
  truncated: boolean;
  foregroundApp?: string;
  /** 2 and up: nodes carry elementType, placeholder, hintShowing and root bundleId. */
  treeVersion?: number;
}

export interface AXForegroundAppResponse {
  alertVisible: boolean;
  bundleId?: string;
  name?: string;
}

/** The `fill` command's answer. Never carries text: only whether it matched. */
export interface AXFillResponse {
  /** False when nothing holds keyboard focus. */
  focused: boolean;
  /** The focused input now holds the requested text (a secure field: as many bullets). */
  verified: boolean;
  /** A clear the field ignored with its text still selected; one backspace removes it. */
  needsBackspace?: boolean;
  /**
   * A native secure field, which drops inserted text. The daemon cleared it
   * (`cleared` says whether that read back) for the caller to type into, or
   * left it untouched when the caller said it cannot type the text.
   */
  secure?: boolean;
  cleared?: boolean;
  /** The focused element is no text input: a web date or time input. Nothing was changed. */
  unsupported?: boolean;
  /** The text has a line break and the field holds one line. Nothing was changed. */
  singleLine?: boolean;
  /** The daemon or the app did not answer in time: the field may have changed. */
  timedOut?: boolean;
  /** The selection never covered the text, so nothing was changed. */
  untouched?: boolean;
}

export interface AXServiceApi {
  /** Entitlement bypass isn't active (sim booted outside argent) — AX reads may come back empty. */
  degraded: boolean;
  describe(): Promise<AXDescribeResponse>;
  /** The front app's full hierarchy; while a system alert shows, the system app first and the app under it second. */
  tree(): Promise<AXTreeResponse>;
  /** Which app is in front, without a tree walk. */
  foregroundApp(): Promise<AXForegroundAppResponse>;
  alertCheck(): Promise<boolean>;
  ping(): Promise<boolean>;
  /**
   * Set the focused input's text ("" clears it) through the AX text
   * operations, then read it back; with `check`, only read it back. Fails when
   * the daemon predates the command.
   */
  fill(text: string, options?: { check?: boolean; typeable?: boolean }): Promise<AXFillResponse>;
  /**
   * The display id of the panel the guest renders to (1 the cover panel, 3
   * the inner one on the iPhone Duo): the panel `describe` reads its tree on.
   * Null when the daemon names none, as on a device with one panel. Answered
   * in a few milliseconds; every touch of a foldable asks it
   * (`utils/foldable.ts`), so its budget is short. A daemon build that
   * predates the command answers an error.
   */
  livePanel(): Promise<number | null>;
}

/**
 * How long `live_panel` gets: a healthy daemon answers in a few milliseconds,
 * and a caller that asks before every touch must not wait on one that hangs.
 */
const LIVE_PANEL_TIMEOUT_MS = 2_000;

/**
 * The daemon answers `fill` within its own 3 s budget; this only catches a
 * daemon whose main thread is held by another command against a hung app.
 */
const FILL_TIMEOUT_MS = 6_000;

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

/**
 * Darwin's signal numbers. The local daemon only ever runs on a macOS host, and
 * `os.constants.signals` numbers them for whichever host runs this code.
 */
const DARWIN_SIGNALS: Readonly<Record<number, string>> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  7: "SIGEMT",
  8: "SIGFPE",
  9: "SIGKILL",
  10: "SIGBUS",
  11: "SIGSEGV",
  12: "SIGSYS",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};

/**
 * The signals a process dies on through its own fault. SIGKILL and SIGTERM are
 * not among them: a simulator that shuts down ends the daemon that way, and so
 * does this blueprint on dispose, and neither is a crash.
 */
const FAULT_SIGNALS: ReadonlySet<string> = new Set([
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGEMT",
  "SIGFPE",
  "SIGBUS",
  "SIGSEGV",
  "SIGSYS",
]);

/**
 * `xcrun simctl spawn` outlives a child that a signal killed: it prints this
 * line and exits 128+N, so Node reports an exit code and no signal. The line
 * is the evidence, not the code. simctl exits with its own error's code modulo
 * 256 (SimError 405, "device is not booted", exits 149), which reaches the
 * same range.
 */
const SIMCTL_CHILD_SIGNAL = /Child process terminated with signal (\d+)/;

/** `exit` can be delivered before the last stderr chunk is read; see `watchDaemonExit`. */
const STDERR_DRAIN_MS = 250;
const STDERR_TAIL_CHARS = 4_000;

/**
 * A daemon that dies closes its socket before its exit is reported, and only
 * the exit says how it died. A closed socket waits this long for the exit, so
 * a crash is not reported as a bare disconnect. The exit follows within
 * milliseconds (2 ms in the log of #800); an exit that misses the window is
 * reported as the disconnect it used to be. Kept under the shortest RPC
 * timeout, so a request in flight still fails with the cause.
 */
const DAEMON_EXIT_GRACE_MS = 1_000;

/** How the daemon's process ended; `signal` names the signal that killed it. */
interface AxDaemonExit {
  code: number | null;
  signal?: string;
}

export function readAxDaemonExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string
): AxDaemonExit {
  // Node reports a signal only when it killed the `simctl spawn` process itself.
  if (signal) return { code, signal };
  const reported = SIMCTL_CHILD_SIGNAL.exec(stderr);
  if (!reported) return { code };
  const number = Number(reported[1]);
  return { code, signal: DARWIN_SIGNALS[number] ?? `signal ${number}` };
}

/**
 * The daemon died on a fault signal. The signal is carried apart from the
 * message so a caller can name it without parsing.
 */
class AxDaemonCrashError extends FailureError {
  readonly signalName: string;

  constructor(message: string, signal: FailureSignal, signalName: string) {
    super(message, signal);
    this.name = "AxDaemonCrashError";
    this.signalName = signalName;
  }
}

/** `pick` over `err` and its causes: the registry wraps a factory rejection. */
function findInCauses<T>(err: unknown, pick: (error: Error) => T | undefined): T | undefined {
  let current = err;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    const found = pick(current);
    if (found !== undefined) return found;
    current = current.cause;
  }
  return undefined;
}

/** The fault signal that killed the daemon, when `err` reports one. */
export function axDaemonCrashSignal(err: unknown): string | undefined {
  return findInCauses(err, (error) =>
    error instanceof AxDaemonCrashError ? error.signalName : undefined
  );
}

// A failed start, by whether the entitlement bypass was inactive when it began.
const startFailureDegraded = new WeakMap<Error, boolean>();

/**
 * What `AXServiceApi.degraded` would have said, had the start that failed with
 * `err` succeeded. Undefined when it failed before the factory measured that.
 * Without it a caller can only guess the boot state from the failure, and a
 * daemon fails to start for reasons that have nothing to do with it.
 */
export function axStartFailureDegraded(err: unknown): boolean | undefined {
  return findInCauses(err, (error) => startFailureDegraded.get(error));
}

export function axDaemonExitError(
  exit: AxDaemonExit,
  phase: "connecting" | "connected"
): FailureError {
  const suffix = phase === "connecting" ? " before connecting" : "";
  const signal: FailureSignal = {
    error_code:
      phase === "connecting"
        ? FAILURE_CODES.AX_DAEMON_EXITED_BEFORE_READY
        : FAILURE_CODES.AX_DAEMON_PROCESS_ERROR,
    failure_stage: phase === "connecting" ? "ax_service_spawn_ready" : "ax_service_process_exit",
    failure_area: "tool_server",
    error_kind: "subprocess",
    ...subprocessFailureMetadata(exit, "ax_service"),
  };
  if (exit.signal === undefined) {
    return new FailureError(`ax-service exited with code ${exit.code}${suffix}`, signal);
  }
  if (!FAULT_SIGNALS.has(exit.signal)) {
    return new FailureError(`ax-service was killed by ${exit.signal}${suffix}`, signal);
  }
  return new AxDaemonCrashError(
    `ax-service crashed with ${exit.signal}${suffix}`,
    { ...signal, error_code: FAILURE_CODES.AX_DAEMON_CRASHED },
    exit.signal
  );
}

/**
 * Resolves with how the daemon's process ended; never for a remote daemon,
 * which has no local process. `exit` can be delivered before the last stderr
 * chunk is read, and that chunk is where simctl names the signal, so the
 * verdict waits for stderr to end, for STDERR_DRAIN_MS at most. `onExit` runs
 * as soon as the exit is seen, before that wait.
 */
function watchDaemonExit(proc: ChildProcess, onExit: () => void): Promise<AxDaemonExit> {
  return new Promise((resolve) => {
    let stderrTail = "";
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    proc.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      onExit();
      const settle = () => resolve(readAxDaemonExit(code, signal, stderrTail));
      const stderr = proc.stderr;
      if (signal || !stderr || stderr.readableEnded) return settle();
      const timer = setTimeout(settle, STDERR_DRAIN_MS);
      stderr.once("end", () => {
        clearTimeout(timer);
        settle();
      });
    });
  });
}

function waitForDaemonConnection(
  server: net.Server,
  proc: ChildProcess,
  exited: Promise<AxDaemonExit>,
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

    void exited.then((exit) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(axDaemonExitError(exit, "connecting"));
    });

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
      proc.off("error", onError);
    };

    server.on("connection", onConnection);
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

    /**
     * Mechanism gate for provider-supplied devices. Gating here at the
     * blueprint, rather than per tool is what keeps this bounded. Every tool
     * built on `AX_SERVICE_NAMESPACE`, now and in future, inherits the check
     * without being re-audited. A no-op for every device Argent booted itself.
     */
    await assertExternalCapability(AX_SERVICE_NAMESPACE, device, "ax-service");

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
    let daemonSocket: net.Socket | null = null;
    let disposed = false;
    // The daemon's process has exited; how it ended is known or being read.
    let exitSeen = false;
    // The socket has closed and nothing has said yet how the daemon ended.
    let awaitingVerdict = false;
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    // A remote daemon has no local process whose exit could follow the close.
    const exitGraceMs = host.kind === "local" ? DAEMON_EXIT_GRACE_MS : 0;

    const failPending = (err: Error): void => {
      for (const { reject, timer } of pendingRpc.values()) {
        clearTimeout(timer);
        reject(err);
      }
      pendingRpc.clear();
    };

    const terminate = (err: Error): void => {
      if (disposed) return;
      clearTimeout(disconnectTimer);
      awaitingVerdict = false;
      failPending(err);
      events.emit("terminated", err);
    };

    const { entitlementBypassActive } = await host.bootstrapAx(udid);

    // Listen before spawning; the daemon dials in.
    const server = await startListener(endpoint, (socket) => {
      if (daemonSocket && !daemonSocket.destroyed) {
        // Respawned daemon: the newest connection wins.
        daemonSocket.destroy();
      }
      daemonSocket = socket;

      attachNdjsonReader(socket, {
        onDropped: reportDroppedFrameToStderr(`ax-service ${udid.slice(0, 8)}`),
        onMessage: (parsed) => {
          const msg = parsed as { id?: number; result?: unknown; error?: unknown };
          if (typeof msg.id !== "number") return;
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
        },
      });

      socket.on("close", () => {
        if (daemonSocket !== socket) return;
        daemonSocket = null;
        if (disposed) return;
        awaitingVerdict = true;
        // An exit already seen ends the service itself, and names the cause.
        if (exitSeen) return;
        const disconnected = () =>
          terminate(
            new FailureError("ax-service daemon disconnected", {
              error_code: FAILURE_CODES.AX_DAEMON_PROCESS_ERROR,
              failure_stage: "ax_service_socket_close",
              failure_area: "tool_server",
              error_kind: "subprocess",
            })
          );
        if (exitGraceMs === 0) disconnected();
        else disconnectTimer = setTimeout(disconnected, exitGraceMs);
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

    const exited = watchDaemonExit(proc, () => {
      exitSeen = true;
      // The exit's own verdict follows; a disconnect must not get in ahead of it.
      clearTimeout(disconnectTimer);
    });
    proc.on("error", (err) => {
      terminate(
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
    });

    try {
      daemonSocket = await waitForDaemonConnection(server, proc, exited, 10_000);
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
      if (err instanceof Error) startFailureDegraded.set(err, !entitlementBypassActive);
      throw err;
    }

    // Registered once the daemon is connected: before that an exit fails the
    // start above, and the SIGTERM that cleans up a failed start is no death
    // to report.
    void exited.then((exit) => terminate(axDaemonExitError(exit, "connected")));

    function query(
      command: string,
      timeoutMs = 5000,
      params?: Record<string, unknown>
    ): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const socket = daemonSocket && !daemonSocket.destroyed ? daemonSocket : null;
        // While the verdict on a closed socket is out, a request waits for it
        // like the ones already in flight, and fails with how the daemon died
        // instead of as merely not connected.
        if (!socket && !awaitingVerdict) {
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
            reject(
              new FailureError(`ax-service query timed out: ${command}`, {
                error_code: FAILURE_CODES.AX_QUERY_TIMEOUT,
                failure_stage: "ax_service_query_socket",
                failure_area: "tool_server",
                error_kind: "timeout",
              })
            );
          }
        }, timeoutMs);
        pendingRpc.set(id, { resolve, reject, timer });
        socket?.write(
          JSON.stringify(params === undefined ? { id, command } : { id, command, params }) + "\n"
        );
      });
    }

    const api: AXServiceApi = {
      degraded: !entitlementBypassActive,

      async describe(): Promise<AXDescribeResponse> {
        const result = (await query("describe", 10_000)) as AXDescribeResponse & {
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

      async tree(): Promise<AXTreeResponse> {
        let result: Partial<AXTreeResponse>;
        try {
          result = (await query("tree", 10_000)) as Partial<AXTreeResponse>;
        } catch (err) {
          // A daemon that predates `tree` answers an envelope-level error.
          if (!(err instanceof Error) || err.message !== "unknown_command") throw err;
          throw new FailureError("ax-service predates `tree`; update argent", {
            error_code: FAILURE_CODES.AX_QUERY_FAILED,
            failure_stage: "ax_service_tree",
            failure_area: "tool_server",
            error_kind: "unknown",
          });
        }
        return {
          alertVisible: result.alertVisible ?? false,
          screenFrame: result.screenFrame,
          nodes: result.nodes ?? [],
          truncated: result.truncated === true,
          foregroundApp: result.foregroundApp,
          treeVersion: result.treeVersion,
        };
      },

      async foregroundApp(): Promise<AXForegroundAppResponse> {
        return (await query("foreground_app")) as AXForegroundAppResponse;
      },

      async livePanel(): Promise<number | null> {
        const result = (await query("live_panel", LIVE_PANEL_TIMEOUT_MS)) as {
          displayId?: number | null;
          error?: string;
        };
        if (result.error) {
          throw new FailureError(`ax-service live_panel error: ${result.error}`, {
            error_code: FAILURE_CODES.AX_QUERY_FAILED,
            failure_stage: "ax_service_live_panel",
            failure_area: "tool_server",
            error_kind: "unknown",
          });
        }
        return typeof result.displayId === "number" && result.displayId > 0
          ? result.displayId
          : null;
      },

      async fill(
        text: string,
        options: { check?: boolean; typeable?: boolean } = {}
      ): Promise<AXFillResponse> {
        let result: {
          verified?: boolean;
          needsBackspace?: boolean;
          secure?: boolean;
          cleared?: boolean;
          untouched?: boolean;
        };
        try {
          result = (await query("fill", FILL_TIMEOUT_MS, {
            text,
            ...(options.check ? { check: true } : {}),
            ...(options.typeable === false ? { typeable: false } : {}),
          })) as typeof result;
        } catch (err) {
          // Envelope-level errors carry only the daemon's code, never text.
          const code = err instanceof Error ? err.message : "";
          if (code === "unknown_command") {
            throw new FailureError("ax-service predates `fill`; update argent", {
              error_code: FAILURE_CODES.AX_QUERY_FAILED,
              failure_stage: "ax_service_fill",
              failure_area: "tool_server",
              error_kind: "unknown",
            });
          }
          // A focused element that takes no text is no field to fill either.
          if (code === "no_focused_field" || code === "not_editable") {
            return { focused: false, verified: false };
          }
          if (code === "unsupported_field") {
            return { focused: true, verified: false, unsupported: true };
          }
          if (code === "single_line") return { focused: true, verified: false, singleLine: true };
          // The edit threw, ran out of its budget, or overlapped one that did:
          // the field's state is unknown. A daemon that did not answer at all
          // is the same verdict.
          if (code === "select_failed") return { focused: true, verified: false, untouched: true };
          if (code === "fill_failed") return { focused: true, verified: false };
          if (
            code === "fill_timeout" ||
            code === "fill_busy" ||
            getFailureSignal(err)?.error_code === FAILURE_CODES.AX_QUERY_TIMEOUT
          ) {
            return { focused: true, verified: false, timedOut: true };
          }
          throw err;
        }
        return {
          focused: true,
          verified: result.verified === true,
          ...(result.needsBackspace === true ? { needsBackspace: true } : {}),
          ...(result.secure === true ? { secure: true } : {}),
          ...(typeof result.cleared === "boolean" ? { cleared: result.cleared } : {}),
          ...(result.untouched === true ? { untouched: true } : {}),
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
        clearTimeout(disconnectTimer);
        awaitingVerdict = false;
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
