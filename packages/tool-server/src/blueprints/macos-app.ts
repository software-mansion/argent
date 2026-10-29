import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FailureError,
  TypedEventEmitter,
  getFailureSignal,
  type DeviceInfo,
  type FailureCode,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";
import { macosArtifacts } from "@argent/native-devtools-ios";
import { attachNdjsonReader, reportDroppedFrameToStderr } from "../utils/ndjson-socket";
import { macosAppIdFromBundleId, parseMacosAppBundleId } from "../utils/device-info";
import { pidIsAlive, pollPidsUntilGone, signalGroupThenPid } from "../utils/process-kill";
import { settleWithin, sleep } from "../utils/timing";
import {
  chromiumRefusal,
  findMacosAppByBundleId,
  findRunningCopies,
  getTrackedMacosApp,
  hardenedRuntimeRefusal,
  inspectMacosApp,
  macosAppLogPath,
  macosFailure,
  macosListenSocket,
  macosVersionRefusal,
  noListenSocketNote,
  processRunsExecutable,
  recordTrackedMacosApp,
  runningTrackedApp,
  stageLibraryFor,
} from "../utils/macos-apps";
import {
  isInjectableBundleId,
  NATIVE_NETWORK_LOG_LIMIT,
  type NetworkEvent,
} from "./native-devtools";

/**
 * The in-app library of one native Mac app (device id `macos-app-<bundle id>`):
 * starting the app with the library loaded, the channel to it, and stopping
 * the app.
 *
 * `argent-macos-helper launch` starts the app and hands it one end of a socket
 * pair as descriptor 3; argent keeps the other end. The library also listens on
 * a socket path, so a new tool-server can reconnect to an app an earlier one
 * started.
 *
 * Wire format: newline-delimited JSON. The first message on each connection is
 * the handshake `{"type":"Control","payload":{"bundleId","pid","platform":"macos","protocol","libraryVersion"}}`,
 * or `{"type":"Control","payload":{"busy":true}}` while another tool-server
 * holds the app. A request is `{"type":"ViewInspector","payload":{"id","method","params","deadline"}}`;
 * its reply carries the same id with `result` or `error: {message}`. `deadline`
 * (ms since 1970) is when argent stops waiting: a request that has not run by
 * then never runs, so a retry after a timeout does not type or click twice.
 * `{"type":"Control","payload":{"command":"activateNetworkInspection"}}` turns
 * on the network capture, which reports each request as
 * `{"type":"CDP","payload":{"method","params"}}`.
 */

export const MACOS_APP_NAMESPACE = "MacosApp";

export function macosAppRef(device: DeviceInfo): { urn: string; options: { device: DeviceInfo } } {
  return { urn: `${MACOS_APP_NAMESPACE}:${device.id}`, options: { device } };
}

interface MacosLibraryHandshake {
  bundleId: string;
  pid: number;
  platform: "macos";
  protocol: number;
  libraryVersion?: string;
}

interface MacosLaunchOptions {
  /**
   * The `.app` bundle, resolved through symlinks. Defaults to the tracked path,
   * then to the Spotlight lookup of the bundle id. While argent runs a copy
   * from another path, a launch without `takeOver` is refused.
   */
  appPath?: string;
  /**
   * Extra arguments for the app executable. Omitted, the app gets the
   * arguments of its last start: launch-app and restart-app rely on that.
   */
  args?: string[];
  /** How long the library gets to answer after the spawn. Default 20 s. */
  handshakeTimeoutMs?: number;
  /** How long a new process gets to show its first window. Default 10 s. */
  windowTimeoutMs?: number;
  /**
   * Quit the running copies of the app and start it again: argent's own copy,
   * instead of handing it back, and the copies that run without the argent
   * library (the user opened the app, or Xcode Run started it), instead of
   * refusing. They are quit only after every check that can refuse the start.
   */
  takeOver?: boolean;
  /**
   * With `takeOver`, also quit argent's copy when this tool-server cannot reach
   * it and it has no listening socket: another tool-server may drive it. Only
   * boot-device `force` sets it.
   */
  force?: boolean;
}

export interface MacosLaunchResult extends MacosLibraryHandshake {
  /** The arguments the running app was started with. */
  args: string[];
  appPath: string;
  sandboxed: boolean;
  /** The app's stdout and stderr. */
  logPath: string;
  /** The app was already running with the library; nothing was started. */
  alreadyRunning?: true;
  /** Something about the start that the caller should report. */
  note?: string;
}

export interface MacosAppApi {
  readonly bundleId: string;
  /**
   * Send one ViewInspector request to the in-app library and resolve with its
   * `result`. Rejects with the library's error message, or with an error that
   * names `boot-device` / `launch-app` when the app is not running. Reconnects
   * through the library's listening socket when the first channel is gone.
   * A request that times out never runs in the app later, unless `runLate`.
   */
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number; runLate?: boolean }
  ): Promise<T>;
  launch(opts?: MacosLaunchOptions): Promise<MacosLaunchResult>;
  /** Connects to the app as call() does, and fails as it does, with MACOS_APP_IN_USE among others. */
  connect(): Promise<void>;
  isConnected(): boolean;
  handshake(): MacosLibraryHandshake | null;
  /**
   * Turns on the library's network capture, as the first `native-network-logs`
   * call does on iOS. It stays on: each later connection, also the one to a
   * restarted app, turns it on again.
   */
  activateNetworkInspection(): Promise<void>;
  /**
   * The network events of the current app process, oldest first, at most
   * {@link NATIVE_NETWORK_LOG_LIMIT}. A new process starts an empty log; a
   * reconnect to the same process keeps it.
   */
  networkLog(): NetworkEvent[];
  clearNetworkLog(): void;
}

/** The protocol this tool-server speaks. The library raises it only for changes an older tool-server cannot read. */
const MACOS_LIBRARY_PROTOCOL = 1;

const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const HELPER_TIMEOUT_MS = 10_000;
/** From the spawn to the handshake, which the library sends when the app finishes launching or shows a dialog before. */
const HANDSHAKE_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 5_000;
/** How long `Application.terminate` gets before argent looks for a prompt, then signals the app. */
const TERMINATE_GRACE_MS = 5_000;
/** Window kinds of `Window.list` that keep an app from quitting until the agent answers them. */
const PROMPT_KINDS = ["alert", "sheet", "file-panel"];
const SIGNAL_GRACE_MS = 2_000;
const POLL_MS = 100;
const WINDOW_TIMEOUT_MS = 10_000;

/** Replaces the library's bare "No window", which leaves the agent without a way back. */
export const MACOS_NO_WINDOW_MESSAGE =
  "The app has no open window. Open one with the app's own command, such as File > New, " +
  "through menu-bar or its keyboard shortcut.";

function notRunningError(bundleId: string): FailureError {
  return macosFailure(
    `${bundleId} is not running. Start it with boot-device (macosAppPath) or launch-app ` +
      `on the device ${macosAppIdFromBundleId(bundleId)}.`,
    FAILURE_CODES.MACOS_APP_NOT_RUNNING,
    "macos_app_connect",
    "not_found"
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): FailureCode | undefined {
  return getFailureSignal(err)?.error_code;
}

/**
 * SIGTERM, up to 2 s, then SIGKILL, up to 2 s, each to a pid only while it
 * still runs `executable` (it can belong to another process by now), or, with
 * `executable` null, to a pid argent has just started (a launcher script runs
 * as `/bin/sh`). No Apple Events, which would need the Automation permission.
 * `group` signals the process group too: argent's copy runs in a process group
 * of its own. A copy argent did not start gets the signal alone, since its
 * group can hold other programs, such as the shell that started it. Returns the
 * pids that got SIGTERM, and those that still run after SIGKILL or that argent
 * may not signal (a process of another user).
 */
async function stopProcesses(
  pids: readonly number[],
  executable: string | null,
  group: boolean
): Promise<{ signalled: number[]; survivors: number[] }> {
  const runs = async (pid: number) =>
    executable === null ? pidIsAlive(pid) : processRunsExecutable(pid, executable);
  const denied: number[] = [];
  const signal = async (targets: readonly number[], name: NodeJS.Signals): Promise<number[]> => {
    const running: number[] = [];
    for (const pid of targets) {
      if (!(await runs(pid))) continue;
      if (group) {
        signalGroupThenPid(process.kill.bind(process), pid, name);
        running.push(pid);
        continue;
      }
      try {
        process.kill(pid, name);
        running.push(pid);
      } catch (err) {
        // Gone meanwhile is fine; a process of another user stays.
        if ((err as NodeJS.ErrnoException).code === "EPERM") denied.push(pid);
      }
    }
    return running;
  };
  const poll = { timeoutMs: SIGNAL_GRACE_MS, pollIntervalMs: POLL_MS };
  const signalled = await signal(pids, "SIGTERM");
  const killed = await signal(await pollPidsUntilGone(signalled, poll), "SIGKILL");
  const survivors = [...new Set(denied)];
  for (const pid of await pollPidsUntilGone(killed, poll)) {
    if (await runs(pid)) survivors.push(pid);
  }
  return { signalled, survivors };
}

function readLogTail(logPath: string): string {
  try {
    const lines = fs.readFileSync(logPath, "utf8").trimEnd().split("\n");
    const tail = lines.slice(-20).join("\n").trim();
    return tail ? `\nLast lines of ${logPath}:\n${tail}` : "";
  } catch {
    return "";
  }
}

/** Validates a handshake payload against the app argent expects on this channel. */
function parseHandshake(
  payload: unknown,
  bundleId: string,
  pid: number | null
): MacosLibraryHandshake {
  const p = (payload ?? {}) as Record<string, unknown>;
  const fail = (detail: string) =>
    macosFailure(
      `The argent library in ${bundleId} sent an unexpected handshake: ${detail}.`,
      FAILURE_CODES.MACOS_APP_HANDSHAKE_INVALID,
      "macos_app_handshake",
      "validation"
    );
  if (p.bundleId !== bundleId) throw fail(`bundle id ${JSON.stringify(p.bundleId)}`);
  if (typeof p.pid !== "number" || !Number.isInteger(p.pid)) throw fail("no pid");
  if (pid !== null && p.pid !== pid) throw fail(`pid ${p.pid}, but the app has pid ${pid}`);
  if (p.platform !== "macos") throw fail(`platform ${JSON.stringify(p.platform)}`);
  if (p.protocol !== MACOS_LIBRARY_PROTOCOL) {
    throw fail(
      `protocol ${JSON.stringify(p.protocol)}, while this argent speaks ${MACOS_LIBRARY_PROTOCOL}. ` +
        `The macOS library and the tool-server come from different releases`
    );
  }
  return {
    bundleId,
    pid: p.pid,
    platform: "macos",
    protocol: p.protocol,
    ...(typeof p.libraryVersion === "string" ? { libraryVersion: p.libraryVersion } : {}),
  };
}

/**
 * Another agent's stop-simulator-server, say, during this agent's call: nothing
 * is wrong with the app, and the next call reconnects.
 */
function closedByArgentError(bundleId: string): FailureError {
  return macosFailure(
    `argent closed its connection to ${bundleId} before the call was answered ` +
      `(the device's services were stopped or the connection was replaced). ` +
      `Retry the call: argent connects again.`,
    FAILURE_CODES.MACOS_APP_CONNECTION_CLOSED,
    "macos_app_connection",
    "unknown"
  );
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One NDJSON connection to the library: the inherited socket of a launch, or a
 * reconnect through the listening socket. The reader is attached at
 * construction, before the first await, so a handshake that arrives early is
 * never dropped.
 */
class LibraryChannel {
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private hello: MacosLibraryHandshake | null = null;
  private closeError: FailureError | null = null;
  private socketError: Error | null = null;
  /** argent closed the channel itself (dispose, a replaced channel), not the app. */
  private closedByArgent = false;
  private settleHello!: { resolve: (h: MacosLibraryHandshake) => void; reject: (e: Error) => void };
  /** The handshake, or the error that closed the channel before it. */
  private readonly ready = new Promise<MacosLibraryHandshake>((resolve, reject) => {
    this.settleHello = { resolve, reject };
  });

  /**
   * @param expectedPid the app's pid when known; a launch learns it from the helper after the spawn.
   * @param onNetworkEvent receives each network event, with the pid of the process that sent it.
   */
  constructor(
    private readonly socket: net.Socket,
    private readonly bundleId: string,
    private readonly expectedPid: number | null,
    private readonly onNetworkEvent: (event: NetworkEvent, pid: number) => void
  ) {
    this.ready.catch(() => undefined);
    attachNdjsonReader(socket, {
      onDropped: reportDroppedFrameToStderr(`macos-app ${bundleId}`),
      onMessage: (msg) => this.onMessage(msg),
    });
    socket.on("error", (err) => {
      this.socketError = err;
    });
    socket.on("close", () => this.onClose());
  }

  get handshake(): MacosLibraryHandshake | null {
    return this.hello;
  }

  get isOpen(): boolean {
    return this.closeError === null;
  }

  async waitForHandshake(timeoutMs: number): Promise<MacosLibraryHandshake> {
    const settled = await settleWithin(this.ready, timeoutMs);
    if (settled.type === "value") return settled.value;
    if (settled.type === "error") throw settled.cause;
    throw macosFailure(
      `The argent library in ${this.bundleId} did not answer within ${timeoutMs} ms.`,
      FAILURE_CODES.MACOS_APP_HANDSHAKE_TIMEOUT,
      "macos_app_handshake",
      "timeout"
    );
  }

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    runLate = false
  ): Promise<unknown> {
    if (this.closeError) return Promise.reject(this.closeError);
    const id = this.nextId++;
    const deadline = runLate ? undefined : Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(
          macosFailure(
            `${this.bundleId} did not answer ${method} within ${timeoutMs} ms.`,
            FAILURE_CODES.MACOS_APP_RPC_TIMEOUT,
            "macos_app_rpc",
            "timeout"
          )
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.write(
        JSON.stringify({ type: "ViewInspector", payload: { id, method, params, deadline } }) + "\n"
      );
    });
  }

  /** A `Control` command, which the library does not answer. */
  sendControl(command: string): void {
    if (this.closeError) return;
    this.socket.write(JSON.stringify({ type: "Control", payload: { command } }) + "\n");
  }

  close(): void {
    this.closedByArgent = true;
    this.socket.destroy();
  }

  private onMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const msg = raw as { type?: unknown; payload?: Record<string, unknown> };
    if (this.hello === null) {
      // The handshake comes first; anything before it is not ours to read.
      if (msg.type !== "Control") return;
      try {
        if (msg.payload?.busy === true) {
          throw macosFailure(
            `${this.bundleId} is driven by another argent tool-server: the argent library in ` +
              `the app serves one tool-server at a time. Stop the other tool-server (another ` +
              `argent install, for example in another worktree), or start this build under a ` +
              `bundle id of its own to drive both.`,
            FAILURE_CODES.MACOS_APP_IN_USE,
            "macos_app_handshake",
            "validation"
          );
        }
        this.hello = parseHandshake(msg.payload, this.bundleId, this.expectedPid);
        this.settleHello.resolve(this.hello);
      } catch (err) {
        this.fail(err as FailureError);
        this.socket.destroy();
      }
      return;
    }
    if (msg.type === "CDP") {
      // A network event has a method and no id. A frame with an id answers a
      // CDP request, and argent sends none: its id is not a ViewInspector id.
      const p = msg.payload;
      if (p && typeof p.method === "string" && p.id === undefined) {
        this.onNetworkEvent(
          { method: p.method, params: p.params, timestamp: Date.now() },
          this.hello.pid
        );
      }
      return;
    }
    if (msg.type !== "ViewInspector" || !msg.payload) return;
    const id = msg.payload.id;
    const call = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!call) return;
    this.pending.delete(id as number);
    clearTimeout(call.timer);
    const error = msg.payload.error as { message?: unknown } | undefined;
    if (!error) {
      call.resolve(msg.payload.result);
      return;
    }
    const message =
      typeof error.message === "string" && error.message
        ? error.message
        : `${call.method} failed in ${this.bundleId}.`;
    call.reject(
      macosFailure(
        message === "No window" ? MACOS_NO_WINDOW_MESSAGE : message,
        FAILURE_CODES.MACOS_APP_RPC_ERROR,
        "macos_app_rpc",
        "unknown"
      )
    );
  }

  private onClose(): void {
    const detail = this.socketError ? ` (${this.socketError.message})` : "";
    this.fail(
      this.closedByArgent
        ? closedByArgentError(this.bundleId)
        : macosFailure(
            this.hello
              ? `The connection to ${this.bundleId} closed${detail}: the app quit or crashed.`
              : `The connection to ${this.bundleId} closed before the argent library answered${detail}.`,
            FAILURE_CODES.MACOS_APP_CONNECTION_LOST,
            "macos_app_connection",
            "unknown"
          )
    );
  }

  private fail(err: FailureError): void {
    if (this.closeError) return;
    this.closeError = err;
    this.settleHello.reject(err);
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(err);
    }
    this.pending.clear();
  }
}

/** The variables of a Finder launch that the tool-server can pass on. */
const FINDER_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "PATH",
  "LANG",
  "SSH_AUTH_SOCK",
  "__CF_USER_TEXT_ENCODING",
];

/**
 * The helper's environment, which the app inherits: what a Finder launch gives
 * an app, plus the library's variables. Not the tool-server's own, which holds
 * the user's tokens and argent's: ARGENT_AUTH_TOKEN with ARGENT_PORT would let
 * the app, even a sandboxed one, drive the tool-server. The bootstrap travels
 * as `--insert-library`.
 */
function macosLaunchEnv(bundleId: string, listenSocketEnv: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of FINDER_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.ARGENT_INJECT_BUNDLE_ID = bundleId;
  env.NATIVE_DEVTOOLS_FD = "3";
  if (listenSocketEnv) env.NATIVE_DEVTOOLS_LISTEN_SOCKET = listenSocketEnv;
  return env;
}

/** Waits for the `{"pid":N}` of `argent-macos-helper launch`, which exits once the app is spawned. */
async function helperPid(child: ReturnType<typeof spawn>, executable: string): Promise<number> {
  const failed = (detail: string, cause?: unknown) =>
    macosFailure(
      `argent-macos-helper could not start ${executable}: ${detail}`,
      FAILURE_CODES.MACOS_APP_SPAWN_FAILED,
      "macos_app_helper_launch",
      "subprocess",
      cause
    );
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, HELPER_TIMEOUT_MS);
  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    // `close` would wait for descriptor 3, which the app keeps open: wait for
    // the exit and for the end of the two output pipes instead.
    [[code, signal]] = await Promise.all([
      once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
      once(child.stdout!, "close"),
      once(child.stderr!, "close"),
    ]);
  } catch (err) {
    throw failed(errorMessage(err), err);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) throw failed(`no answer within ${HELPER_TIMEOUT_MS} ms`);
  if (code !== 0) throw failed(stderr.trim() || (signal ? `killed by ${signal}` : `exit ${code}`));
  const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
  let pid: unknown;
  try {
    pid = line ? (JSON.parse(line) as { pid?: unknown }).pid : undefined;
  } catch {
    // Reported below.
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    throw failed(`unexpected output ${JSON.stringify(stdout.trim())}`);
  }
  return pid;
}

function createMacosAppApi(bundleId: string): { api: MacosAppApi; dispose: () => void } {
  let channel: LibraryChannel | null = null;
  let connecting: Promise<LibraryChannel> | null = null;
  // Launches run one at a time; call() waits for the one in flight.
  let lifecycle: Promise<unknown> = Promise.resolve();
  let disposed = false;

  // Network capture. Off until the first native-network-logs call, as on iOS;
  // after that each new channel turns it on again. The log belongs to one app
  // process: a restarted app starts an empty one, a reconnect keeps it.
  let networkInspection = false;
  let networkLog: NetworkEvent[] = [];
  let networkLogPid: number | null = null;

  const networkLogOf = (pid: number): NetworkEvent[] => {
    if (pid !== networkLogPid) {
      networkLog = [];
      networkLogPid = pid;
    }
    return networkLog;
  };

  const recordNetworkEvent = (event: NetworkEvent, pid: number): void => {
    const log = networkLogOf(pid);
    if (log.length >= NATIVE_NETWORK_LOG_LIMIT) log.shift();
    log.push(event);
  };

  const adopt = (ch: LibraryChannel): void => {
    if (channel !== ch) channel?.close();
    channel = ch;
    networkLogOf(ch.handshake!.pid);
    if (networkInspection) ch.sendControl("activateNetworkInspection");
  };

  const closeChannel = (): void => {
    channel?.close();
    channel = null;
  };

  /** Connects through the listening socket of the app argent started (a new tool-server, or a dropped channel). */
  const reconnect = async (): Promise<LibraryChannel> => {
    const app = await runningTrackedApp(bundleId);
    if (!app) throw notRunningError(bundleId);
    const notConnected = (detail: string, cause?: unknown) =>
      macosFailure(
        `${bundleId} is running (pid ${app.pid}) but argent cannot reach its library: ${detail} ` +
          `Run restart-app to start it again with the library.`,
        FAILURE_CODES.MACOS_APP_NOT_CONNECTED,
        "macos_app_reconnect",
        "unknown",
        cause
      );
    if (!app.listenSocket) {
      throw macosFailure(
        `${bundleId} is running (pid ${app.pid}), but argent reaches it only through the ` +
          `connection of its start, which this tool-server does not hold: its bundle id is too ` +
          `long for a listening socket. Another tool-server may be driving it. Quit the app, or ` +
          `call boot-device with force: true to quit it and start it again.`,
        FAILURE_CODES.MACOS_APP_NOT_CONNECTED,
        "macos_app_reconnect",
        "unknown"
      );
    }
    const ch = new LibraryChannel(
      net.createConnection(app.listenSocket),
      bundleId,
      app.pid,
      recordNetworkEvent
    );
    try {
      await ch.waitForHandshake(RECONNECT_TIMEOUT_MS);
    } catch (err) {
      ch.close();
      // Busy is not broken: restart-app would quit the other tool-server's app.
      if (errorCode(err) === FAILURE_CODES.MACOS_APP_IN_USE) throw err;
      throw notConnected(errorMessage(err), err);
    }
    if (disposed) {
      ch.close();
      throw closedByArgentError(bundleId);
    }
    adopt(ch);
    return ch;
  };

  const ensureChannel = (): Promise<LibraryChannel> => {
    if (channel?.isOpen && channel.handshake) return Promise.resolve(channel);
    connecting ??= reconnect().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  /**
   * The handshake often comes before the first window is on screen, and a
   * click before it finds no window. Waits for the window argent drives the
   * app through: visible, not minimized, one that can be the main window.
   * Running out of time is a note when the app shows no window, as it may open
   * one later, and a refusal when it shows only panels or borderless windows
   * or has no menu bar. An app that quits meanwhile is a failure.
   */
  const waitForFirstWindow = async (
    ch: LibraryChannel,
    pid: number,
    logPath: string,
    timeoutMs: number,
    uiElement: boolean
  ): Promise<{ note?: string; refusal?: string }> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let shown = false;
      try {
        const listed = (await ch.request("Window.list", {}, 2_000)) as {
          windows?: Array<{
            kind?: unknown;
            isReference?: unknown;
            isVisible?: unknown;
            isMiniaturized?: unknown;
          }>;
        };
        const windows = (Array.isArray(listed?.windows) ? listed.windows : []).filter(
          (w) => w.isVisible === true && w.isMiniaturized !== true
        );
        if (windows.some((w) => w.isReference === true)) return {};
        // An open panel at the start leads to a document window.
        shown = windows.some((w) => w.kind !== "file-panel");
      } catch (err) {
        const code = errorCode(err);
        if (code === FAILURE_CODES.MACOS_APP_CONNECTION_LOST && !pidIsAlive(pid)) {
          throw macosFailure(
            `${bundleId} exited right after it started.${readLogTail(logPath)}`,
            FAILURE_CODES.MACOS_APP_EXITED_BEFORE_READY,
            "macos_app_launch_window",
            "subprocess",
            err
          );
        }
        // Anything but a slow answer will not change by asking again.
        if (code !== FAILURE_CODES.MACOS_APP_RPC_TIMEOUT) {
          return {
            note: `argent could not read the window list of ${bundleId}: ${errorMessage(err)}`,
          };
        }
      }
      if (Date.now() + POLL_MS > deadline) {
        if (shown || uiElement) {
          return {
            refusal:
              `${bundleId} shows no window that argent can drive, so argent quit it. argent ` +
              `drives a Mac app through its standard windows, not a menu bar app or an app ` +
              `that shows only panels or borderless windows.`,
          };
        }
        return {
          note:
            `${bundleId} started, but showed no window within ${Math.round(timeoutMs / 1000)} s. ` +
            `Taps and screenshots need a window: open one in the app, or read ${logPath}.`,
        };
      }
      await sleep(POLL_MS);
    }
  };

  /**
   * Quits argent's own copy: `Application.terminate`, then the signals. An app
   * that answers with a prompt (save changes?) is left to the agent.
   */
  const terminate = async (app: { pid: number; executable: string }): Promise<void> => {
    let ch: LibraryChannel | null;
    try {
      ch = await ensureChannel();
      await ch.request("Application.terminate", {}, 2_000);
    } catch (err) {
      // Another tool-server drives the app: quitting it would stop that agent's work.
      if (errorCode(err) === FAILURE_CODES.MACOS_APP_IN_USE) throw err;
      // No channel or no answer: the signals stop it without the wait.
      ch = null;
    }
    const left = ch
      ? await pollPidsUntilGone([app.pid], {
          timeoutMs: TERMINATE_GRACE_MS,
          pollIntervalMs: POLL_MS,
        })
      : [app.pid];
    if (ch && left.length > 0) {
      const listed = (await ch.request("Window.list", {}, 2_000).catch(() => null)) as {
        windows?: Array<{ kind?: unknown; isVisible?: unknown }>;
      } | null;
      const windows = Array.isArray(listed?.windows) ? listed.windows : [];
      if (windows.some((w) => w.isVisible === true && PROMPT_KINDS.includes(w.kind as string))) {
        throw macosFailure(
          `${bundleId} did not quit: it shows a prompt, probably asking whether to save ` +
            `changes. Answer it (describe shows it), then run this tool again.`,
          FAILURE_CODES.MACOS_APP_TERMINATE_FAILED,
          "macos_app_terminate",
          "validation"
        );
      }
    }
    const { survivors } = await stopProcesses(left, app.executable, true);
    closeChannel();
    if (survivors.length > 0) {
      throw macosFailure(
        `${bundleId} (pid ${app.pid}) did not exit after SIGKILL.`,
        FAILURE_CODES.MACOS_APP_TERMINATE_FAILED,
        "macos_app_terminate",
        "unknown"
      );
    }
  };

  const doLaunch = async (opts: MacosLaunchOptions): Promise<MacosLaunchResult> => {
    const hostRefusal =
      process.platform === "darwin"
        ? macosVersionRefusal(os.release())
        : "Native Mac apps can only be driven on macOS.";
    if (hostRefusal) {
      throw macosFailure(
        hostRefusal,
        FAILURE_CODES.MACOS_APP_UNSUPPORTED_HOST,
        "macos_app_launch",
        "unsupported"
      );
    }
    const own = await runningTrackedApp(bundleId);
    const refuse = (message: string, code: FailureCode) =>
      macosFailure(message, code, "macos_app_launch", "validation");

    if (own) {
      // Returning that copy would let the caller test another build without knowing.
      if (!opts.takeOver && opts.appPath && opts.appPath !== own.appPath) {
        throw refuse(
          `${bundleId} already runs from ${own.appPath} (pid ${own.pid}), a different build ` +
            `than ${opts.appPath}. argent runs one copy of a bundle id at a time, and that copy ` +
            `may belong to another agent or worktree, so argent does not replace it. To run ` +
            `this build next to it, start it under a bundle id of its own.`,
          FAILURE_CODES.MACOS_APP_ALREADY_RUNNING
        );
      }
      // Another tool-server drives the copy: that comes first, whatever the checks below say.
      try {
        const ch = await ensureChannel();
        if (!opts.takeOver) {
          const { appPath, sandboxed, logPath, args } = own;
          const asked = opts.args && JSON.stringify(opts.args);
          const note = [
            asked && asked !== JSON.stringify(args)
              ? `${bundleId} already runs with the arguments ${JSON.stringify(args)}, so it ` +
                `did not get ${asked}. To start it with them, call boot-device with force: true.`
              : undefined,
            own.listenSocket ? undefined : noListenSocketNote(bundleId),
          ]
            .filter(Boolean)
            .join(" ");
          return {
            ...ch.handshake!,
            args,
            appPath,
            sandboxed,
            logPath,
            alreadyRunning: true,
            ...(note ? { note } : {}),
          };
        }
      } catch (err) {
        if (errorCode(err) === FAILURE_CODES.MACOS_APP_IN_USE) throw err;
        if (!opts.takeOver) {
          throw macosFailure(
            errorMessage(err),
            FAILURE_CODES.MACOS_APP_ALREADY_RUNNING,
            "macos_app_launch",
            "unknown",
            err
          );
        }
        // Without a listening socket, argent cannot tell whether another tool-server drives the app.
        if (!own.listenSocket && !opts.force) throw err;
        // No answer: the quit below falls back to signals.
      }
    }

    const tracked = own ?? getTrackedMacosApp(bundleId);
    const appPath =
      opts.appPath ?? tracked?.appPath ?? (await findMacosAppByBundleId(bundleId)) ?? undefined;
    if (!appPath) {
      throw macosFailure(
        `Spotlight knows no app with the bundle id ${bundleId}. Pass the .app path to ` +
          `boot-device as macosAppPath.`,
        FAILURE_CODES.MACOS_APP_NOT_FOUND,
        "macos_app_launch",
        "not_found"
      );
    }
    const info = await inspectMacosApp(appPath);
    if (info.bundleId !== bundleId) {
      throw refuse(
        `The app at ${info.appPath} has the bundle id ${info.bundleId}, not ${bundleId}. ` +
          `Its device id is ${macosAppIdFromBundleId(info.bundleId)}.`,
        FAILURE_CODES.MACOS_APP_BUNDLE_ID_MISMATCH
      );
    }
    // macOS ignores DYLD_* for Apple's own apps, and they are never the app under test.
    const unsupported = isInjectableBundleId(bundleId)
      ? chromiumRefusal(info)
      : `${bundleId} is an Apple app. argent drives only apps it can load its library into, ` +
        `such as your own builds.`;
    if (unsupported) {
      throw macosFailure(
        unsupported,
        FAILURE_CODES.MACOS_APP_BUNDLE_INVALID,
        "macos_app_launch",
        "unsupported"
      );
    }
    const refusal = hardenedRuntimeRefusal(info);
    if (refusal) {
      throw macosFailure(
        refusal,
        FAILURE_CODES.MACOS_APP_HARDENED_RUNTIME,
        "macos_app_launch",
        "unsupported"
      );
    }
    // A copy of another build is refused even on a take-over: it may be another
    // agent's, and a second copy beside it would take over its socket and its log.
    // argent's own copy is not one of them: the take-over replaces it.
    const copies = await findRunningCopies(bundleId, info.executable, own?.pid);
    if (copies.otherBuilds.length > 0) {
      const where = copies.otherBuilds.map((b) => `${b.appPath} (pid ${b.pid})`).join(", ");
      throw refuse(
        `${bundleId} already runs from ${where}, a different build than ${info.appPath}. ` +
          `argent runs one copy of a bundle id at a time and replaces only a copy of the same ` +
          `build. Quit that copy if it is yours, or start this build under a bundle id of its ` +
          `own to run both.`,
        FAILURE_CODES.MACOS_APP_ALREADY_RUNNING
      );
    }
    if (copies.same.length > 0 && !opts.takeOver) {
      throw refuse(
        `${bundleId} is already running (pid ${copies.same.join(", ")}) without the argent ` +
          `library, and argent drives only a copy that it starts. Quit that copy, or call ` +
          `boot-device with force: true (restart-app does the same): argent then quits it and ` +
          `starts the app with the library. Unsaved changes in that copy are lost.`,
        FAILURE_CODES.MACOS_APP_ALREADY_RUNNING
      );
    }

    let artifacts: ReturnType<typeof macosArtifacts>;
    try {
      artifacts = macosArtifacts();
    } catch (err) {
      throw macosFailure(
        errorMessage(err),
        FAILURE_CODES.MACOS_APP_LIBRARY_MISSING,
        "macos_app_launch",
        "not_found",
        err
      );
    }
    const bootstrapPath = await stageLibraryFor(info, artifacts);

    // After every check that can refuse the start: argent's own copy and a copy
    // the user runs are quit only when argent can start the app again.
    if (own) await terminate(own);
    let tookOver: string | undefined;
    if (copies.same.length > 0) {
      const { signalled, survivors } = await stopProcesses(copies.same, info.executable, false);
      if (survivors.length > 0) {
        throw macosFailure(
          `argent could not quit the copy of ${bundleId} that runs without the argent library ` +
            `(pid ${survivors.join(", ")}): it still runs after SIGTERM and SIGKILL, or argent ` +
            `may not signal it. Quit it yourself, then start the app again through argent.`,
          FAILURE_CODES.MACOS_APP_TERMINATE_FAILED,
          "macos_app_take_over",
          "unknown"
        );
      }
      if (signalled.length > 0) {
        tookOver =
          `argent quit the copy of ${bundleId} that ran without the argent library ` +
          `(pid ${signalled.join(", ")}) and started the app with the library. Unsaved changes ` +
          `in that copy are lost.`;
      }
    }

    const listen = macosListenSocket(bundleId, info.sandboxed);
    const logPath = macosAppLogPath(bundleId);
    // The listening socket gives full control of the app: keep its directory private.
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    if (listen && !info.sandboxed) fs.rmSync(listen.path, { force: true });
    fs.writeFileSync(logPath, "");
    const args = opts.args ?? tracked?.args ?? [];

    const helper = spawn(
      artifacts.helper,
      [
        "launch",
        "--exe",
        info.executable,
        "--fd",
        "3",
        "--insert-library",
        bootstrapPath,
        "--stdout",
        logPath,
        "--stderr",
        logPath,
        "--",
        ...args,
      ],
      // On macOS every "pipe" entry is a socket pair: the helper's descriptor 3,
      // which the app inherits, is the library's channel; argent keeps stdio[3].
      // The app inherits the working directory, which a Finder launch sets to /.
      {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        env: macosLaunchEnv(bundleId, listen?.env),
        cwd: "/",
      }
    );
    // Attached before the first await: the handshake may come before the helper's answer.
    const ch = new LibraryChannel(
      helper.stdio[3] as net.Socket,
      bundleId,
      null,
      recordNetworkEvent
    );
    let pid: number;
    try {
      pid = await helperPid(helper, info.executable);
    } catch (err) {
      ch.close();
      throw err;
    }

    // Recorded before the handshake: if this tool-server dies now, the next
    // one still knows which process to stop.
    recordTrackedMacosApp({
      bundleId,
      appPath: info.appPath,
      executable: info.executable,
      name: info.name,
      pid,
      sandboxed: info.sandboxed,
      userSelectedReadOnly: info.userSelectedReadOnly,
      listenSocket: listen?.path ?? null,
      logPath,
      args,
      startedAt: Date.now(),
    });

    let hello: MacosLibraryHandshake;
    try {
      const timeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
      hello = parseHandshake(await ch.waitForHandshake(timeoutMs), bundleId, pid);
    } catch (err) {
      ch.close();
      if (!pidIsAlive(pid)) {
        throw macosFailure(
          `${bundleId} exited before the argent library answered.${readLogTail(logPath)}`,
          FAILURE_CODES.MACOS_APP_EXITED_BEFORE_READY,
          "macos_app_launch",
          "subprocess",
          err
        );
      }
      const { survivors } = await stopProcesses([pid], null, true);
      const stopped = survivors.length
        ? `argent could not stop it (pid ${pid}).`
        : `argent stopped it again.`;
      const invalid = errorCode(err) === FAILURE_CODES.MACOS_APP_HANDSHAKE_INVALID;
      throw macosFailure(
        invalid
          ? `${errorMessage(err)} ${stopped}`
          : `${bundleId} started, but the argent library did not connect (${errorMessage(err)}), ` +
              `so ${stopped} Check that nothing blocks the app's main thread while it launches, ` +
              `and that its executable is not a launcher script or shell wrapper that starts the app.` +
              readLogTail(logPath),
        invalid
          ? FAILURE_CODES.MACOS_APP_HANDSHAKE_INVALID
          : FAILURE_CODES.MACOS_APP_HANDSHAKE_TIMEOUT,
        "macos_app_launch",
        invalid ? "validation" : "timeout",
        err
      );
    }
    const result: MacosLaunchResult = {
      ...hello,
      args,
      appPath: info.appPath,
      sandboxed: info.sandboxed,
      logPath,
    };
    if (disposed) {
      ch.close();
      return tookOver ? { ...result, note: tookOver } : result;
    }
    adopt(ch);
    const { note: noWindow, refusal: noDrivableWindow } = await waitForFirstWindow(
      ch,
      pid,
      logPath,
      opts.windowTimeoutMs ?? WINDOW_TIMEOUT_MS,
      info.uiElement
    );
    if (noDrivableWindow) {
      await terminate({ pid, executable: info.executable });
      throw macosFailure(
        noDrivableWindow,
        FAILURE_CODES.MACOS_APP_BUNDLE_INVALID,
        "macos_app_launch_window",
        "unsupported"
      );
    }
    const note = [tookOver, noWindow, listen ? undefined : noListenSocketNote(bundleId)]
      .filter(Boolean)
      .join(" ");
    return note ? { ...result, note } : result;
  };

  const api: MacosAppApi = {
    bundleId,
    async call<T = unknown>(
      method: string,
      params: Record<string, unknown> = {},
      opts: { timeoutMs?: number; runLate?: boolean } = {}
    ): Promise<T> {
      await lifecycle;
      const ch = await ensureChannel();
      const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      return (await ch.request(method, params, timeoutMs, opts.runLate)) as T;
    },
    launch: (opts = {}) => {
      const run = lifecycle.then(
        () => doLaunch(opts),
        () => doLaunch(opts)
      );
      lifecycle = run.catch(() => undefined);
      return run;
    },
    async connect() {
      await lifecycle;
      await ensureChannel();
    },
    isConnected: () => Boolean(channel?.isOpen && channel.handshake),
    handshake: () => (channel?.isOpen ? channel.handshake : null),
    async activateNetworkInspection() {
      networkInspection = true;
      await lifecycle;
      // A channel that ensureChannel opens just now gets it from adopt as
      // well: the library ignores a repeat.
      (await ensureChannel()).sendControl("activateNetworkInspection");
    },
    networkLog: () => [...networkLog],
    clearNetworkLog: () => {
      networkLog.length = 0;
    },
  };

  return {
    api,
    dispose: () => {
      disposed = true;
      closeChannel();
    },
  };
}

export const macosAppBlueprint: ServiceBlueprint<MacosAppApi, string> = {
  namespace: MACOS_APP_NAMESPACE,
  getURN(deviceId: string) {
    return `${MACOS_APP_NAMESPACE}:${deviceId}`;
  },
  async factory(_deps, deviceId) {
    const bundleId = parseMacosAppBundleId(deviceId);
    if (!bundleId) {
      throw macosFailure(
        `'${deviceId}' is not a Mac app device id (macos-app-<bundle id>).`,
        FAILURE_CODES.MACOS_APP_BUNDLE_INVALID,
        "macos_app_factory",
        "validation"
      );
    }
    const { api, dispose } = createMacosAppApi(bundleId);
    return {
      api,
      // Closes argent's end of the channel only. The app keeps running, and the
      // next resolve reconnects through the listening socket.
      dispose: async () => dispose(),
      events: new TypedEventEmitter<ServiceEvents>(),
    };
  },
};
