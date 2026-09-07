/**
 * Runs one trusted local JavaScript file in a fresh Node.js child process.
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
import {
  scrubSecretChunk,
  scrubSecretValues,
  SECRET_PLACEHOLDER_MARKER,
} from "../../../utils/secrets";
import { sleep } from "../../../utils/timing";
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
export const SCRIPT_STEP_LOG_LIMIT_BYTES = 64 * 1024;
const SCRIPT_RUN_LOG_LIMIT_BYTES = 256 * 1024;
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
const MAX_BUFFERED_LINE_CHARS = 8 * 1024;
/**
 * V8's heap-exhaustion banner. Coarse on purpose: the wording is not a
 * stability contract, and an unrecognized abort degrades to the signal report
 * rather than to a wrong verdict.
 */
const V8_HEAP_FATAL_RE = /FATAL ERROR:[^\n]*(?:heap limit|heap out of memory|Allocation failed)/i;
const HEAP_FATAL_WINDOW_CHARS = 256;

const RUNNER_FILE = "flow-script-runner.mjs";

const RUNNER_ACTIVATION_ENV = "ARGENT_FLOW_SCRIPT_RUNNER";

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

export interface FlowScriptLogBudget {
  remainingBytes: number;
}

export function createScriptLogBudget(): FlowScriptLogBudget {
  return { remainingBytes: SCRIPT_RUN_LOG_LIMIT_BYTES };
}

export interface FlowScriptRequest {
  scriptPath: string;
  output?: Record<string, unknown>;
  env?: Record<string, string>;
  timeoutMs?: number;
  projectRoot?: string;
  flowDir?: string;
  secrets?: readonly FlowScriptSecret[];
  logBudget?: FlowScriptLogBudget;
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
  log: string;
  logTruncated: boolean;
  durationMs: number;
  queuedMs: number;
  notes: string[];
}

export interface FlowScriptExecutorOptions {
  concurrency?: number;
  maxTimeoutMs?: number;
  heapLimitMb?: number;
  queueWaitMs?: number;
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
    const capture = new ScriptLogCapture(
      () => request.secrets ?? [],
      SCRIPT_STEP_LOG_LIMIT_BYTES,
      request.logBudget
    );

    // The real path, not just the absolute one: Node resolves an entry module
    // through `realpath` and the runner re-imports that URL, so a different
    // spelling of the same file would be a second module and the script would
    // run twice.
    const scriptPath = realPathOrSelf(path.resolve(cwd, request.scriptPath));

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
        // The runner rides in as a preload, not as the entry module, so the
        // *script* is what `process.argv[1]`/`require.main` name and an "am I
        // the main module?" guard runs its body. Node awaits an `--import`
        // module before the entry, which leaves room for the handshake.
        execArgv: [
          `--max-old-space-size=${bounds.heapLimitMb}`,
          "--import",
          pathToFileURL(runnerPath).href,
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
      child = fork(scriptPath, [], forkOptions);
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

    child.stdout?.on("data", (chunk: Buffer) => capture.push("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture.push("stderr", chunk));

    child.on("message", (raw) => {
      if (terminal) return;
      const message = parseScriptResponse(raw);
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

    const message: ScriptExecuteRequest = {
      type: "execute",
      scriptUrl: pathToFileURL(scriptPath).href,
      outputJson,
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

    // The protocol runs on IPC and the logs on the standard streams, with no
    // shared order between them: a terminal message routinely arrives *before*
    // the log text of the same script. The bound covers a descendant that
    // inherited the streams and is holding them open.
    await Promise.race([closed, sleep(SETTLE_TIMEOUT_MS)]);
    await stop();
    capture.end();
    child.stdout?.destroy();
    child.stderr?.destroy();
    lifeline?.destroy?.();
    if (child.connected) child.disconnect();

    const log = capture.text;
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
        heapFatalSeen: capture.heapFatalSeen,
        heapLimitMb: bounds.heapLimitMb,
      }),
      request.secrets ?? []
    );

    return {
      ...verdict,
      log,
      logTruncated: capture.truncated,
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
    `The script stopped its own process with exit code ${exit.code ?? 0} instead of returning; ` +
      `no output was captured.`
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
  if (!omission) return scrubbed;
  const head = scrubbed.slice(0, omission.index);
  const partial = partialSecretTail(head, secrets);
  if (partial === 0) return scrubbed;
  const omitted = Number(omission[1]) + partial;
  return `${head.slice(0, head.length - partial)}${omissionMarker(omitted)}`;
}

const OMISSION_RE = /… \[(\d+) more characters omitted]$/;

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

interface StreamState {
  decoder: StringDecoder;
  holdback: string;
  holdbackAt?: number;
  collapser?: V8FrameCollapser;
  watchForHeapFatal?: boolean;
}

/**
 * stdout and stderr, captured into one buffer in arrival order.
 *
 * Console text deliberately does *not* also travel over IPC: any subprocess the
 * script starts writes to the same two descriptors, and an IPC message is
 * serialized whole — one large `console.log` could not be limited while
 * draining, as pipe data can. Arrival order is faithful to written order except
 * for a burst written to *both* streams inside one turn, and nothing else here
 * may add reordering on top of that.
 *
 * Redaction runs on the live stream, ahead of both limits: a value can straddle
 * two pipe chunks and a per-chunk replacement sees neither half, and one
 * straddling the truncation cut would leave a prefix that a whole-value
 * replacement never matches.
 */
class ScriptLogCapture {
  private readonly parts: string[] = [];
  private readonly streams = new Map<string, StreamState>();
  private stepRemaining: number;
  private truncatedFlag = false;
  private cut = false;
  private heapFatalFlag = false;
  private heapFatalTail = "";

  constructor(
    private readonly secrets: () => readonly FlowScriptSecret[],
    stepLimitBytes: number,
    private readonly runBudget?: FlowScriptLogBudget
  ) {
    this.stepRemaining = stepLimitBytes;
  }

  /**
   * Never pauses the stream: a paused one fills the pipe buffer and blocks the
   * child from ever reaching its own time limit, so past the log limit the data
   * is still drained and discarded.
   */
  push(stream: "stdout" | "stderr", chunk: Buffer): void {
    const state = this.stateFor(stream);
    this.consume(state, state.decoder.write(chunk), false);
  }

  end(): void {
    for (const state of this.streams.values()) {
      this.consume(state, state.decoder.end(), true);
      if (state.collapser) {
        this.append(state.collapser.end());
        if (state.collapser.collapsed) this.truncatedFlag = true;
      }
    }
    this.streams.clear();
  }

  get text(): string {
    return scrubSecretValues(this.parts.join(""), this.secrets());
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  get heapFatalSeen(): boolean {
    return this.heapFatalFlag;
  }

  private watchForHeapFatal(text: string): void {
    if (this.heapFatalFlag) return;
    const window = this.heapFatalTail + text;
    if (V8_HEAP_FATAL_RE.test(window)) {
      this.heapFatalFlag = true;
      this.heapFatalTail = "";
      return;
    }
    this.heapFatalTail = window.slice(-HEAP_FATAL_WINDOW_CHARS);
  }

  private stateFor(stream: "stdout" | "stderr"): StreamState {
    let state = this.streams.get(stream);
    if (!state) {
      state = {
        decoder: new StringDecoder("utf8"),
        holdback: "",
        ...(stream === "stderr"
          ? { collapser: new V8FrameCollapser(), watchForHeapFatal: true }
          : {}),
      };
      this.streams.set(stream, state);
    }
    return state;
  }

  private consume(state: StreamState, text: string, final: boolean): void {
    if (!text && !final) return;
    if (state.watchForHeapFatal) this.watchForHeapFatal(text);
    const secrets = this.secrets();
    const held = state.holdback;
    const pending = held + text;
    const { emit, held: keep } = scrubSecretChunk(pending, secrets, final);
    const split = pending.length - keep;
    state.holdback = pending.slice(split);
    this.release(state, held.slice(0, split), emit);
    if (state.collapser?.collapsed) this.truncatedFlag = true;
    if (!state.holdback) state.holdbackAt = undefined;
    else if (split >= held.length) state.holdbackAt = this.parts.push("") - 1;
  }

  private release(state: StreamState, released: string, emit: string): void {
    const at = state.holdbackAt;
    if (at === undefined || !emit) {
      this.append(state.collapser ? state.collapser.write(emit) : emit);
      return;
    }
    const head = scrubSecretValues(released, this.secrets());
    const headText = emit.startsWith(head) ? head : "";
    this.append(state.collapser ? state.collapser.write(headText) : headText, at);
    const tailText = emit.slice(headText.length);
    this.append(state.collapser ? state.collapser.write(tailText) : tailText);
  }

  private append(text: string, at?: number): void {
    if (!text) return;
    const runRemaining = this.runBudget
      ? Math.max(0, this.runBudget.remainingBytes)
      : Number.POSITIVE_INFINITY;
    const allowed = Math.min(this.stepRemaining, runRemaining);
    // Once a cut has happened the log ends there: what follows would read as
    // the text that came next, and the bytes the cut gave back — a partial
    // character, a partial marker — are room enough to admit some of it.
    if (this.cut || allowed <= 0) {
      this.truncatedFlag = true;
      return;
    }
    const buffer = Buffer.from(text, "utf8");
    let taken = buffer.length <= allowed ? buffer.length : utf8SafeCut(buffer, allowed);
    if (taken < buffer.length) {
      this.truncatedFlag = true;
      this.cut = true;
      // The cut lands wherever the budget runs out, which may be inside a
      // marker the scrub wrote. No value escapes either way, but a downstream
      // reader parsing markers would read a placeholder naming no secret, so
      // the fragment is given back rather than committed.
      taken = withoutPartialMarker(buffer, taken);
    }
    if (taken > 0) {
      const kept = taken === buffer.length ? text : buffer.subarray(0, taken).toString("utf8");
      if (at === undefined) this.parts.push(kept);
      else this.parts[at] += kept;
      this.stepRemaining -= taken;
      if (this.runBudget) this.runBudget.remainingBytes -= taken;
    }
  }
}

/**
 * How much of `buffer` is left once a trailing fragment of a
 * `{{secret:NAME}}` marker is dropped: an opening the cut never closed, or the
 * beginning of one. Marker text is ASCII, so byte offsets are character
 * offsets here.
 */
function withoutPartialMarker(buffer: Buffer, taken: number): number {
  const text = buffer.subarray(0, taken).toString("utf8");
  const open = text.lastIndexOf(SECRET_PLACEHOLDER_MARKER);
  if (open >= 0 && !text.includes("}}", open + SECRET_PLACEHOLDER_MARKER.length)) {
    return Buffer.byteLength(text.slice(0, open), "utf8");
  }
  for (let n = Math.min(SECRET_PLACEHOLDER_MARKER.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(SECRET_PLACEHOLDER_MARKER.slice(0, n))) return taken - n;
  }
  return taken;
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

const V8_FRAME_RE = /^\s*\d+:\s+0x[0-9a-f]+/i;
/**
 * What a V8 frame dump follows; until one of these prints, nothing is
 * collapsed. Coarse on purpose: a false arm costs a marker line in place of
 * frame-shaped output, while a missed dump costs sixty lines of log budget.
 */
const ARM_FRAME_COLLAPSE_RE = /FATAL ERROR|Fatal error in|Fatal JavaScript|# Fatal/i;
const COLLAPSE_THRESHOLD = 3;

class V8FrameCollapser {
  private partial = "";
  private held: string[] = [];
  private heldCount = 0;
  private armed = false;
  private armWindow = "";
  private collapsedAny = false;

  get collapsed(): boolean {
    return this.collapsedAny;
  }

  write(text: string): string {
    if (!text) return "";
    if (!this.armed) {
      const armed = ARM_FRAME_COLLAPSE_RE.test(this.armWindow + text);
      this.armWindow = armed ? "" : (this.armWindow + text).slice(-HEAP_FATAL_WINDOW_CHARS);
      if (!armed) return text;
      this.armed = true;
    }
    this.partial += text;
    let out = "";
    const lines = this.partial.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) out += this.classify(`${line}\n`);
    if (this.partial.length > MAX_BUFFERED_LINE_CHARS) {
      out += this.flush() + this.partial;
      this.partial = "";
    }
    return out;
  }

  end(): string {
    if (!this.armed) return "";
    let out = "";
    if (this.partial) {
      out += this.classify(this.partial);
      this.partial = "";
    }
    return out + this.flush();
  }

  private classify(line: string): string {
    if (V8_FRAME_RE.test(line)) {
      this.heldCount += 1;
      if (this.held.length < COLLAPSE_THRESHOLD - 1) this.held.push(line);
      return "";
    }
    return this.flush() + line;
  }

  private flush(): string {
    if (this.heldCount === 0) return "";
    const collapsing = this.heldCount >= COLLAPSE_THRESHOLD;
    if (collapsing) this.collapsedAny = true;
    const out = collapsing ? `[${this.heldCount} V8 stack frames omitted]\n` : this.held.join("");
    this.held = [];
    this.heldCount = 0;
    return out;
  }
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
    log: "",
    logTruncated: false,
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
