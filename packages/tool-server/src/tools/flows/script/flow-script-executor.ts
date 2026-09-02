/**
 * Runs one trusted local script file — JavaScript or bash — in a fresh child
 * process. The extension picks the interpreter; a `.mjs` is the runner's own
 * Node, a `.sh` is the bash {@link resolveBashInterpreter} finds, and every
 * control here applies to both unchanged.
 *
 * The child is a *reliability* boundary, not a security one: a script is as
 * trusted as a local npm script, and all the process buys is that an infinite
 * loop, a heap exhaustion or a `process.exit` cannot take the server down.
 */

import { fork, spawn, type ChildProcess, type ForkOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import {
  getConfigDefinition,
  getConfigValue,
  MIN_SCRIPT_HEAP_LIMIT_MB,
  MIN_SCRIPT_TIMEOUT_MS,
  type ConfigDefinition,
} from "@argent/configuration-core";
import { isElectronHostedEnv } from "../../../utils/electron-env";
import { formatErrorForAgent } from "../../../utils/format-error";
import { scrubSecretValues } from "../../../utils/secrets";
import { sleep } from "../../../utils/timing";
import { resolveBashInterpreter } from "./flow-script-interpreter";
import {
  isTerminalResponse,
  parseScriptResponse,
  SCRIPT_MAX_FAILURE_MESSAGE_CHARS,
  SCRIPT_MAX_FAILURE_STACK_CHARS,
  SCRIPT_MAX_OUTPUT_BYTES,
  type ScriptExecuteRequest,
  type ScriptTerminalResponse,
} from "./flow-script-protocol";

const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
const SETTLE_TIMEOUT_MS = 500;
const STOP_GRACE_MS = 1_500;
/**
 * How far behind the parent's timer the child's own deadline watchdog sits.
 *
 * The watchdog is the second line, for a parent that is gone or whose event
 * loop is blocked, so the margin has to be an ordinary stall wide — the tool
 * server makes synchronous calls of its own (`stop-metro` shells out to `lsof`
 * and `netstat`). Too narrow and the child SIGKILLs its own group first, so a
 * timed-out step is reported as an unexplained signal.
 */
const CHILD_DEADLINE_MARGIN_MS = 2_000;
const GROUP_POLL_MS = 50;
const FORCE_GRACE_MS = 500;
const QUEUE_DEPTH_LIMIT = 32;
const QUEUE_WAIT_REPORT_MS = 5_000;
/**
 * V8's heap-exhaustion banner. Coarse on purpose: the wording is not a
 * stability contract, and an unrecognized abort degrades to the signal report
 * rather than to a wrong verdict.
 */
const V8_HEAP_FATAL_RE = /FATAL ERROR:[^\n]*(?:heap limit|heap out of memory|Allocation failed)/i;

/**
 * A watchdog announcing that it never armed: `flow-script-runner.mjs`'s
 * `reportWatchdogProblem`, and the lifeline thread's own module-scope catch.
 * Those are the only first-party writers on the child's stderr, and without
 * this a run that lost both watchdogs is byte-identical to a healthy one.
 */
const WATCHDOG_PROBLEM_RE = /\[argent\] script (?:watchdog|lifeline)\b[^\n]*unavailable:/;

const STDERR_WINDOW_CHARS = 256;

const RUNNER_FILE = "flow-script-runner.mjs";

const RUNNER_ACTIVATION_ENV = "ARGENT_FLOW_SCRIPT_RUNNER";

const BASH_OUTPUT_ENV = "ARGENT_OUTPUT";
const BASH_REASON_ENV = "ARGENT_REASON";

/**
 * One private directory per bash step, under `os.tmpdir()` — 0700 on POSIX
 * through `mkdtemp`, the per-user `%TEMP%` on Windows. The prefix is what the
 * first-use sweep below recognises as the executor's own.
 */
const EXCHANGE_DIR_PREFIX = "argent-flow-script-";

/**
 * How long past its own time limit a step's exchange directory is still its
 * own. The owner removes it in a `finally` at about `timeout` plus the settle,
 * stop and force graces; the minute after that is room for a stall in the tool
 * server's event loop of the kind `CHILD_DEADLINE_MARGIN_MS` exists for.
 * Nothing waits on it but the collection of a directory whose server died.
 */
const EXCHANGE_LIFE_MARGIN_MS =
  SETTLE_TIMEOUT_MS + CHILD_DEADLINE_MARGIN_MS + STOP_GRACE_MS + FORCE_GRACE_MS + 60_000;
const EXCHANGE_OUTPUT_FILE = "output.json";
const EXCHANGE_REASON_FILE = "reason.txt";

/**
 * The owner's account and nothing else, matching the 0700 `mkdtemp` directory
 * around them. Ignored on Windows, where the directory inherits the ACL of
 * `%TEMP%` — private per user in the ordinary case, and not under a tool server
 * running as a service.
 */
const EXCHANGE_FILE_MODE = 0o600;

const EXCHANGE_SWEEP_INTERVAL_MS = 60_000;

/**
 * An allowlist rather than a denylist because what it must keep out — the
 * bearer token, the port, every `ARGENT_SECRET_*` value — is exactly the set
 * that grows without this file being touched. Leak hygiene, not containment: a
 * script can read `~/.argent/tool-server.json` itself.
 */
const ALLOWED_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USER",
  "LOGNAME",
  "USERNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  // `SystemRoot` is required for DNS and crypto on Windows — a script that
  // makes any network call fails without it.
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "PUBLIC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Without these, a host using fnm, asdf, mise or volta runs against a
  // different Node than the developer's shell, or against none at all.
  "NODE_PATH",
  "NVM_DIR",
  "NVM_BIN",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "ASDF_DIR",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "VOLTA_HOME",
  "PNPM_HOME",
  "COREPACK_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_AVD_HOME",
  "ANDROID_USER_HOME",
  "JAVA_HOME",
  "GRADLE_USER_HOME",
  "DEVELOPER_DIR",
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "CI",
];

const NPM_CONFIG_ENV_PREFIX = "npm_config_";

const ALLOWED_ENV_PREFIXES: readonly string[] = [NPM_CONFIG_ENV_PREFIX];

/**
 * npm config keys that reach `NODE_OPTIONS`, and so carry through the prefix
 * above what the exact name is reserved to keep out. `node-options` is npm's
 * own spelling of the variable — it hands the key back as `NODE_OPTIONS` to
 * what it starts — and `userconfig` and `globalconfig` each name an `.npmrc`
 * npm would read that key from.
 */
const RESERVED_NPM_CONFIG_KEYS: readonly string[] = ["node-options", "userconfig", "globalconfig"];

/**
 * Refused in a caller-supplied environment map, because each steers the
 * runner's own process: `NODE_CHANNEL_FD` and `NODE_UNIQUE_ID` name the IPC
 * channel this protocol runs on, `ELECTRON_RUN_AS_NODE` decides whether the
 * child boots as Node at all, and the activation flag decides which process
 * the runner preload takes over.
 */
const RESERVED_ENV_NAMES: readonly string[] = [
  "NODE_CHANNEL_FD",
  "NODE_UNIQUE_ID",
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  RUNNER_ACTIVATION_ENV,
  // The bash exchange: `$ARGENT_OUTPUT` is where the document travels in and
  // out and `$ARGENT_REASON` is where a failure reason comes from, so either
  // one set by a caller would steer the runner's own protocol. Reserved
  // whichever language the step runs — a flow-level map applies to every step
  // — and set for bash only, since a `.mjs` has `output`.
  BASH_OUTPUT_ENV,
  BASH_REASON_ENV,
];

/**
 * One npm config has many environment spellings: npm matches the prefix without
 * regard to case, lowercases the rest, and reads `_` and `-` as the same
 * character everywhere but the key's first — so `npm_config_node_options`,
 * `npm_config_node-options` and `NPM_CONFIG_NODE_OPTIONS` are one name to it.
 * Refusing only the one written out would leave the others open on every
 * platform, which is why this does not go through the exact list above.
 */
function reservedNpmConfigName(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (!lower.startsWith(NPM_CONFIG_ENV_PREFIX)) return undefined;
  const key = lower.slice(NPM_CONFIG_ENV_PREFIX.length).replace(/(?!^)_/g, "-");
  return RESERVED_NPM_CONFIG_KEYS.includes(key) ? `${NPM_CONFIG_ENV_PREFIX}${key}` : undefined;
}

/** One spelling of each reserved name, for the refusal to name them all. */
function reservedEnvNamesForMessage(): string {
  return [
    ...RESERVED_ENV_NAMES,
    ...RESERVED_NPM_CONFIG_KEYS.map((key) => `${NPM_CONFIG_ENV_PREFIX}${key}`),
  ].join(", ");
}

export interface FlowScriptSecret {
  name: string;
  value: string;
}

export interface FlowScriptRequest {
  scriptPath: string;
  interpreter?: "node" | "bash";
  output?: Record<string, unknown>;
  env?: Record<string, string>;
  timeoutMs?: number;
  projectRoot?: string;
  flowDir?: string;
  secrets?: readonly FlowScriptSecret[];
  signal?: AbortSignal;
  runnerDir?: string;
}

export type FlowScriptFailureKind =
  | "load"
  | "runtime"
  | "output"
  | "protocol"
  | "timeout"
  | "cancelled"
  | "exit"
  | "signal"
  | "heap"
  | "spawn"
  | "queue"
  | "invalid";

export interface FlowScriptFailure {
  kind: FlowScriptFailureKind;
  message: string;
  stack?: string;
  /**
   * Set when this failure was raised with no child process in existence, so no
   * line of the author's script can have run. Most kinds answer that on their
   * own — a `queue` never left the queue, a `spawn` never started — but
   * `cancelled` reaches a caller from both sides of the fork, and a caller
   * telling its author there is nothing to clean up needs the answer proved
   * rather than guessed.
   */
  beforeFork?: true;
}

export interface FlowScriptResult {
  ok: boolean;
  output?: Record<string, unknown>;
  failure?: FlowScriptFailure;
  durationMs: number;
  queuedMs: number;
  notes: string[];
}

export interface FlowScriptExecutorOptions {
  concurrency?: number;
  maxTimeoutMs?: number;
  heapLimitMb?: number;
  queueWaitMs?: number;
  /**
   * Where a step's private exchange directory is made, and the root the
   * first-use sweep reads. `os.tmpdir()` unless a caller says otherwise — one
   * directory shared with every other argent on the machine, which is why the
   * sweep has to read each directory's own bound rather than apply its own.
   * A test passes a root of its own so that what it counts there is its own
   * steps and not the machine's.
   */
  exchangeRoot?: string;
  /**
   * How long a process waits before it re-reads {@link exchangeRoot} for
   * directories nobody owns any more. Defaults to
   * {@link EXCHANGE_SWEEP_INTERVAL_MS}; a test shortens it so a second step can
   * collect what the first one still had to leave alone.
   */
  exchangeSweepIntervalMs?: number;
}

interface ResolvedBounds {
  concurrency: number;
  maxTimeoutMs: number;
  heapLimitMb: number;
}

interface QueueWaiter {
  grant: () => void;
  refuse: (err: Error) => void;
  settled: boolean;
}

interface ExchangeFiles {
  dir: string;
  outputFile: string;
  reasonFile: string;
}

type ChildRun = {
  request: FlowScriptRequest;
  bounds: ResolvedBounds;
  notes: string[];
  startedAt: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runnerPath: string;
  outputJson: string;
  scriptPath: string;
  timeoutMs: number;
  stderrWatch: StderrSignalWatch;
} & (
  | { interpreter: "node" }
  | { interpreter: "bash"; interpreterPath: string; exchange: ExchangeFiles }
);

class ScriptCancelledError extends Error {}

class ScriptSetupError extends Error {
  constructor(
    readonly kind: FlowScriptFailureKind,
    message: string
  ) {
    super(message);
    this.name = "ScriptSetupError";
  }
}

export class FlowScriptExecutor {
  private running = 0;
  private readonly waiting: QueueWaiter[] = [];
  private concurrencyLimit: number | undefined;

  constructor(private readonly options: FlowScriptExecutorOptions = {}) {}

  /**
   * Read again for every step, never memoized: both bounds below are
   * schema-driven configuration, and the reference page promises that editing
   * either file takes effect on the next request. The executor a tool server
   * runs steps through is shared and lives as long as the process, so holding
   * these would make that promise "on the next restart" for these two keys
   * alone.
   */
  private resolveBounds(): ResolvedBounds {
    return {
      concurrency: this.concurrency(),
      maxTimeoutMs: Math.min(
        MAX_TIMER_MS,
        Math.max(
          MIN_SCRIPT_TIMEOUT_MS,
          positive(this.options.maxTimeoutMs) ??
            configuredNumber("scripts.maxTimeoutMs") ??
            5 * 60_000
        )
      ),
      // Floored, not just defaulted: a heap too small to start V8 fails
      // during the child's own startup, naming neither this bound nor the
      // value that caused it.
      heapLimitMb: Math.max(
        MIN_SCRIPT_HEAP_LIMIT_MB,
        positive(this.options.heapLimitMb) ?? configuredNumber("scripts.heapLimitMb") ?? 512
      ),
    };
  }

  /**
   * Settled once, unlike the two above: it is not configuration, and the queue
   * counts against it while steps are in flight — a limit that moved under a
   * half-drained queue would let more run at once than either value allows.
   */
  private concurrency(): number {
    this.concurrencyLimit ??= positive(this.options.concurrency) ?? defaultConcurrency();
    return this.concurrencyLimit;
  }

  get activeCount(): number {
    return this.running;
  }

  async execute(request: FlowScriptRequest): Promise<FlowScriptResult> {
    const bounds = this.resolveBounds();
    const queueStarted = Date.now();
    let release: (() => void) | undefined;
    try {
      release = await this.acquireSlot(
        request.signal,
        Math.min(MAX_TIMER_MS, positive(this.options.queueWaitMs) ?? bounds.maxTimeoutMs * 2)
      );
    } catch (err) {
      const queuedMs = Date.now() - queueStarted;
      return err instanceof ScriptCancelledError
        ? emptyResult({ kind: "cancelled", message: err.message }, { queuedMs })
        : emptyResult({ kind: "queue", message: errorMessage(err) }, { queuedMs });
    }
    const queuedMs = Date.now() - queueStarted;
    try {
      const result = await this.runOne(request, bounds);
      result.queuedMs = queuedMs;
      if (queuedMs > QUEUE_WAIT_REPORT_MS) {
        result.notes.push(
          `Waited ${(queuedMs / 1000).toFixed(1)}s for a free script slot ` +
            `(${bounds.concurrency} scripts run at once on this host).`
        );
      }
      return result;
    } finally {
      release();
    }
  }

  private acquireSlot(signal: AbortSignal | undefined, waitBoundMs: number): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.running -= 1;
      this.drain();
    };
    if (signal?.aborted) {
      return Promise.reject(
        new ScriptCancelledError("The run was cancelled before the script started.")
      );
    }
    if (this.running < this.concurrency()) {
      this.running += 1;
      return Promise.resolve(release);
    }
    if (this.waiting.length >= QUEUE_DEPTH_LIMIT) {
      return Promise.reject(
        new Error(
          `${QUEUE_DEPTH_LIMIT} script steps are already waiting for a free slot on this ` +
            `tool server; the queue is full. This host is saturated — nothing was run.`
        )
      );
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: QueueWaiter = {
        settled: false,
        grant: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          cleanup();
          resolve(release);
        },
        refuse: (err) => {
          if (waiter.settled) return;
          waiter.settled = true;
          cleanup();
          remove();
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        waiter.refuse(
          new Error(
            `Timed out after ${describeDuration(waitBoundMs)} waiting for a free script ` +
              `slot on this tool server. This host is saturated — nothing was run.`
          )
        );
      }, waitBoundMs);
      const onAbort = () => {
        waiter.refuse(
          new ScriptCancelledError("The run was cancelled while the script waited for a slot.")
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const remove = () => {
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private drain(): void {
    const limit = this.concurrency();
    while (this.running < limit) {
      const waiter = this.waiting.shift();
      if (!waiter) return;
      if (waiter.settled) continue;
      this.running += 1;
      waiter.grant();
    }
  }

  private async runOne(
    request: FlowScriptRequest,
    bounds: ResolvedBounds
  ): Promise<FlowScriptResult> {
    const notes: string[] = [];
    const startedAt = Date.now();
    if (request.signal?.aborted) {
      return emptyResult(
        { kind: "cancelled", message: "The run was cancelled before the script started." },
        { notes }
      );
    }
    let cwd: string;
    let env: NodeJS.ProcessEnv;
    let runnerPath: string;
    let outputJson: string;
    try {
      cwd = resolveWorkingDirectory(request, notes);
      env = buildChildEnv(request.env);
      runnerPath = resolveRunnerPath(request.runnerDir);
      outputJson = encodeRequestOutput(request.output);
    } catch (err) {
      const kind = err instanceof ScriptSetupError ? err.kind : "spawn";
      return emptyResult(
        { kind, message: errorMessage(err) },
        { notes, durationMs: Date.now() - startedAt }
      );
    }

    const timeoutMs = clampTimeout(request.timeoutMs, bounds.maxTimeoutMs, notes);
    const stderrWatch = new StderrSignalWatch();

    // The real path, not just the absolute one: Node resolves an entry module
    // through `realpath` and the runner re-imports that URL, so a different
    // spelling of the same file would be a second module and the script would
    // run twice.
    const scriptPath = realPathOrSelf(path.resolve(cwd, request.scriptPath));
    const interpreter = request.interpreter ?? "node";

    let interpreterPath: string | undefined;
    let exchange: ExchangeFiles | undefined;
    if (interpreter === "bash") {
      const found = await resolveBashInterpreter(request.projectRoot ?? request.flowDir);
      if (!("path" in found)) {
        return emptyResult(
          { kind: "spawn", message: found.problem },
          { notes, durationMs: Date.now() - startedAt }
        );
      }
      interpreterPath = found.path;
      try {
        exchange = createExchange(
          this.options.exchangeRoot ?? os.tmpdir(),
          outputJson,
          timeoutMs,
          positive(this.options.exchangeSweepIntervalMs) ?? EXCHANGE_SWEEP_INTERVAL_MS
        );
      } catch (err) {
        return emptyResult(
          {
            kind: "spawn",
            message: `The script's private exchange directory could not be created: ${errorMessage(err)}`,
          },
          { notes, durationMs: Date.now() - startedAt }
        );
      }
    }

    const common = {
      request,
      bounds,
      notes,
      startedAt,
      cwd,
      env,
      runnerPath,
      outputJson,
      scriptPath,
      timeoutMs,
      stderrWatch,
    };
    try {
      // The signal again, because the bash block above is the only place this
      // path suspends: the interpreter lookup is two spawns of its own, and a
      // cancellation raised across them found the next check only AFTER the
      // fork — so the script's first lines had already run. A `.mjs` step has
      // no such gap, and this closes the one bash mode opened.
      if (request.signal?.aborted) {
        return emptyResult(
          { kind: "cancelled", message: "The run was cancelled before the script started." },
          { notes, durationMs: Date.now() - startedAt }
        );
      }
      return await this.runChild(
        interpreterPath && exchange
          ? { ...common, interpreter: "bash", interpreterPath, exchange }
          : { ...common, interpreter: "node" }
      );
    } finally {
      // Every path — pass, fail, timeout, cancellation, a `fork` that threw —
      // after the process tree is stopped and the pipes are destroyed. A
      // removal that fails (Windows answers EBUSY while a surviving descendant
      // holds a file) is a note, never a throw: `execute` owes its caller a
      // verdict.
      if (exchange) removeExchange(exchange, notes);
    }
  }

  private async runChild(run: ChildRun): Promise<FlowScriptResult> {
    const { request, bounds, notes, startedAt, cwd, env, scriptPath, timeoutMs, stderrWatch } = run;

    let child: ChildProcess;
    try {
      // `windowsHide` is a documented `fork` option that this @types/node
      // release does not carry on ForkOptions; widen rather than drop it.
      const forkOptions: ForkOptions & { windowsHide?: boolean } = {
        cwd,
        env,
        // Set, never appended to: `fork` defaults `execArgv` to the parent's,
        // which would carry a dev-mode parent's ts-node/vitest loaders and any
        // inspector flag into every script process.
        //
        // In node mode the runner rides in as a preload, not as the entry
        // module, so the *script* is what `process.argv[1]`/`require.main` name
        // and an "am I the main module?" guard runs its body. Node awaits an
        // `--import` module before the entry, which leaves room for the
        // handshake. In bash mode there is no JavaScript entry to preload in
        // front of, so the runner IS the entry — its activation guard
        // (`isMainThread` plus the flag in the environment) admits both.
        execArgv:
          run.interpreter === "bash"
            ? [`--max-old-space-size=${bounds.heapLimitMb}`]
            : [
                `--max-old-space-size=${bounds.heapLimitMb}`,
                "--import",
                pathToFileURL(run.runnerPath).href,
              ],
        // Index 3 is a sink, and the protocol channel sits above it. The
        // channel is inherited by the script, Node parses it inside its own
        // read callback, and a line that is not JSON throws from there — which
        // reaches the tool server as an uncaughtException and takes the whole
        // process down with it, the one thing this child exists to prevent. A
        // write to descriptor 3 is the shape that reaches it: it is the first
        // free number, so a feature-detecting shim or a daemonizing helper
        // finds it without looking. Pointed at the null device, such a write
        // fails on its own instead. Node deletes `NODE_CHANNEL_FD` from the
        // child's environment, so nothing names the real one.
        //
        // Index 4 is the lifeline: a pipe the parent holds open and never uses.
        // Its closing is how a runner learns its parent is gone.
        stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "ipc"],
        // On POSIX the runner leads its own process group so a group stop
        // aimed at the tool server does not also stop it, and so a group stop
        // aimed at the runner reaches its descendants. Windows has no such
        // group; `taskkill /T` covers the tree there instead.
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
      };
      child = fork(run.interpreter === "bash" ? run.runnerPath : scriptPath, [], forkOptions);
    } catch (err) {
      return emptyResult(
        { kind: "spawn", message: `Could not start the script process: ${errorMessage(err)}` },
        { notes, durationMs: Date.now() - startedAt }
      );
    }

    // Unref'd because the lifeline end holds a reference on the tool server's
    // event loop, which would keep the server alive past its idle shutdown.
    // Never read from or write to it — the runner only watches for its close.
    const lifeline = child.stdio[4] as
      | { unref?: () => void; destroy?: () => void }
      | null
      | undefined;
    lifeline?.unref?.();

    let startedSeen = false;
    let terminal: ScriptTerminalResponse | null = null;
    let protocolProblem: string | null = null;
    let spawnProblem: string | null = null;
    let interrupted: "timeout" | "cancelled" | null = null;
    let interruptionSealed = false;

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", (err) => {
          spawnProblem ??= `Could not start the script process: ${errorMessage(err)}`;
          resolve({ code: null, signal: null });
        });
      }
    );
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    let stopped: Promise<void> | undefined;
    const stop = () => (stopped ??= stopProcessTree(child, STOP_GRACE_MS));

    /**
     * `??=` because the first interruption is the true one: a script that
     * survives SIGTERM until its deadline passes was cancelled, not timed out.
     *
     * The seal keeps a stop from being reported as a pass: a script with the
     * ordinary SIGTERM handler empties its event loop and lets the runner
     * report a half-written document as a result. Sealing and the kill share
     * one check-phase callback, in that order, so a message answering the
     * SIGTERM cannot precede the seal, while one already readable is delivered
     * in the same iteration's poll phase.
     */
    const interrupt = (why: "timeout" | "cancelled") => {
      interrupted ??= why;
      setImmediate(() => {
        interruptionSealed = true;
        void stop();
      });
    };

    // Drained, never kept: what a script prints is nobody's to read here, but a
    // pipe left paused fills its buffer and blocks the child from ever reaching
    // its own time limit. `resume()` discards stdout as it arrives; stderr goes
    // through the one reader that survives, which holds nothing beyond the
    // window it matches against and forwards no text of its own — a match sets
    // a flag, and argent writes whatever sentence that flag earns.
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => stderrWatch.push(chunk));

    child.on("message", (raw) => {
      if (terminal) return;
      const message = parseScriptResponse(raw, run.interpreter);
      if (!message) {
        protocolProblem ??= `The script runner sent a message the executor does not recognise: ${describeUnknown(raw)}`;
        void stop();
        return;
      }
      if (!isTerminalResponse(message)) {
        startedSeen = true;
        return;
      }
      if (interruptionSealed) return;
      terminal = message;
    });

    const deadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => interrupt("timeout"), timeoutMs);
    const onAbort = () => interrupt("cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    const message: ScriptExecuteRequest =
      run.interpreter === "bash"
        ? {
            type: "execute",
            interpreter: "bash",
            interpreterPath: run.interpreterPath,
            // Forward slashes on every platform. Git Bash takes `C:/…` both
            // as an argument and in a redirection, and this is what gives `$0`
            // a separator `dirname "${BASH_SOURCE[0]}"` can split on — a
            // backslash is an ordinary character to `dirname`, which would
            // answer `.` for every path. It is not about escaping: bash does no
            // escape processing on the RESULT of a parameter expansion.
            //
            // These three strings, and no others. The environment the step
            // forwards reaches bash as the host wrote it — `JAVA_HOME`,
            // `LOCALAPPDATA`, `USERPROFILE` and the rest are `C:\…` there, and
            // only `PATH`, `HOME`, `TMP`, `TEMP` and `TMPDIR` are converted, by
            // the msys runtime rather than by anything here. `cwd` is left
            // alone too: it goes to `CreateProcessW`, not to bash.
            scriptPath: toForwardSlashes(scriptPath),
            outputFile: toForwardSlashes(run.exchange.outputFile),
            outputJson: run.outputJson,
            reasonFile: toForwardSlashes(run.exchange.reasonFile),
            deadlineMs: timeoutMs + CHILD_DEADLINE_MARGIN_MS,
            maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
          }
        : {
            type: "execute",
            interpreter: "node",
            scriptUrl: pathToFileURL(scriptPath).href,
            outputJson: run.outputJson,
            deadlineMs: timeoutMs + CHILD_DEADLINE_MARGIN_MS,
            maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
          };
    try {
      child.send(message, (err) => {
        if (!err) return;
        protocolProblem ??= `The script runner closed its channel before the request arrived: ${errorMessage(err)}`;
        void stop();
      });
    } catch (err) {
      protocolProblem ??= `The script runner could not be given its request: ${errorMessage(err)}`;
      void stop();
    }

    const exit = await exited;
    const deadlinePassed = Date.now() >= deadlineAt;
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);

    // The protocol runs on IPC and stderr on its own pipe, with no shared order
    // between them: a terminal message routinely arrives *before* the last text
    // the same script wrote. V8's heap banner is in that text, and the watch
    // can only match what reached it, so waiting for the close is what puts
    // those chunks in before the destroys below. The bound covers a descendant
    // that inherited the streams and is holding them open.
    await Promise.race([closed, sleep(SETTLE_TIMEOUT_MS)]);
    await stop();
    child.stdout?.destroy();
    child.stderr?.destroy();
    lifeline?.destroy?.();
    if (child.connected) child.disconnect();

    const verdict = redactSecrets(
      classifyOutcome({
        exit,
        spawnProblem,
        protocolProblem,
        terminal,
        startedSeen,
        interrupted,
        timeoutMs,
        deadlinePassed,
        heapFatalSeen: stderrWatch.heapFatalSeen,
        heapLimitMb: bounds.heapLimitMb,
      }),
      request.secrets ?? []
    );

    // A watchdog that never armed says so on stderr and nowhere else, so this
    // flag is the whole of what outlives the drain. Nothing went wrong inside
    // the script, so it rides `notes` beside the clamped-timeout and
    // wrong-directory notes rather than moving the verdict.
    if (stderrWatch.watchdogProblemSeen) {
      notes.push(
        `A watchdog for this step did not arm, so a process the script started can outlive a ` +
          `tool server that dies afterwards.`
      );
    }

    return {
      ...verdict,
      durationMs: Date.now() - startedAt,
      queuedMs: 0,
      notes,
    };
  }
}

let shared: FlowScriptExecutor | undefined;

export function flowScriptExecutor(): FlowScriptExecutor {
  shared ??= new FlowScriptExecutor();
  return shared;
}

interface ClassifyInput {
  exit: { code: number | null; signal: NodeJS.Signals | null };
  spawnProblem: string | null;
  protocolProblem: string | null;
  terminal: ScriptTerminalResponse | null;
  startedSeen: boolean;
  interrupted: "timeout" | "cancelled" | null;
  timeoutMs: number;
  deadlinePassed: boolean;
  heapFatalSeen: boolean;
  heapLimitMb: number;
}

function classifyOutcome(
  input: ClassifyInput
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  const { exit } = input;
  if (input.spawnProblem) return failed("spawn", input.spawnProblem);
  if (input.protocolProblem) return failed("protocol", input.protocolProblem);

  if (input.terminal) {
    if (input.terminal.type === "failure") {
      return failed(
        input.terminal.failureType,
        clampText(input.terminal.message, SCRIPT_MAX_FAILURE_MESSAGE_CHARS),
        clampText(input.terminal.stack, SCRIPT_MAX_FAILURE_STACK_CHARS)
      );
    }
    return commitOutput(input.terminal.outputJson);
  }

  if (input.interrupted === "cancelled") {
    return failed("cancelled", "The run was cancelled and the script process was stopped.");
  }

  if (input.interrupted === "timeout") return timedOut(input.timeoutMs);

  // V8 does not throw when it hits the heap limit: it prints a fatal error and
  // aborts. Ahead of the `startedSeen` row because a script can exhaust the
  // heap while it is still loading its imports.
  if (isHeapAbort(exit, input.heapFatalSeen)) {
    return failed("heap", `The script exceeded its ${input.heapLimitMb} MiB heap limit.`);
  }

  if (!input.startedSeen) {
    return failed(
      "protocol",
      `The script runner exited before it started the script (${describeExit(exit)}).`
    );
  }

  if (exit.signal) {
    // The clock rather than the timer, which a stall in the tool server's own
    // event loop can hold behind the exit it is racing. Past that stall the
    // child's deadline watchdog has already killed the group, and reporting its
    // SIGKILL as unexplained sends the author looking for a killer that is the
    // step's own time limit.
    if (input.deadlinePassed) return timedOut(input.timeoutMs);
    return failed(
      "signal",
      `The script process was killed by ${exit.signal} before it returned output. ` +
        `It did not stop itself.`
    );
  }

  return failed(
    "exit",
    `The script stopped its own process with exit code ${exit.code ?? 0} instead of returning, ` +
      `so it left no output document behind: throw the reason instead of exiting on it.`
  );
}

function redactSecrets(
  verdict: Pick<FlowScriptResult, "ok" | "output" | "failure">,
  secrets: readonly FlowScriptSecret[]
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  if (secrets.length === 0) return verdict;
  if (verdict.output) {
    const collision = scrubDocument(verdict.output, secrets);
    // Refused rather than resolved: the document cannot be both redacted and
    // whole, and dropping whichever entry lost would take it out of the
    // document later steps read with nothing to say it had ever been there.
    if (collision) {
      return failed(
        "output",
        `Two keys in the script's output become "${collision}" once the secret in them is ` +
          `redacted, so one would silently replace the other. Rename one of them.`
      );
    }
  }
  const failure = verdict.failure;
  if (!failure) return verdict;
  return {
    ...verdict,
    failure: {
      ...failure,
      message: redactTruncated(failure.message, secrets),
      ...(failure.stack ? { stack: redactTruncated(failure.stack, secrets) } : {}),
    },
  };
}

/**
 * Iterative rather than recursive: the document came from a child that ran
 * arbitrary code, and a megabyte of `[[[[…` is legal JSON that would overflow
 * the stack inside `execute`, which owes its caller a verdict, not a throw.
 *
 * Returns the redacted spelling two keys of one object share, when a rewrite
 * would land on a sibling that is already spelled that way; the caller refuses
 * the document rather than let one entry replace the other.
 */
function scrubDocument(
  root: Record<string, unknown>,
  secrets: readonly FlowScriptSecret[]
): string | undefined {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const value = node[i];
        if (typeof value === "string") node[i] = scrubSecretValues(value, secrets);
        else if (value !== null && typeof value === "object") pending.push(value);
      }
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (typeof value === "string") record[key] = scrubSecretValues(value, secrets);
      else if (value !== null && typeof value === "object") pending.push(value);
      const scrubbedKey = scrubSecretValues(key, secrets);
      if (scrubbedKey === key) continue;
      if (Object.prototype.hasOwnProperty.call(record, scrubbedKey)) return scrubbedKey;
      record[scrubbedKey] = record[key];
      delete record[key];
    }
  }
  return undefined;
}

function commitOutput(outputJson: string): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  const bytes = Buffer.byteLength(outputJson, "utf8");
  if (bytes > SCRIPT_MAX_OUTPUT_BYTES) {
    return failed(
      "output",
      `The script returned ${describeBytes(bytes)} of encoded output; the limit is ` +
        `${describeBytes(SCRIPT_MAX_OUTPUT_BYTES)}.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputJson);
  } catch (err) {
    return failed("output", `The script's output did not parse: ${errorMessage(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failed("output", "The script's output was not an object.");
  }
  const polluted = findOwnProtoKey(parsed as Record<string, unknown>);
  if (polluted !== undefined) {
    return failed(
      "output",
      `${polluted} has an own "__proto__" key; output must be JSON-compatible data.`
    );
  }
  return { ok: true, output: parsed as Record<string, unknown> };
}

/**
 * The runner refuses this before it encodes, and the parent re-checks for the
 * same reason it re-checks the size and the failure-text ceilings: the loader
 * resolves whichever `.mjs` sits beside the compiled executor, so a stale or
 * mismatched runner copy reaches this path. `JSON.parse` makes `__proto__` an
 * own key, and committing one hands whatever merges the document into flow
 * state a prototype to write rather than a property.
 *
 * Iterative for the reason `scrubDocument` is: the document came from a child
 * that ran arbitrary code, and a deep one would overflow the stack inside a
 * call that owes its caller a verdict, not a throw.
 */
function findOwnProtoKey(root: Record<string, unknown>): string | undefined {
  const pending: Array<{ node: unknown; at: string }> = [{ node: root, at: "output" }];
  while (pending.length > 0) {
    const { node, at } = pending.pop()!;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const value = node[i];
        if (value !== null && typeof value === "object") {
          pending.push({ node: value, at: `${at}[${i}]` });
        }
      }
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === "__proto__") return at;
      const value = record[key];
      if (value !== null && typeof value === "object") {
        pending.push({ node: value, at: `${at}${memberPath(key)}` });
      }
    }
  }
  return undefined;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Follows the runner's own `memberPath`, which this file cannot import. */
function memberPath(key: string): string {
  return IDENTIFIER_RE.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * A failure message is clamped by the child, the only side that can bound what
 * crosses the channel, and the child has no secret list — so a value straddling
 * the cut leaves a prefix that a whole-value replacement never matches. That
 * tail is dropped and counted, and only on text whose marker says it was cut.
 */
function redactTruncated(text: string, secrets: readonly FlowScriptSecret[]): string {
  const scrubbed = scrubSecretValues(text, secrets);
  const omission = OMISSION_RE.exec(scrubbed);
  const kept = omission ? null : REASON_KEPT_RE.exec(scrubbed);
  const marker = omission ?? kept;
  if (!marker) return scrubbed;
  const head = scrubbed.slice(0, marker.index);
  const partial = partialSecretTail(head, secrets);
  if (partial === 0) return scrubbed;
  const shortened = head.slice(0, head.length - partial);
  if (omission) return `${shortened}${omissionMarker(Number(omission[1]) + partial)}`;
  return `${shortened}${kept![1]}${Number(kept![2]) - partial}${kept![3]}`;
}

const OMISSION_RE = /… \[(\d+) more characters omitted]$/;

/**
 * The runner's own marker, for a `$ARGENT_REASON` it read only the head of. It
 * counts what it KEPT rather than what it dropped: a bounded read cannot know
 * how many characters the whole file holds, and the file's size is what it says
 * instead. So the count moves the other way when a half of a secret is taken
 * off the end above.
 *
 * In step with `readReasonFile` in `flow-script-runner.mjs`, which this file
 * cannot import. A wording that drifts apart stops matching and the tail is
 * left in place, which is why a real bash step is what pins the pair.
 */
const REASON_KEPT_RE =
  /(… \[\$ARGENT_REASON holds [^\]]*; this report keeps the first )(\d+)( characters])$/;

function omissionMarker(omitted: number): string {
  return `… [${omitted} more characters omitted]`;
}

/**
 * The marker counts against the ceiling, as it does in the runner's copy of
 * this function, so re-applying the same ceiling downstream cannot cut again
 * and report only how much of the *marker* it dropped.
 */
function clampText(text: string, max: number): string;
function clampText(text: string | undefined, max: number): string | undefined;
function clampText(text: string | undefined, max: number): string | undefined {
  if (text === undefined || text.length <= max) return text;
  let cut = max;
  let marked = `${text.slice(0, cut)}${omissionMarker(text.length - cut)}`;
  while (marked.length > max && cut > 0) {
    cut = Math.max(0, cut - (marked.length - max));
    marked = `${text.slice(0, cut)}${omissionMarker(text.length - cut)}`;
  }
  return marked;
}

function timedOut(timeoutMs: number): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  return failed(
    "timeout",
    `The script did not finish within its ${describeDuration(timeoutMs)} time limit ` +
      `and its process tree was stopped.`
  );
}

function failed(
  kind: FlowScriptFailureKind,
  message: string,
  stack?: string
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  return { ok: false, failure: { kind, message, ...(stack ? { stack } : {}) } };
}

function isHeapAbort(
  exit: { code: number | null; signal: NodeJS.Signals | null },
  heapFatalSeen: boolean
): boolean {
  if (!heapFatalSeen) return false;
  // A signal, never an exit code. 128+SIGABRT is a *shell's* way of reporting
  // an aborted child, and there is no shell between the executor and the
  // runner — but there often is one inside the script: a wrapper forwarding a
  // build's status returns 134 while allocating nothing itself, and the build's
  // own banner lands in the inherited stream.
  if (exit.signal === "SIGABRT") return true;
  // Windows has no signal to report: an aborted child arrives as a plain exit
  // code, so the row above can never be reached there and a genuine heap
  // exhaustion would be read as a script stopping itself. A wrapper forwarding
  // one of these codes is the same false positive the 134 rule avoids on
  // POSIX; there is nothing left to tell the two apart, and mistaking a
  // forwarded status is the lesser fault of the two.
  return process.platform === "win32" && exit.code !== null && WINDOWS_ABORT_CODES.has(exit.code);
}

/** `abort()` through the CRT, and the fast-fail path V8 takes instead of it. */
const WINDOWS_ABORT_CODES = new Set([3, 0xc0000409]);

function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit code ${exit.code ?? 0}`;
}

/**
 * Always set explicitly, never inherited: the tool server's own cwd is whatever
 * the editor that spawned it chose.
 *
 * The existence check is load-bearing: `project_root` names the *calling
 * agent's* working directory and can be mistyped or since moved, and without it
 * the child fails with a bare `ENOENT` naming a path the author never wrote.
 */
function resolveWorkingDirectory(request: FlowScriptRequest, notes: string[]): string {
  const candidates: Array<{ label: string; value: string | undefined }> = [
    { label: "project_root", value: request.projectRoot },
    { label: "the flow file's directory", value: request.flowDir },
  ];
  const named = candidates.filter((c) => c.value);
  const problems: string[] = [];
  for (const candidate of named) {
    const problem = describeDirectoryProblem(candidate.value!);
    if (!problem) {
      if (problems.length > 0) {
        notes.push(`${problems.join("; ")}; the script ran in ${candidate.value} instead.`);
      }
      return candidate.value!;
    }
    problems.push(`${candidate.label} ${candidate.value} ${problem}`);
  }
  throw new ScriptSetupError(
    "invalid",
    named.length === 0
      ? "No working directory was given for the script (neither project_root nor a flow directory)."
      : `No working directory exists on the machine running the tool server: ${problems.join("; ")}.`
  );
}

function describeDirectoryProblem(candidate: string): string | null {
  if (!path.isAbsolute(candidate)) {
    return "is not an absolute path (a relative path would resolve against the tool server's own working directory)";
  }
  if (candidate.split(/[\\/]+/).includes("..")) return 'contains a ".." segment';
  try {
    return fs.statSync(candidate).isDirectory() ? null : "is not a directory";
  } catch {
    return "does not exist";
  }
}

function encodeRequestOutput(output: Record<string, unknown> | undefined): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(output ?? {});
  } catch (err) {
    throw new ScriptSetupError(
      "invalid",
      `The flow output could not be encoded for the script: ${errorMessage(err)}`
    );
  }
  if (typeof encoded !== "string") {
    throw new ScriptSetupError("invalid", "The flow output could not be encoded for the script.");
  }
  return encoded;
}

/**
 * The document goes in, and the same file is what comes back out — which is
 * what makes the merge rule in a later PR identical for both languages, and
 * what lets a script that wants to ADD one key read what it was given first.
 * `reason.txt` is created empty so a script can append to it without a test.
 *
 * Both files carry the document, and the document may hold values derived from
 * a secret, so both are written 0600 rather than left to the umask. The barrier
 * that holds is the 0700 `mkdtemp` directory around them, not the mode on the
 * files: the docs teach writing a sibling and `mv`-ing it into place, and a
 * `mv` replaces the inode — so the document Argent reads back carries the
 * script's own umask, 0644 on an ordinary host.
 *
 * The directory carries the moment it stops being this step's own, in its own
 * name: `$TMPDIR` is shared by every argent install on the host, and the sweep
 * below is the only reader that has to tell a live directory from an abandoned
 * one. A name is the one place a sweeping process can read the OWNER's bound
 * rather than apply its own — an mtime can carry an age, and no age can express
 * the bound another install's step was given.
 *
 * A directory that was made and could not be filled is removed here. The
 * `finally` that owns the rest of its life is only reached with an exchange to
 * remove, and a throw from either write leaves the caller without one.
 */
function createExchange(
  root: string,
  outputJson: string,
  timeoutMs: number,
  sweepIntervalMs: number
): ExchangeFiles {
  sweepStaleExchanges(root, sweepIntervalMs);
  // Rounded UP to a whole millisecond, because the sweep below reads the stamp
  // back with `/^(\d+)-/` and a `timeout: 30000.5` in a flow file is a positive
  // finite number the parser keeps. A `.` in the name matches nothing there, so
  // the directory would be passed over for good — and rounding up never shortens
  // the bound the owner claimed.
  const ownUntil = Math.ceil(Date.now() + timeoutMs + EXCHANGE_LIFE_MARGIN_MS);
  const dir = fs.mkdtempSync(path.join(root, `${EXCHANGE_DIR_PREFIX}${ownUntil}-`));
  try {
    const outputFile = path.join(dir, EXCHANGE_OUTPUT_FILE);
    const reasonFile = path.join(dir, EXCHANGE_REASON_FILE);
    fs.writeFileSync(outputFile, outputJson, { encoding: "utf8", mode: EXCHANGE_FILE_MODE });
    fs.writeFileSync(reasonFile, "", { mode: EXCHANGE_FILE_MODE });
    return { dir, outputFile, reasonFile };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function removeExchange(exchange: ExchangeFiles, notes: string[]): void {
  try {
    fs.rmSync(exchange.dir, { recursive: true, force: true });
  } catch (err) {
    notes.push(
      `The script's private directory ${exchange.dir} could not be removed ` +
        `(${errorMessage(err)}); a later bash step sweeps it, once this step's ` +
        `own time limit has passed.`
    );
  }
}

let sweptStaleExchangesAt = 0;

/**
 * The orphan case has an owner too. When the tool server dies mid-step the
 * lifeline kills the runner and nobody reaches the directory — and the document
 * in it may hold values derived from a secret. So a bash step sweeps the
 * executor's own prefix, the way the test helper sweeps its fixture root.
 *
 * Throttled rather than done once. An abandoned directory is stamped with a
 * moment in the FUTURE — its dead owner's whole time limit still ahead of it —
 * so the first step of the next server reads it as live and passes over it. A
 * process that then never looked again left that directory for good, which is
 * not what a reader of this is promised. The interval is what keeps the cost a
 * single `readdir` a minute rather than one per step.
 *
 * Each directory names the moment it stops being its own step's, and that is
 * what decides. The bound has to come from the OWNER: `$TMPDIR` is shared by
 * every argent install on the host, `scripts.maxTimeoutMs` is a per-install
 * value, and applying this process's own to another's directory takes a live
 * step's exchange out from under it — which fails a correct script, and blames
 * the script for a file the host removed. So a name that carries no moment is
 * left alone: nothing this executor has ever written looks like that, and an
 * age is not a bound.
 *
 * The stamp is taken before the read, so a root this process cannot read costs
 * one failed `readdir` a minute and not one per bash step.
 */
function sweepStaleExchanges(root: string, sweepIntervalMs: number): void {
  const now = Date.now();
  if (now - sweptStaleExchangesAt < sweepIntervalMs) return;
  sweptStaleExchangesAt = now;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(EXCHANGE_DIR_PREFIX)) continue;
    const ownUntil = exchangeOwnedUntil(entry);
    if (ownUntil === undefined || ownUntil > now) continue;
    try {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    } catch {
      // Raced with the step that owns it, or with another server's own sweep.
    }
  }
}

function exchangeOwnedUntil(entry: string): number | undefined {
  const stamped = /^(\d+)-/.exec(entry.slice(EXCHANGE_DIR_PREFIX.length));
  if (!stamped) return undefined;
  const moment = Number(stamped[1]);
  return Number.isSafeInteger(moment) ? moment : undefined;
}

/** Exported for the test that pins the sweep against a directory it planted. */
export function exchangeDirPrefix(): string {
  return EXCHANGE_DIR_PREFIX;
}

function toForwardSlashes(candidate: string): string {
  return process.platform === "win32" ? candidate.replace(/\\/g, "/") : candidate;
}

function realPathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * The three layouts the runner can be in — the published bundle (beside
 * `tool-server.cjs` in `dist`), the compiled package and the workspace source
 * — are all `path.join(__dirname, name)`. The tool-server package is CommonJS,
 * so `__dirname` is available here and under vitest.
 */
function resolveRunnerPath(runnerDir: string | undefined): string {
  const dir = runnerDir ?? __dirname;
  const runner = path.join(dir, RUNNER_FILE);
  if (!fs.existsSync(runner)) {
    throw new ScriptSetupError(
      "spawn",
      `The script runner is missing from this installation (looked for ${runner}).`
    );
  }
  return runner;
}

function buildChildEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  // Windows environment names are case-insensitive, so a host may surface any
  // of these under non-canonical casing; POSIX names are exact.
  const caseInsensitive = process.platform === "win32";
  const allowed = new Set(
    ALLOWED_ENV_NAMES.map((name) => (caseInsensitive ? name.toLowerCase() : name))
  );
  const reservedName = (name: string) =>
    RESERVED_ENV_NAMES.find((candidate) =>
      caseInsensitive ? candidate.toLowerCase() === name.toLowerCase() : candidate === name
    ) ?? reservedNpmConfigName(name);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Ahead of the allowlist, because a prefix admits names nobody listed.
    if (reservedName(name)) continue;
    const key = caseInsensitive ? name.toLowerCase() : name;
    if (allowed.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[name] = value;
    }
  }

  // Under an Electron-based MCP host `process.execPath` is the Electron binary,
  // and ELECTRON_RUN_AS_NODE in our own environment is the only reason a plain
  // `fork` from it boots as Node. The allowlist does not carry the name, so it
  // has to be put back deliberately.
  if (isElectronHostedEnv()) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  for (const [name, value] of Object.entries(overrides ?? {})) {
    const problem = describeEnvNameProblem(name);
    if (problem) {
      throw new ScriptSetupError(
        "invalid",
        `${JSON.stringify(name)} cannot be an environment variable name for a script: it ${problem}.`
      );
    }
    if (reservedName(name)) {
      throw new ScriptSetupError(
        "invalid",
        `${name} cannot be set for a script: it steers the runner's own process ` +
          `(reserved names: ${reservedEnvNamesForMessage()}).`
      );
    }
    env[name] = value;
  }

  // Set last, so a caller cannot shadow it. The runner preload activates only
  // when it sees this and clears it before the script runs: `--import` is
  // inherited by a worker thread or a `fork` the script starts, and an
  // activated preload in either would wait for a request that is never sent.
  env[RUNNER_ACTIVATION_ENV] = "1";
  return env;
}

/**
 * Refused up front rather than handed to the operating system, which carries an
 * environment as `NAME=value` strings and has no way to say a name was
 * malformed: `=` in a name moves the split, so the script is given a variable
 * the flow never asked for and the step passes anyway, and a name that is empty
 * or holds a NUL leaves the child with an entry no reader can name. The map
 * comes from the step's `env:`, so the author is the one who can fix it.
 */
function describeEnvNameProblem(name: string): string | null {
  if (name === "") return "is empty";
  if (name.includes("=")) return 'contains "=", which is what separates a name from its value';
  if (name.includes("\0")) return "contains a NUL character";
  return null;
}

function clampTimeout(
  requested: number | undefined,
  maxTimeoutMs: number,
  notes: string[]
): number {
  const wanted = positive(requested);
  if (wanted === undefined) return Math.min(DEFAULT_SCRIPT_TIMEOUT_MS, maxTimeoutMs);
  if (wanted <= maxTimeoutMs) return wanted;
  notes.push(
    `The requested ${describeDuration(wanted)} time limit is above this host's maximum of ` +
      `${describeDuration(maxTimeoutMs)}; the step ran with the maximum.`
  );
  return maxTimeoutMs;
}

function defaultConcurrency(): number {
  const cpus = os.cpus()?.length || 1;
  return Math.max(2, Math.min(8, cpus - 2));
}

/** The largest delay `setTimeout` holds; past it Node clamps the timer to 1ms. */
const MAX_TIMER_MS = 2_147_483_647;

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function configuredNumber(key: string): number | undefined {
  const def = getConfigDefinition(key) as ConfigDefinition<number> | undefined;
  if (!def) return undefined;
  const value = getConfigValue(def);
  return typeof value === "number" && value > 0 ? value : undefined;
}

/**
 * POSIX names the runner's process group, which outlives the runner and holds
 * every descendant that did not deliberately leave it; an empty group is the
 * proof that the tree is gone. Windows has no such group, so `taskkill /T`
 * walks the live parent-child tree instead: a re-parented grandchild escapes
 * it, and once the child is gone there is nothing left to walk from. A
 * deliberately detached descendant is out of reach on either, which is how a
 * script outlives its step.
 */
async function stopProcessTree(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === "win32") {
    // Windows has no graceful stop for a console-less child, and `child.kill()`
    // is already `TerminateProcess` — it just does not reach the tree. Aim
    // `taskkill /t` at the child while its pid is still valid, and keep
    // `child.kill()` as the fallback for a `taskkill` that could not run.
    if (hasExited(child)) return;
    tryKill(() => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      // A `spawn` that cannot launch reports it through an asynchronous
      // `error` event, not a throw the `tryKill` above could catch, and an
      // unhandled `error` would end the tool server.
      killer.on("error", () => {});
      killer.unref();
    });
    await waitForGroupToEmpty(child, pid, graceMs);
    if (!hasExited(child)) tryKill(() => child.kill());
    return;
  }

  if (!groupHasMembers(pid)) return;
  killGroup(child, pid, "SIGTERM");
  await waitForGroupToEmpty(child, pid, graceMs);
  if (!groupHasMembers(pid)) return;
  killGroup(child, pid, "SIGKILL");
  // A SIGKILL is delivered at once but the kernel still has to tear the process
  // down, so the step would otherwise return a moment before the tree is
  // actually gone — and "stopped" is what the verdict claims.
  await waitForGroupToEmpty(child, pid, FORCE_GRACE_MS);
}

async function waitForGroupToEmpty(
  child: ChildProcess,
  pid: number,
  graceMs: number
): Promise<void> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (process.platform === "win32" ? hasExited(child) : !groupHasMembers(pid)) return;
    await sleep(GROUP_POLL_MS);
  }
}

/**
 * Signal 0 checks reachability without delivering anything, and `ESRCH` is the
 * only answer that means "nothing there": `EPERM` means the group exists and
 * this process may not signal it, which still counts as alive.
 */
function groupHasMembers(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function killGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      tryKill(() => child.kill(signal));
    }
  }
}

function tryKill(action: () => void): void {
  try {
    action();
  } catch {
    // Already gone is the outcome we wanted.
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * The two things stderr still owes, each kept as a flag and never as text.
 *
 * A script can print either banner itself, so what a match earns is a verdict
 * or a note that ARGENT wrote — never a byte the script chose. That is the
 * bargain the heap verdict already made, and the watchdog note joins it on the
 * same terms rather than reopening the channel this executor stopped keeping.
 */
class StderrSignalWatch {
  private readonly decoder = new StringDecoder("utf8");
  private heapFatal = false;
  private watchdogProblem = false;
  private tail = "";

  push(chunk: Buffer): void {
    this.scan(this.decoder.write(chunk));
  }

  get heapFatalSeen(): boolean {
    return this.heapFatal;
  }

  get watchdogProblemSeen(): boolean {
    return this.watchdogProblem;
  }

  private scan(text: string): void {
    if (!text || (this.heapFatal && this.watchdogProblem)) return;
    const window = this.tail + text;
    if (!this.heapFatal) this.heapFatal = V8_HEAP_FATAL_RE.test(window);
    if (!this.watchdogProblem) this.watchdogProblem = WATCHDOG_PROBLEM_RE.test(window);
    // The window is what lets a banner split across two chunks match, so it is
    // dropped only once NEITHER pattern is still looking for one.
    this.tail = this.heapFatal && this.watchdogProblem ? "" : window.slice(-STDERR_WINDOW_CHARS);
  }
}

function partialSecretTail(text: string, secrets: readonly FlowScriptSecret[]): number {
  let keep = 0;
  for (const { value } of secrets) {
    const longest = Math.min(value.length - 1, text.length);
    for (let n = longest; n > keep; n--) {
      if (text.endsWith(value.slice(0, n))) {
        keep = n;
        break;
      }
    }
  }
  return keep;
}

export function utf8SafeCut(buffer: Buffer, max: number): number {
  let cut = Math.min(max, buffer.length);
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  return cut;
}

/**
 * The result for a failure raised before anything was forked. Every caller is
 * on that side of the fork — a queue the step never left, a cancellation that
 * beat the fork, a request that could not be prepared, and a `fork` that threw
 * — which is what {@link FlowScriptFailure.beforeFork} reports to a caller
 * that has to say whether there is state to clean up.
 */
function emptyResult(
  failure: FlowScriptFailure,
  extras: { notes?: string[]; queuedMs?: number; durationMs?: number } = {}
): FlowScriptResult {
  return {
    ok: false,
    failure: { ...failure, beforeFork: true },
    durationMs: extras.durationMs ?? 0,
    queuedMs: extras.queuedMs ?? 0,
    notes: extras.notes ?? [],
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return formatErrorForAgent(err) || String(err);
  return typeof err === "string" ? err : describeUnknown(err);
}

function describeUnknown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

function describeDuration(ms: number): string {
  // A step may ask for `Infinity`, which the clamp handles but no unit does:
  // rendering it as a number would append the minutes suffix to a word.
  if (!Number.isFinite(ms)) return "unbounded";
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${minutes.toFixed(minutes % 1 === 0 ? 0 : 1)}m`;
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${ms}ms`;
}
