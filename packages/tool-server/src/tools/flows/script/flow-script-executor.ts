/**
 * Runs one trusted local script file — JavaScript or bash — in a fresh child
 * process. The CALLER names the interpreter and nothing here reads an
 * extension: `flow-script-step.ts` decides, and a request that omits
 * `interpreter` runs the file under Node whatever it is called. Node runs the
 * script itself; bash runs the runner, and the runner starts the bash
 * {@link resolveBashInterpreter} found.
 *
 * The time limit, the concurrency slot and the output ceiling apply to both.
 * The heap limit does not: it is a flag on the child NODE process, so under
 * bash it bounds the runner and not the script — a `.sh` step allocated 286 MiB
 * under a 32 MiB limit and passed. `scripts.heapLimitMb` says the same.
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
  BASH_OUTPUT_ENV,
  BASH_REASON_ENV,
  configFilePath,
  getAtPath,
  getConfigDefinition,
  getConfigValue,
  MIN_SCRIPT_HEAP_LIMIT_MB,
  MIN_SCRIPT_TIMEOUT_MS,
  NPM_CONFIG_ENV_PREFIX,
  PROTO_ENV_NAME,
  reservedScriptEnvName,
  reservedScriptEnvNamesForMessage,
  RUNNER_ACTIVATION_ENV,
  SCRIPT_ENV_NAME_PATTERN,
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
export const SCRIPT_STEP_LOG_LIMIT_BYTES = 64 * 1024;
const SCRIPT_RUN_LOG_LIMIT_BYTES = 256 * 1024;
/**
 * How much of a bash step's last stderr line its reason carries. The log under
 * the reason has the whole line and the rest of stderr beside it; the reason is
 * what a reader sees first, on the step's own line, so it stays short.
 */
const STDERR_REASON_LINE_CHARS = 1_000;
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

/**
 * The owner's account and nothing else, matching the 0700 `mkdtemp` directory
 * around them. Ignored on Windows, where the directory inherits the ACL of
 * `%TEMP%` — private per user in the ordinary case, and not under a tool server
 * running as a service.
 */
const EXCHANGE_FILE_MODE = 0o600;

const EXCHANGE_SWEEP_INTERVAL_MS = 60_000;

/**
 * How many names the sweep's directory handle reads at a time. Small, because
 * what it bounds is the work one turn of the event loop does: the read is
 * scheduled off-thread either way, and it is building the JavaScript names that
 * blocks.
 */
const EXCHANGE_SWEEP_BATCH = 64;

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

/** Config key holding a project's own additions to the allowlist above. */
const SCRIPT_ENV_ALLOW_KEY = "scripts.env.allow";

/**
 * The npm prefix is copied WHOLE out of the host environment, which is why the
 * reserved table names npm config KEYS as well as exact variables: the three
 * that reach `NODE_OPTIONS` would otherwise ride in under this prefix. The
 * reserved check below runs ahead of it for that reason.
 */
const ALLOWED_ENV_PREFIXES: readonly string[] = [NPM_CONFIG_ENV_PREFIX];

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

/**
 * Notes an earlier step of the SAME run already carried.
 *
 * A note about the host's configuration is true of every step in the run, so a
 * flow with twenty script steps would otherwise repeat the same words twenty
 * times. Run-scoped: a later run, or another project, says it again.
 */
export type FlowScriptRunNotes = Set<string>;

export function createScriptRunNotes(): FlowScriptRunNotes {
  return new Set<string>();
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
  logBudget?: FlowScriptLogBudget;
  /** Notes this run has already reported — see {@link FlowScriptRunNotes}. */
  runNotes?: FlowScriptRunNotes;
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
  capture: ScriptLogCapture;
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
      env = buildChildEnv(
        request.env,
        // The same anchor `scripts.bash` reads under: a project-scoped key is
        // resolved from the FLOW's project, never from the tool server's own
        // working directory, which is whatever the editor that spawned it chose.
        configuredEnvAllowNames(request.projectRoot ?? request.flowDir, notes, request.runNotes)
      );
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
    const interpreter = request.interpreter ?? "node";

    let interpreterPath: string | undefined;
    let exchange: ExchangeFiles | undefined;
    if (interpreter === "bash") {
      // The step's own environment, so the check and the step ask the same
      // question of the same candidate: `BASH_ENV` is outside the allowlist, so
      // a probe that inherited it refused a bash the step would have run under,
      // and an arbitrary executable named `bash` was handed the tool server's
      // token, port and secrets on the way.
      // The request's abort too, because this lookup is the one place a `.sh`
      // step waits before it has a process to time out: each candidate costs up
      // to the probe's own timeout plus its force grace, the step's declared
      // limit bounds none of it, and a flow of N bash steps was un-cancellable
      // for about six seconds each.
      const lookupStartedAt = Date.now();
      const found = await resolveBashInterpreter(env, request.signal);
      noteInterpreterLookup(Date.now() - lookupStartedAt, timeoutMs, notes);
      if ("cancelled" in found) {
        return emptyResult(
          { kind: "cancelled", message: "The run was cancelled before the script started." },
          { notes, durationMs: Date.now() - startedAt }
        );
      }
      if (!("path" in found)) {
        // The one refusal that is not about bash at all. The probe SPAWNS each
        // candidate, so an environment past this operating system's limit is
        // refused there first — before the fork a `.mjs` step reaches — and
        // every candidate then fails for that reason. The message returned
        // condemned the host's bash installation and pointed the author at
        // `scripts.bash`: a different subsystem, and one that is working.
        //
        // `env` is the channel this branch adds, so it is also the first thing
        // that can make an environment big enough to hit this.
        return emptyResult(
          {
            kind: "spawn",
            message: /\bE2BIG\b/.test(found.problem)
              ? redactBounded(
                  spawnFailureMessage(new Error("spawn E2BIG"), env),
                  request.secrets ?? [],
                  SCRIPT_MAX_FAILURE_MESSAGE_CHARS
                )
              : found.problem,
          },
          { notes, durationMs: Date.now() - startedAt }
        );
      }
      interpreterPath = found.path;
      if (found.note) notes.push(found.note);
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
      capture,
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
      // The sweep this step started, which ran beside it rather than in front
      // of it. Waiting for it here costs nothing a step of ordinary length can
      // measure, and it keeps the root readable the moment `execute` resolves.
      if (pendingSweep) await pendingSweep;
    }
  }

  private async runChild(run: ChildRun): Promise<FlowScriptResult> {
    const { request, bounds, notes, startedAt, cwd, env, scriptPath, timeoutMs, capture } = run;

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
      // Scrubbed the way every other verdict is: a refusal the operating system
      // raises about the environment quotes it, and this environment now
      // carries resolved `{{secret:}}` values. This was the one outcome path
      // that skipped it.
      return emptyResult(
        {
          kind: "spawn",
          message: redactBounded(
            spawnFailureMessage(err, env),
            request.secrets ?? [],
            SCRIPT_MAX_FAILURE_MESSAGE_CHARS
          ),
        },
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
            // These two strings, and no others. The environment the step
            // forwards reaches bash as the host wrote it — `JAVA_HOME`,
            // `LOCALAPPDATA`, `USERPROFILE` and the rest are `C:\…` there, and
            // only `PATH`, `HOME`, `TMP`, `TEMP` and `TMPDIR` are converted, by
            // the msys runtime rather than by anything here. `cwd` is left
            // alone too: it goes to `CreateProcessW`, not to bash.
            scriptPath: toForwardSlashes(scriptPath),
            outputFile: toForwardSlashes(run.exchange.outputFile),
            outputJson: run.outputJson,
            timeoutMs,
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
    const outcome = classifyOutcome({
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
    });
    const verdict = redactSecrets(
      run.interpreter === "bash" ? withStderrLine(outcome, capture.lastStderrLine) : outcome,
      request.secrets ?? []
    );

    // The band the E2BIG refusal does not cover. Past `ARG_MAX` the operating
    // system refuses the fork outright and `spawnFailureMessage` names the
    // environment; just BELOW it the fork succeeds and Node dies inside its own
    // startup, which arrives here as a runner that exited before it started the
    // script — a verdict that names an exit code and nothing else. A flow could
    // not set `env` at all before this branch, so this is the one shape of that
    // failure an author can now cause, and the size is the lead they need.
    //
    // A note rather than the verdict: this is a possible cause, not a diagnosis.
    // An ordinary environment is a few kilobytes, so the floor is well clear of
    // one and this stays silent for every other way the runner can die early.
    //
    // `interrupted` is that sentence made true. A step cancelled or timed out
    // inside the first few tens of milliseconds has not seen `started` either —
    // the runner sends it from its preload, which is fast but not instant — and
    // the classifier answers `cancelled` or `timeout` there, a verdict this note
    // does not explain. Cancellation has no floor the way `timeoutMs` does, so
    // an abort that arrives with the request reaches it every time.
    if (!startedSeen && !interrupted && environmentBytes(env) >= LARGE_ENVIRONMENT_BYTES) {
      notes.push(
        `The environment this step would carry is ${environmentBytes(env)} bytes. An ` +
          `environment near this operating system's limit for one process (ARG_MAX) is refused ` +
          `outright above it and dies inside Node's own startup just below it, which is what a ` +
          `runner that exits before the script starts looks like. Shorten the \`env\` values, or ` +
          `write the payload to a file and pass its path.`
      );
    }

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

  // The clock rather than the timer, which a stall in the tool server's own
  // event loop can hold behind the exit it is racing. Past that stall the
  // child's deadline watchdog has already stopped the tree, and reporting that
  // stop as unexplained sends the author looking for a killer that is the step's
  // own time limit. On POSIX the stop is a SIGKILL; on Windows it is `taskkill`,
  // which leaves an exit code of 1 and no signal, so there a runner that ended
  // with no verdict past the limit is the same stop.
  if (input.deadlinePassed && (exit.signal || process.platform === "win32")) {
    return timedOut(input.timeoutMs);
  }
  if (exit.signal) {
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

/**
 * A failed step's own text with each resolved `{{secret:NAME}}` value replaced
 * by that placeholder, so the reader sees which secret stood there.
 *
 * The FAILURE text is the whole of it. A script's output document comes back
 * exactly as it was written: a resolved value inside it is data a later step
 * reads, and rewriting it to `{{secret:NAME}}` hands that step a string nothing
 * downstream can use. The reference and the flow-authoring skill say so
 * instead — do not put a credential in the document; hand a later step a
 * derived value.
 */
function redactSecrets(
  verdict: Pick<FlowScriptResult, "ok" | "output" | "failure">,
  secrets: readonly FlowScriptSecret[]
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  if (secrets.length === 0) return verdict;
  const failure = verdict.failure;
  if (!failure) return verdict;
  return {
    ...verdict,
    failure: {
      ...failure,
      message: redactBounded(failure.message, secrets, SCRIPT_MAX_FAILURE_MESSAGE_CHARS),
      ...(failure.stack
        ? { stack: redactBounded(failure.stack, secrets, SCRIPT_MAX_FAILURE_STACK_CHARS) }
        : {}),
    },
  };
}

/**
 * A bash step that exited non-zero says why on stderr, as every command it runs
 * does, so the last line it wrote there ends the reason. Only on `exit`: a
 * signal, a time limit or a document the runner could not read already carries
 * the runner's own account, and the log has every line either way.
 */
function withStderrLine(
  verdict: Pick<FlowScriptResult, "ok" | "output" | "failure">,
  line: string
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  if (!line || verdict.failure?.kind !== "exit") return verdict;
  return {
    ...verdict,
    failure: {
      ...verdict.failure,
      message: clampText(`${verdict.failure.message} ${line}`, SCRIPT_MAX_FAILURE_MESSAGE_CHARS),
    },
  };
}

/**
 * The scrub, then the ceiling AGAIN.
 *
 * A replacement is not a shortening: every occurrence of a value becomes a
 * `{{secret:NAME}}` marker, so a value shorter than its own placeholder GROWS
 * the text. The child applies the ceiling, because it is the only side that can
 * bound what crosses the channel, and it has no secret list — so the scrub runs
 * after the bound and can carry the result far past it. A one-character PIN in
 * a message clamped to 8 KB came back as a 114 KB step reason, which is what
 * the JSON report holds and what an agent reads.
 *
 * Re-applying the ceiling can only cut text that has already been scrubbed, so
 * nothing a cut leaves behind is a secret; a marker cut in half is a
 * placeholder, not a value. The count the second marker carries is of the
 * scrubbed text, which is the text this report is a report of.
 */
function redactBounded(text: string, secrets: readonly FlowScriptSecret[], max: number): string {
  return clampText(redactTruncated(text, secrets), max);
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
    return failed("output", `The script's output did not parse: ${withoutDocumentExcerpt(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failed("output", "The script's output was not an object.");
  }
  const problem = documentProblem(parsed as Record<string, unknown>);
  if (problem !== undefined) return failed("output", problem);
  return { ok: true, output: parsed as Record<string, unknown> };
}

/**
 * How deep a document may nest. The size cap does not bound this: nested arrays
 * cost two bytes a level, so a document inside the 1 MiB ceiling reaches half a
 * million of them.
 *
 * The value sits in the gap between two stack-derived ceilings, measured on
 * Node 20, 22, 24 and 26 (`{"a":` repeated, binary search):
 *
 * - the runner's own `walk` is recursive, so a `.mjs` document deeper than
 *   ~3450-3925 never reaches this file at all — `encodeOutput`'s try/catch
 *   reports it. Above that ceiling, so a `.mjs` step is refused nothing it
 *   used to return.
 * - `JSON.stringify` is recursive in V8 up to Node 24 and throws `RangeError`
 *   at ~6100. Below that ceiling, because `renderOutput` in
 *   `flow-add-script.ts` is a bare `JSON.stringify` reached AFTER the step has
 *   been appended to the flow file.
 *
 * A number rather than a try/catch around a trial encode, because a trial
 * encode answers differently per host — Node 26 encodes any depth a 1 MiB
 * document can reach — and a verdict that follows the host's Node rather than
 * the document is one a flow file cannot be written against.
 */
const MAX_OUTPUT_DEPTH = 4096;

/** Enough of a path to place a value. A 4096-deep one is its own repetition. */
const MAX_PROBLEM_PATH_CHARS = 80;

function clampPath(at: string): string {
  return at.length <= MAX_PROBLEM_PATH_CHARS ? at : `${at.slice(0, MAX_PROBLEM_PATH_CHARS)}…`;
}

/**
 * V8 writes the window in four shapes, one per side it had to cut: the whole
 * document, `"…"...`, `..."…"` and `..."…"...`. Both ellipses are optional, so
 * both are matched here — a leading one appears whenever the error is more than
 * about ten characters into the document, which is every document with
 * structure around the value.
 *
 * The token is exactly ONE code unit, and saying so is what keeps the window
 * out of the part that is kept. A lazy `.+?` in its place stops at the first
 * `, "` it can find, which for a document holding `", "` — an ordinary object
 * with two members — is INSIDE the window, so the characters before it were
 * carried into the reported reason. Greedy is no better from the other side.
 *
 * Greedy to the LAST quote, because the window is inserted raw: an unbalanced
 * `"` inside it is the ordinary case for a document that failed to parse.
 */
const JSON_WINDOW_RE =
  /^(Unexpected token '[\s\S]'), (?:\.\.\.)?"[\s\S]*"(?:\.\.\.)? is not valid JSON$/;

/**
 * Every rule the parent applies to a document it did not encode itself, or
 * `undefined` for one it accepts.
 *
 * The `__proto__` rule is a re-check: the runner refuses it before it encodes,
 * and the parent asks again for the same reason it re-checks the size and the
 * failure-text ceilings — the loader resolves whichever `.mjs` sits beside the
 * compiled executor, so a stale or mismatched runner copy reaches this path.
 * `JSON.parse` makes `__proto__` an own key, and committing one hands whatever
 * merges the document into flow state a prototype to write rather than a
 * property.
 *
 * The other two rules are this side's alone. A `.sh` document is JSON *text*,
 * so it never meets the runner's `walk`, and the two things `walk` refuses
 * arrived here unchecked:
 *
 * - A number JSON can spell but JavaScript cannot hold. `1e999` parses to
 *   `Infinity`, and the step passed carrying a value that every later encode
 *   turns into `null` — `{"n":1e999}` reached the report as `{"n":null}`, while
 *   the same `.mjs` document was refused with "output numbers must be finite".
 * - {@link MAX_OUTPUT_DEPTH}. `renderOutput` in `flow-add-script.ts` is a bare
 *   `JSON.stringify`, reached AFTER the step has been appended to the flow
 *   file, so an over-deep document made the recorder write the step and then
 *   die with an uncaught `RangeError` on every Node up to 24 — telling the
 *   agent the tool failed for a script that succeeded.
 *
 * Iterative rather than recursive: the document came from a child that ran
 * arbitrary code, and a megabyte of `[[[[…` is legal JSON that would overflow
 * the stack inside `execute`, which owes its caller a verdict, not a throw.
 */
function documentProblem(root: Record<string, unknown>): string | undefined {
  const pending: Array<{ node: unknown; at: string; depth: number }> = [
    { node: root, at: "output", depth: 1 },
  ];
  while (pending.length > 0) {
    const { node, at, depth } = pending.pop()!;
    if (depth > MAX_OUTPUT_DEPTH) {
      return (
        `${clampPath(at)} nests deeper than ${MAX_OUTPUT_DEPTH} levels; output must be a ` +
        "document a later step can read back."
      );
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const problem = childProblem(node[i], `${at}[${i}]`, depth, pending);
        if (problem !== undefined) return problem;
      }
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === "__proto__") {
        return `${at} has an own "__proto__" key; output must be JSON-compatible data.`;
      }
      const problem = childProblem(record[key], `${at}${memberPath(key)}`, depth, pending);
      if (problem !== undefined) return problem;
    }
  }
  return undefined;
}

/**
 * One value under a node: refused here, queued for the walk, or neither. The
 * wording for a number follows the runner's own, so the two interpreters answer
 * the same document with the same sentence.
 */
function childProblem(
  value: unknown,
  at: string,
  depth: number,
  pending: Array<{ node: unknown; at: string; depth: number }>
): string | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) {
    // The runner's own `describeValue` spelling. JSON has no `NaN` literal, so
    // only the two infinities reach here through `JSON.parse`.
    const spelled = Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
    return `${clampPath(at)} is ${spelled}; output numbers must be finite.`;
  }
  if (value !== null && typeof value === "object") {
    pending.push({ node: value, at, depth: depth + 1 });
  }
  return undefined;
}

/**
 * V8's `SyntaxError` for a malformed document quotes about ten characters of it
 * verbatim, mid-sentence: `Unexpected token 's', "{"auth":s3cr3t-tok"... is not
 * valid JSON`. That is script-controlled text, and a `.sh` step is the first
 * thing that can put arbitrary bytes on this path - the `.mjs` runner's
 * `encodeOutput` always emits valid JSON, so the branch was unreachable by
 * ordinary script behaviour before.
 *
 * A quoted excerpt is worth nothing to the author, who has the file, and it
 * defeats the redaction: `scrubSecretValues` matches whole values, so the
 * PREFIX of a secret that the excerpt cut in half matches nothing, and
 * `redactTruncated` cannot repair a cut V8 made in the middle of the message
 * rather than the runner at the end of it.
 *
 * Every double-quoted run goes, rather than the exact sentence: the wording is
 * V8's and is not a stability contract, but the quoting is where a document's
 * own bytes are, and the rest of the family (`… at position 6`, `Unexpected end
 * of JSON input`) quotes only with apostrophes and survives unchanged.
 */
function withoutDocumentExcerpt(err: unknown): string {
  const message = errorMessage(err);
  const quoted = JSON_WINDOW_RE.exec(message);
  return quoted ? `${quoted[1]} is not valid JSON` : message;
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Follows the runner's own `memberPath`, which this file cannot import. */
function memberPath(key: string): string {
  return IDENTIFIER_RE.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * A value whose own edge whitespace the child ATE, as spellings to replace
 * beside the value itself.
 *
 * `readReasonFile` in `flow-script-runner.mjs` trims the reason a `.sh` wrote,
 * and a whole-value replacement then finds nothing: a secret sitting at the
 * edge of `$ARGENT_REASON` arrives with its own leading or trailing whitespace
 * gone, which is one character short of the value the scrub looks for. A PEM
 * key and a service-account blob both end in a newline, and
 * `echo "…$KEY" > "$ARGENT_REASON"` is the idiomatic way to write that file —
 * so the shape the redaction promise exists for was the shape that missed it.
 *
 * Each spelling is the value minus whitespace only. That is not a promise that
 * a hit is always the credential: a secret stored with padding around a short
 * core — `" 3 "` — contributes `"3"`, and an unrelated `exited with code 3`
 * is then rewritten. A value of `"3"` with no padding already behaves that way,
 * because the design has no minimum secret length by decision, so this follows
 * the rule rather than adding to it — and over-redacting a step's own text is
 * the lesser fault against reporting a credential in the clear.
 *
 * An all-whitespace value trims to "", which `scrubSecretValues` skips.
 */
function withTrimmedSpellings(secrets: readonly FlowScriptSecret[]): FlowScriptSecret[] {
  const spellings: FlowScriptSecret[] = [];
  for (const secret of secrets) {
    spellings.push(secret);
    for (const value of [secret.value.trimEnd(), secret.value.trimStart(), secret.value.trim()]) {
      if (value.length === 0 || value === secret.value) continue;
      if (spellings.some((seen) => seen.value === value)) continue;
      spellings.push({ name: secret.name, value });
    }
  }
  return spellings;
}

/**
 * What an ENCODER between the child and this report wrote the value as.
 *
 * The scrub searches for the value's raw bytes, so every re-encoding on the way
 * here defeats it — and the encoders in the path are ordinary ones a
 * verification script reaches for in one line. Each of these was reproduced end
 * to end, against a control with a value holding nothing an encoder touches:
 *
 *   - `assert.strictEqual(process.env.K, …)` renders its diff with
 *     `util.inspect`, which quotes and escapes;
 *   - the runner's own `describeThrown` JSON-encodes anything thrown that is
 *     not an `Error` message, so `throw { key }` and an object `cause` arrive
 *     escaped;
 *   - `new URL(…).searchParams.set("t", value)` percent-encodes, and writes a
 *     PLAIN SPACE as `+` — which is why this is not a special-characters case:
 *     the brief's own worked run-time value is `--env "AUTH=Bearer abc"`.
 *
 * The same argument settles the binary-to-text encoders, which are one call
 * each and lossless: `Buffer.from(k).toString("base64")` is how a Basic auth
 * header is built and `"hex"` is how a signing key is printed, so a script that
 * reports the header it sent reports the credential. `base64` and `hex` are
 * also what `base64` and `xxd -p` write on the `.sh` side of the same step.
 *
 * The escaping is trivially reversible, so leaving it is disclosure rather than
 * obfuscation. The reasoning already existed for one character: the `env`
 * resolver refuses a value holding a NUL because Node quotes it back escaped
 * "so the scrub — which searches for the raw bytes — finds nothing". It was
 * never carried past NUL to `\n`, `"`, `\`, a tab, or a space.
 *
 * Every spelling is derived by the REAL encoder wherever there is one, so a
 * rule that differs from a hand-written table — `URLSearchParams` writing `+`
 * for a space and `%27` for an apostrophe where `encodeURIComponent` writes
 * neither — cannot drift apart from it.
 *
 * The LINES of a multi-line value are spellings of their own, because
 * `util.inspect` writes a long one as one quoted chunk per line joined by
 * `' +`, and no whole-value match survives the glue between them. A PEM key and
 * a service-account blob are the shapes this feature is documented for. It is
 * also what puts a short line of such a value into the scrub — the same
 * over-redaction {@link withTrimmedSpellings} accepts, and the same answer:
 * over-redacting a step's own text is the lesser fault against reporting a
 * credential in the clear. A single-line value, which is nearly all of them,
 * gains no line spelling at all.
 *
 * A value the URI encoders refuse — a lone surrogate is the one way in — simply
 * contributes no spelling for them. Throwing here would take down the verdict
 * the redaction exists to make safe.
 */
function encodedSpellings(value: string): string[] {
  const spellings: string[] = [];
  spellings.push(...quotedSpellings(value));
  try {
    spellings.push(encodeURIComponent(value));
    spellings.push(encodeURI(value));
    spellings.push(new URLSearchParams([["", value]]).toString().slice(1));
    // `escape` is the third percent-encoder in the language and the one a
    // pre-`encodeURIComponent` idiom still reaches for. Deprecated, not gone.
    spellings.push(escape(value));
  } catch {
    // A lone surrogate. The raw value and every other spelling still stand.
  }
  // The binary-to-text encoders. Each is one call on a credential and each is
  // lossless, so what reaches the report is the value itself in another
  // alphabet — a `Basic` header is base64 and a signing key is hex.
  const bytes = Buffer.from(value, "utf8");
  for (const encoding of ["base64", "base64url", "hex", "latin1"] as const) {
    spellings.push(bytes.toString(encoding));
  }
  // Case and Unicode form. Neither is an encoder a script applies on purpose,
  // but both come off an ordinary comparison — `tr a-z A-Z`, a `toUpperCase`
  // before a lookup, a `normalize` before a signature — and a case fold is a
  // TOTAL disclosure of a hex or base32 key, whose alphabet has one case.
  spellings.push(value.toUpperCase(), value.toLowerCase());
  for (const form of ["NFC", "NFD", "NFKC", "NFKD"] as const) {
    spellings.push(value.normalize(form));
  }
  // Each line RAW and escaped alike. `util.inspect` picks the quote per chunk
  // and escapes the rest, so a line holding anything its `strEscape` rewrites —
  // a trailing `\r` from CRLF is the ordinary case, and a Windows-authored PEM
  // has one on every line but the last — never matches its raw spelling. The
  // escaped set is a C0 or C1 control, a backslash, a lone surrogate, and an
  // apostrophe on a line that also holds both other quotes; a line free of all
  // of them is why the raw spelling covers LF-only values today.
  if (value.includes("\n")) {
    for (const line of value.split("\n")) spellings.push(line, ...quotedSpellings(line));
  }
  return spellings;
}

/**
 * The body a JSON encoder writes, which is also `util.inspect`'s double-quoted
 * form; then its single-quoted form, which is what inspect prefers and differs
 * in exactly the two quotes; then its BACKTICK form, which inspect picks for a
 * value holding both other quotes and which escapes neither of them.
 *
 * Each body again with `\xNN` where JSON writes `\u00nn`. That is the one
 * character class the two encoders spell differently — inspect's own escape for
 * a control character — and an ESC or a NEL inside a token is enough to reach
 * it. `\n`, `\t`, `\r`, `\b`, `\f` and `\v` are named the same way by both, so
 * they need no second form.
 */
function quotedSpellings(text: string): string[] {
  const json = JSON.stringify(text).slice(1, -1);
  const unquoted = json.replace(/\\"/g, '"');
  const bodies = [
    json,
    unquoted.replace(/'/g, "\\'"),
    unquoted.replace(/`/g, "\\`").replace(/\$\{/g, "\\${"),
  ];
  return [...bodies, ...bodies.map(inspectEscapes)];
}

/**
 * One JSON body as `util.inspect` would have written it, which differs in the
 * control characters and in nothing else.
 *
 * Two classes, not one. Below U+0020 both encoders escape and only the spelling
 * differs: JSON writes `\u001b` where inspect writes `\x1B`. From U+007F to
 * U+009F, `JSON.stringify` escapes NOTHING and inspect still writes `\xNN`, so
 * the raw character reaches the body and no rewrite of `\u00nn` can find it.
 * NEL (U+0085) is the one that turns up: a line break to a YAML reader, an
 * ordinary character to everything else.
 */
function inspectEscapes(body: string): string {
  return body
    .replace(/\\u00([0-9a-f]{2})/g, (_match, code: string) => `\\x${code.toUpperCase()}`)
    .replace(
      /[\u007f-\u009f]/g,
      (character) => `\\x${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
}

/**
 * Every spelling of every resolved value this report may hold, for one scrub.
 *
 * {@link scrubSecretValues} takes them as one list and orders it longest first,
 * so a value that contains another — or a spelling that contains the value it
 * came from — is still taken whole.
 */
function scriptSecretSpellings(raw: readonly FlowScriptSecret[]): FlowScriptSecret[] {
  const spellings = withTrimmedSpellings(raw);
  for (const secret of raw) {
    for (const value of encodedSpellings(secret.value)) {
      if (value.length === 0 || spellings.some((seen) => seen.value === value)) continue;
      spellings.push({ name: secret.name, value });
    }
  }
  return spellings;
}

/**
 * One text of a failed script step with every resolved value replaced, in every
 * spelling this report can hold one in.
 *
 * Exported for the one caller that DECODES after the scrub has run:
 * `scriptFrames` reads the already-scrubbed stack and turns each `file://…`
 * frame back into a path, so a value that stood in a path reached the scrub
 * percent-encoded and reached the reader raw. Whatever decodes has to scrub
 * again, and this is that scrub.
 */
export function scrubScriptText(text: string, secrets: readonly FlowScriptSecret[]): string {
  if (secrets.length === 0) return text;
  return scrubSecretValues(text, scriptSecretSpellings(secrets));
}

/**
 * A failure message is clamped by the child, the only side that can bound what
 * crosses the channel, and the child has no secret list — so a value straddling
 * the cut leaves a prefix that a whole-value replacement never matches. That
 * tail is dropped and counted, and only on text whose marker says it was cut.
 *
 * The marker is read off the RAW text, and the scrub runs on the head alone.
 * Read off the scrubbed text instead, the repair was defeated by any secret
 * whose value occurs inside the marker — which is argent's own sentence around
 * a character COUNT, so a value of `"0"` is enough, and `withTrimmedSpellings`
 * hands one over for a secret stored as `" 0 "`. The marker was then rewritten,
 * neither pattern matched it, the repair was skipped, and the OTHER secret's
 * partial half stayed in the step reason, the `--json` report and the MCP call
 * log. Every character of the marker is written by argent — the runner's own
 * wording and a number it counted — so nothing in it is a value to find, and
 * leaving it out of the scrub is also what stops a count reading `2{{secret:…}}43`.
 */
function redactTruncated(text: string, raw: readonly FlowScriptSecret[]): string {
  const secrets = scriptSecretSpellings(raw);
  // Whole values first, then the prefixes a cut somewhere else left behind. The
  // order is what keeps the second pass off a value the first one already took:
  // it searches only for prefixes SHORTER than the value they came from.
  // `cutAtEnd` says the part ENDS at a cut, which nothing in the text can say
  // any more: the marker is argent's own and is taken off before the scrub
  // runs, so the head handed over holds no ellipsis and every repair that reads
  // one saw an uncut text. The repair that answers a foreign cut was then off
  // on the one cut argent itself makes — a `<Buffer …>` rendering came back
  // repaired when NODE cut it and in the clear when argent did, from the same
  // value and the same rendering.
  const scrub = (part: string, cutAtEnd: boolean) =>
    SCRUB_REPAIRS.reduce(
      (carried, repair) => repair(carried, secrets, cutAtEnd),
      scrubSecretValues(part, secrets)
    );
  const omission = OMISSION_RE.exec(text);
  if (!omission) return scrub(text, false);
  const head = scrub(text.slice(0, omission.index), true);
  const partial = partialSecretTail(head, secrets);
  return `${head.slice(0, head.length - partial)}${omissionMarker(Number(omission[1]) + partial)}`;
}

/**
 * What runs after the whole-value scrub, in order. Each one answers a rendering
 * that leaves no spelling of the value in the text: a prefix another process
 * cut, a rendering of the bytes, an escaper's backslashes, a re-encoding into
 * another alphabet. Each reads the text the ones before it left, so a value
 * that two of them rewrote is still taken.
 */
const SCRUB_REPAIRS = [
  repairQuotedCuts,
  repairByteRenderings,
  repairBackslashEscapes,
  repairEncodedRuns,
] as const;

/**
 * A value some OTHER process cut, repaired where the cut left a quoted prefix.
 *
 * {@link redactTruncated} answers argent's own clamp, which cuts at the end of
 * the text and says so in a marker. V8 and Node cut in the MIDDLE of a message
 * and say so with an ellipsis, embedding a fixed-length prefix of a string
 * argument in the error they raise:
 *
 *   - `JSON.parse(k)` — 10 characters, V8's own window;
 *   - any API raising `ERR_INVALID_ARG_TYPE` with the value as the offending
 *     argument — 25 characters, and `setTimeout(k, 1)` is enough to reach it;
 *   - `ERR_INVALID_ARG_VALUE` — 128 characters.
 *
 * A prefix is not the value, so the whole-value scrub cannot match it, and none
 * of these ends in a marker {@link redactTruncated} reads — so a `.mjs` that
 * handed a resolved secret to a Node API reported the front of that credential
 * in the step reason, the `--json` report and the recorder's own result. The
 * cut only bites a value LONGER than the window, which is why short fixture
 * values came back correctly scrubbed and real-length tokens did not.
 *
 * Anchored on the QUOTES Node renders the cut value in, not on the ellipsis
 * alone. Every one of these writes the fragment as `'…...'` or `"…"...`, so the
 * repair asks for a whole quoted fragment that is a prefix of a value — which
 * an ordinary `timed out...` in a script's own prose is not. Keyed on the
 * ellipsis alone, a single character before any `...` in the text would answer,
 * and the report would lose a letter of its own wording to a placeholder.
 *
 * The window count itself is left alone: it is Node's wording, and there are
 * three different ones. What the reader needs is that the fragment was a
 * credential, which the placeholder says.
 */
function repairQuotedCuts(text: string, secrets: readonly FlowScriptSecret[]): string {
  const cuts = [...text.matchAll(FOREIGN_CUT_RE)];
  if (cuts.length === 0) return text;
  const quotes = openingQuotes(text);
  const ends = prefixEnds(secrets);
  let out = "";
  let copied = 0;
  for (const cut of cuts) {
    const hit = quotedCutBefore(text, cut.index, copied, secrets, quotes, ends);
    if (!hit) continue;
    out += `${text.slice(copied, hit.from)}${SECRET_PLACEHOLDER_MARKER}${hit.name}}}`;
    copied = hit.from + hit.length;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * For each position, the nearest quote at or before it, or `-1`.
 *
 * Read once for the whole text rather than at each candidate, because the
 * candidates are the PRODUCT of the ellipses in the text and the length of a
 * spelling, and neither is bounded by anything smaller than the 8 KiB message
 * and 16 KiB stack ceilings. A failure text that is dense in ellipses and a
 * value long enough to be a PEM key — the shape the docs recommend an `env`
 * value for — met as a walk of one against the other, on the shared tool
 * server's own event loop, after the child had already exited. Neither factor
 * costs anything alone, which is what made the product easy to miss.
 */
function openingQuotes(text: string): Int32Array {
  const quotes = new Int32Array(text.length);
  let last = -1;
  for (let at = 0; at < text.length; at++) {
    if (CUT_QUOTES.has(text[at]!)) last = at;
    quotes[at] = last;
  }
  return quotes;
}

/**
 * The longest value prefix that runs from just after a quote to the cut, over
 * every spelling. Two ends are tried, because the cut sits inside the quotes
 * for one Node shape (`'sk-live-ab...'`) and outside the closing one for the
 * other (`"sk-live-9d"...`).
 *
 * Shorter than the value it came from, always: a whole value is what
 * `scrubSecretValues` has already replaced, and searching for one here would
 * only find text that pass left alone on purpose.
 *
 * The quote that OPENS the fragment is the nearest one before the cut, and it
 * bounds the descent: nothing before it is inside the fragment, so no prefix
 * can start there. A cut with no quote in front of it at all answers nothing
 * and is skipped whole. For a value that holds a quote of its own the nearest
 * quote can be the value's, which anchors the repair short — the raw scrub
 * still takes such a value whole, and every credential shape this repair was
 * written for holds none.
 *
 * The prefix starts ANYWHERE inside that fragment, not one character after the
 * quote. Node puts its window over the argument it was handed, and a script
 * hands it the credential built into a larger string — `JSON.parse` on
 * `{"token":<value>}` reports `"{"token":sk-live-9d"...`, and `setTimeout` on
 * `"Bearer " + value` reports `('Bearer sk-live-9d3f-topse...')`. Both are one
 * quoted fragment whose prefix is argent's to leave alone and whose tail is the
 * front of a credential. Requiring the value at the quote answered neither.
 *
 * That freedom is why {@link CUT_MIN_PREFIX_CHARS} exists. Anchored at the
 * quote, a one-character "prefix" had to be the first character of the
 * fragment; anchored anywhere, every character before an ellipsis inside quotes
 * is a candidate, and one of them matches the first character of SOME spelling
 * nearly always. `Command failed: '/bin/sh -c npm run seeds...'` came back as
 * `… npm run seed{{secret:API_KEY}}...` — argent's own diagnostic corrupted,
 * and a credential announced where none stood.
 */
function quotedCutBefore(
  text: string,
  at: number,
  floor: number,
  secrets: readonly FlowScriptSecret[],
  quotes: Int32Array,
  ends: ReadonlyArray<ReadonlyMap<string, number[]>>
): { from: number; length: number; name: string } | undefined {
  const cuts = at - 1 > floor && CUT_QUOTES.has(text[at - 1]!) ? [at, at - 1] : [at];
  let best: { from: number; length: number; name: string } | undefined;
  for (const end of cuts) {
    const quote = end > 0 ? quotes[end - 1]! : -1;
    if (quote < floor) continue;
    const last = text[end - 1]!;
    for (const [index, { name, value }] of secrets.entries()) {
      const longest = Math.min(value.length - 1, end - quote - 1);
      // Only the lengths whose LAST character is the one before the cut can
      // match, and they arrive longest first. A character no spelling ends on
      // costs one map lookup, which is what keeps an ellipsis-dense text off
      // the whole descent.
      for (const n of ends[index]!.get(last) ?? []) {
        if (n > longest) continue;
        if (n <= (best?.length ?? 0)) break;
        if (!holdsPrefix(text, end - n, value, n)) continue;
        best = { from: end - n, length: n, name };
        break;
      }
    }
  }
  return best;
}

/**
 * Per spelling, the prefix lengths that END on a given character, longest
 * first — the index {@link quotedCutBefore} reads its candidates out of.
 *
 * Built once for the whole text rather than walked per cut. The descent it
 * replaces was bounded by the nearest quote, which answers a quote-dense text
 * but not a text holding ONE quote and then thousands of ellipses: there the
 * bound stayed at the spelling's own length and the product came back. A PEM
 * key against the 16 KiB stack ceiling took 1.7 s of the shared server's event
 * loop; the same run is now flat against a text with no ellipsis at all.
 */
function prefixEnds(secrets: readonly FlowScriptSecret[]): Array<Map<string, number[]>> {
  return secrets.map(({ value }) => {
    const ends = new Map<string, number[]>();
    for (let n = value.length - 1; n >= CUT_MIN_PREFIX_CHARS; n--) {
      const last = value[n - 1]!;
      const lengths = ends.get(last);
      if (lengths) lengths.push(n);
      else ends.set(last, [n]);
    }
    return ends;
  });
}

/**
 * The shortest cut prefix worth repairing, which is also the shortest fragment
 * of a credential this file treats as a disclosure at all: the redaction tests
 * sweep every run down to six characters, on the reasoning that anything an
 * encoder wrote is trivially reversible. Below it a match says more about the
 * alphabet than about the value — six specific characters landing in argent's
 * own wording is a coincidence no failure text has produced, and one character
 * is a coincidence nearly every failure text produces.
 *
 * What it gives up is the tail of a window a long non-secret prefix already ate
 * — `setTimeout("<24 characters> " + key, 1)` leaves one character of the key
 * inside Node's 25-character window. Five characters of a credential is the
 * most this can leave standing, against corrupting the report on text that
 * holds none.
 */
const CUT_MIN_PREFIX_CHARS = 6;

/**
 * Whether `text` carries the first `n` characters of `value` at `from`.
 *
 * Compared in place rather than through `startsWith` on a slice: the slice
 * allocates the whole prefix on every candidate, and a candidate is rejected on
 * its first character nearly always.
 */
function holdsPrefix(text: string, from: number, value: string, n: number): boolean {
  for (let at = 0; at < n; at++) {
    if (text[from + at] !== value[at]) return false;
  }
  return true;
}

/**
 * A value RENDERED AS BYTES, which is neither a spelling of it nor a cut of it.
 *
 * `util.inspect` prints a `Buffer` or a `TypedArray` as its NUMBERS, so nothing
 * a whole-value or per-spelling search looks for is in the text at all — and
 * the disclosure is total and lossless, character for character. Two shapes
 * reach a step reason, both from one line a seeding script plausibly writes:
 *
 *   assert.deepStrictEqual(Buffer.from(process.env.API_KEY), expected)
 *
 * renders decimal, one byte per line, with the assert diff's own `+ ` down the
 * left — so the bytes are not even contiguous — and `util.inspect(Buffer.from(k))`
 * renders `<Buffer 73 6b 2d …>` in hex, cut to the first 50 with a `… N more
 * bytes` trailer of Node's own.
 *
 * Read as numbers rather than matched as text, which is what makes one rule of
 * it: whatever sits between the numbers — a comma, a newline, a diff marker, an
 * indent — is separator, and the run is decoded and searched in byte space. A
 * run is broken wherever a LETTER appears between two numbers, which is what
 * keeps `Buffer(49) [Uint8Array] [` out of the bytes that follow it.
 *
 * Both readings of a run are tried, because the two shapes disagree on the
 * radix and neither announces it: decimal admits one to three digits under 256,
 * hex exactly two digits. A run that is not a byte rendering decodes to bytes
 * that hold no value, and nothing is replaced.
 */
function repairByteRenderings(
  text: string,
  secrets: readonly FlowScriptSecret[],
  cutAtEnd = false
): string {
  const needles = secrets
    .map(({ name, value }) => ({ name, bytes: Buffer.from(value, "utf8") }))
    .filter(({ bytes }) => bytes.length > 0)
    .sort((a, b) => b.bytes.length - a.bytes.length);
  if (needles.length === 0) return text;
  const spans: Array<{ from: number; to: number; name: string }> = [];
  const sides = diffSides(text);
  for (const { radix, numbers } of BYTE_VIEWS) {
    for (const dropped of sides) {
      const runs = byteRuns(text, numbers, radix, dropped);
      // The run nearest argent's own cut is the one whose tail may be a value's
      // front. Nothing in the text says so — the marker is gone — so the caller
      // does.
      const last = runs[runs.length - 1];
      if (cutAtEnd && last) last.cut = true;
      for (let at = 0; at < runs.length; at++) {
        spans.push(...byteRunSpans(runs[at]!, radix, needles));
        spans.push(...stitchedSpans(runs[at]!, runs[at + 1], radix, needles));
      }
    }
  }
  return spliceSpans(text, spans);
}

/**
 * The readings of one text a DIFF asks for: the text whole, and then each side
 * of it with the other side's lines gone.
 *
 * `assert.deepStrictEqual(Buffer.from(k), expected)` renders the two buffers
 * INTERLEAVED, one byte per line, each line carrying the `+` or `-` of the side
 * it belongs to and a line both sides agree on carrying neither. Read whole,
 * the run holds one side's bytes with the other's mixed through it, so no
 * contiguous stretch of it spells the value and every byte of the credential
 * printed. {@link stitchedSpans} does not answer it either: it joins a run's
 * tail to the next run's head, and an interleaving is not one break but one per
 * line.
 *
 * Read with the `-` lines dropped, the same run is exactly what the script's
 * own buffer held. Dropping them at the CHARACTER level rather than dropping
 * their tokens is what makes that work — `- Buffer(8) [Uint8Array] [` is a line
 * of the other side, and its letters would otherwise end the run in the middle
 * of the value.
 *
 * Only when the text carries both markers, which is the shape a diff has and
 * ordinary prose with a hyphen at a line start does not. Everything else reads
 * once, exactly as before.
 */
function diffSides(text: string): Array<Uint8Array | undefined> {
  const marks = lineMarkers(text);
  if (!marks) return [undefined];
  return [undefined, marks.minus, marks.plus];
}

/**
 * A mask per side, marking every character on a line that side owns, or nothing
 * when the text is no diff. A line's side is its first non-blank character.
 */
function lineMarkers(text: string): { minus: Uint8Array; plus: Uint8Array } | undefined {
  const minus = new Uint8Array(text.length);
  const plus = new Uint8Array(text.length);
  let sawMinus = false;
  let sawPlus = false;
  for (let from = 0; from <= text.length; ) {
    const brk = text.indexOf("\n", from);
    const to = brk < 0 ? text.length : brk + 1;
    let at = from;
    while (at < to && (text[at] === " " || text[at] === "\t")) at++;
    const mark = at < to ? text[at] : undefined;
    if (mark === "-" || mark === "+") {
      const side = mark === "-" ? minus : plus;
      side.fill(1, from, to);
      if (mark === "-") sawMinus = true;
      else sawPlus = true;
    }
    if (brk < 0) break;
    from = to;
  }
  return sawMinus && sawPlus ? { minus, plus } : undefined;
}

/**
 * The two readings, each with the digits its own radix writes a byte in.
 *
 * Tokenized apart rather than tokenized once and filtered, because a hex letter
 * standing next to a decimal rendering — the `B` of the `- Buffer(4)` line an
 * assert diff puts between two halves of the actual buffer — would otherwise
 * join the run and stop it decoding as decimal at all.
 */
const BYTE_VIEWS = [
  { radix: 10, numbers: /[0-9]+/g },
  { radix: 16, numbers: /[0-9A-Fa-f]+/g },
] as const;

/**
 * A value the rendering itself SPLIT, across the break that split it.
 *
 * `assert.deepStrictEqual(Buffer.from(k), expected)` writes the two buffers
 * interleaved — the expected side's `Buffer(4) [Uint8Array] [` lands in the
 * middle of the actual side's bytes — so the credential ends one run and
 * resumes in the next, and neither run holds it whole.
 *
 * The gate is that the two halves reconstruct the WHOLE value: the tail of one
 * run and the head of the next have to be a value's own two pieces, at the same
 * radix, with nothing left over. That is what lets this run without a length
 * floor, which the design has none of — a one-byte tail that happens to open a
 * value answers nothing unless the rest of that value follows it exactly.
 */
function stitchedSpans(
  run: ByteRun,
  next: ByteRun | undefined,
  radix: number,
  needles: ReadonlyArray<{ name: string; bytes: Buffer }>
): Array<{ from: number; to: number; name: string }> {
  if (!next) return [];
  const head = decodeByteRun(run, radix);
  const tail = decodeByteRun(next, radix);
  if (!head || !tail) return [];
  for (const { name, bytes } of needles) {
    for (let n = Math.min(bytes.length - 1, head.length); n > 0; n--) {
      const rest = bytes.length - n;
      if (rest > tail.length) continue;
      if (head.compare(bytes, 0, n, head.length - n, head.length) !== 0) continue;
      if (tail.compare(bytes, n, bytes.length, 0, rest) !== 0) continue;
      return [...runSpans(run, head.length - n, n, name), ...runSpans(next, 0, rest, name)];
    }
  }
  return [];
}

interface ByteRun {
  tokens: Array<{
    from: number;
    to: number;
    text: string;
    /**
     * Whether the text between this token and the one before it is entirely in
     * the reading that built the run. False where a dropped diff line lies
     * between them, which is where a span has to break: the placeholder stands
     * for the bytes, and the other side's lines are not them.
     */
    joined: boolean;
  }>;
  /** The run stopped at an ellipsis, so its last bytes may be a cut value. */
  cut: boolean;
}

/**
 * Maximal sequences of numbers separated by anything that is not a letter, and
 * holding only numbers this radix writes a byte as.
 *
 * A letter between two numbers ends the run: a rendering's own numbers are
 * separated by punctuation and whitespace only, so this is what tells
 * `Uint8Array(8) [` from the bytes it introduces. An ellipsis ends one too, and
 * says why — the renderer cut there, and what precedes it is a prefix.
 *
 * A number that is NO byte at this radix ends the run as well, and is dropped
 * rather than carried into it. Extra bytes cost a run nothing — the search
 * inside it is a substring search, so a byte the rendering did not write is
 * simply a byte no value starts at — but a number that does not decode sinks
 * the WHOLE run, and the two shapes that produce one both sit flush against a
 * rendering:
 *
 *   - the element count a `Buffer`/`TypedArray` over 255 bytes prints in front
 *     of its own bytes, `Uint8Array(298) [`, which no separator rule keeps out
 *     because `(`, `)` and `[` are not letters;
 *   - the leading hex characters of the first WORD after a `<Buffer …>`, whose
 *     `>` is not a letter either — `did`, `expected`, `and` and `from` all open
 *     with an odd-length hex prefix, which is no byte at radix 16.
 *
 * Both left the run undecodable, so no span was produced and the credential the
 * rendering spelled reached the step reason, the `--json` report and the MCP
 * call log in full.
 *
 * A lone number is no rendering, so a run of one is dropped: it costs two
 * decodes and can only match a one-byte value, which the raw scrub already has.
 */
function byteRuns(text: string, numbers: RegExp, radix: number, dropped?: Uint8Array): ByteRun[] {
  const runs: ByteRun[] = [];
  let run: ByteRun = { tokens: [], cut: false };
  let end = -1;
  const close = (cut: boolean) => {
    if (run.tokens.length > 1) runs.push({ tokens: run.tokens, cut });
    run = { tokens: [], cut: false };
  };
  for (const token of text.matchAll(numbers)) {
    if (dropped?.[token.index]) continue;
    const gap = end < 0 ? "" : keptGap(text, end, token.index, dropped);
    const joined = end < 0 || gap.length === token.index - end;
    end = token.index + token[0].length;
    // The GAP is read before the token is judged, because a run ends for the
    // reason its gap gives whatever follows it. Judged the other way round, a
    // token that is no byte closed the run with `cut: false` and threw away the
    // ellipsis that had just closed it with `cut: true` — and the token after
    // an ellipsis is a COUNT, which is no byte whenever it has the wrong number
    // of digits. `<Buffer …> … 200 more bytes` is that shape, and it is Node's
    // own rendering of any value over 50 bytes.
    if (/[A-Za-z]/.test(gap)) close(false);
    else if (GAP_CUT_RE.test(gap)) close(true);
    if (byteToken(token[0], radix) === undefined) {
      close(false);
      continue;
    }
    run.tokens.push({ from: token.index, to: end, text: token[0], joined });
  }
  close(false);
  return runs;
}

/** The text between two tokens, with the other side's lines taken out of it. */
function keptGap(text: string, from: number, to: number, dropped?: Uint8Array): string {
  if (!dropped) return text.slice(from, to);
  let gap = "";
  for (let at = from; at < to; at++) if (!dropped[at]) gap += text[at];
  return gap;
}

/** Where in `text` this run spells a value, read at one radix. */
function byteRunSpans(
  run: ByteRun,
  radix: number,
  needles: ReadonlyArray<{ name: string; bytes: Buffer }>
): Array<{ from: number; to: number; name: string }> {
  const decoded = decodeByteRun(run, radix);
  if (!decoded) return [];
  const spans: Array<{ from: number; to: number; name: string }> = [];
  let at = 0;
  while (at < decoded.length) {
    const hit = needles.find(
      ({ bytes }) =>
        at + bytes.length <= decoded.length &&
        decoded.compare(bytes, 0, bytes.length, at, at + bytes.length) === 0
    );
    if (!hit) {
      at += 1;
      continue;
    }
    spans.push(...runSpans(run, at, hit.bytes.length, hit.name));
    at += hit.bytes.length;
  }
  if (spans.length > 0 || !run.cut) return spans;
  // Nothing whole, and the rendering was cut here — so the tail may be the
  // front of a value. Longest first, and shorter than the value, exactly as
  // {@link quotedCutBefore} reads a cut in text space.
  //
  // Floored only when the cut is ARGENT's, because only that cut sits at the
  // ceiling. There the substitution can GROW the text — `{{secret:NAME}}` is
  // longer than the `115` it would stand in for — `redactBounded` re-clamps
  // what the scrub grew, and the placeholder itself came back cut. A
  // renderer's ellipsis is under no such pressure, and flooring it there would
  // leave a byte standing that the pass took before.
  //
  // Six bytes buys the growth back for an ordinary name and no more: a name as
  // long as `GOOGLE_APPLICATION_CREDENTIALS_JSON` still outgrows the seventeen
  // characters six hex bytes occupy. What is left is cosmetic — the re-clamp
  // cuts text the scrub has already been over.
  //
  // Two ends, because argent's own clamp does not cut where a renderer does. A
  // renderer stops between elements; a character ceiling stops wherever it
  // falls, so the last number of the run can be half of one — `… 99,\n   5` —
  // and that half decodes to a byte no value has there, which sank the whole
  // tail. Dropping it is the second reading.
  const floor = CUT_MIN_PREFIX_CHARS;
  for (const end of [decoded.length, decoded.length - 1]) {
    for (const { name, bytes } of needles) {
      for (let n = Math.min(bytes.length - 1, end); n >= floor; n--) {
        if (decoded.compare(bytes, 0, n, end - n, end) !== 0) continue;
        return runSpans(run, end - n, n, name);
      }
    }
  }
  return spans;
}

/**
 * Where a stretch of one run's tokens sits in the text, as one span per piece
 * that is really contiguous there.
 *
 * A run read with one side of a diff dropped holds tokens the other side's
 * lines sit between, and a span says the text it covers spells a value — so one
 * span across the whole stretch would swallow the other side's bytes into the
 * placeholder. Broken at each token the reading skipped instead, which leaves
 * the diff readable and still replaces every byte of the value.
 */
function runSpans(
  run: ByteRun,
  first: number,
  count: number,
  name: string
): Array<{ from: number; to: number; name: string }> {
  const spans: Array<{ from: number; to: number; name: string }> = [];
  let start = first;
  for (let at = first + 1; at < first + count; at++) {
    if (run.tokens[at]!.joined) continue;
    spans.push({ from: run.tokens[start]!.from, to: run.tokens[at - 1]!.to, name });
    start = at;
  }
  spans.push({ from: run.tokens[start]!.from, to: run.tokens[first + count - 1]!.to, name });
  return spans;
}

/**
 * The byte one number spells at this radix, or nothing when it spells none.
 * Decimal takes one to three digits below 256; hex takes exactly the two a byte
 * is always written as, so a decimal run is not read as hex by accident.
 */
function byteToken(text: string, radix: number): number | undefined {
  if (radix === 16 && text.length !== 2) return undefined;
  if (radix === 10 && text.length > 3) return undefined;
  const code = parseInt(text, radix);
  return code >= 0 && code <= 255 ? code : undefined;
}

/**
 * The run's bytes. Every token was read as one byte when the run was built, so
 * this cannot fail; the guard stands for the caller that decodes a run it did
 * not build.
 */
function decodeByteRun(run: ByteRun, radix: number): Buffer | undefined {
  const codes: number[] = [];
  for (const { text } of run.tokens) {
    const code = byteToken(text, radix);
    if (code === undefined) return undefined;
    codes.push(code);
  }
  return Buffer.from(codes);
}

/**
 * A value an ESCAPER put backslashes through, read back with them taken out.
 *
 * A spelling is a transform of the WHOLE value, so the list only answers an
 * escaper it names. Three that a step meets are one line of an ordinary script
 * each, and each writes the value with a backslash in front of a character the
 * spellings leave alone: `util.inspect` picks a BACKTICK body for a value
 * holding both quotes and escapes only the backslashes in it, `RegExp.source`
 * writes `/` as `\/`, and bash's `printf %q` backslashes a space, an
 * apostrophe and a backslash alike.
 *
 * Read as one rule instead of three, because the three tables disagree and
 * bash's is not even the same across versions: a backslash takes the character
 * after it, whatever that character is, and the decoded text is searched for
 * the value. What that misses is the escapes that MEAN something else — `\n`,
 * and the `\xNN` the spellings carry — and reading `\n` as `n` can only
 * over-redact, never leave a value standing.
 */
function repairBackslashEscapes(text: string, secrets: readonly FlowScriptSecret[]): string {
  if (!text.includes("\\")) return text;
  let decoded = "";
  const at: number[] = [];
  const to: number[] = [];
  for (let cursor = 0; cursor < text.length; cursor++) {
    const escaped = text[cursor] === "\\" && cursor + 1 < text.length;
    decoded += text[escaped ? cursor + 1 : cursor];
    at.push(cursor);
    to.push(escaped ? cursor + 2 : cursor + 1);
    if (escaped) cursor++;
  }
  const spans: Array<{ from: number; to: number; name: string }> = [];
  for (const { name, value } of secrets) {
    if (value.length === 0) continue;
    for (let found = decoded.indexOf(value); found >= 0; ) {
      spans.push({ from: at[found]!, to: to[found + value.length - 1]!, name });
      found = decoded.indexOf(value, found + value.length);
    }
  }
  return spliceSpans(text, spans);
}

/**
 * A value RE-ENCODED into another alphabet, decoded back in byte space.
 *
 * The spellings hold what `base64` and `hex` write the value ON ITS OWN as,
 * which only answers while the encoder is character-local — while each byte of
 * the value lands in the same place in the output whatever surrounds it.
 * Neither of these is: base64 frames in THREE-byte groups, so a prefix whose
 * length is not a multiple of three moves every following byte into a different
 * frame, and the shell's own tools wrap their output at a fixed column, so a
 * value merely long enough to wrap has a newline through the middle of its
 * encoding. Both leave the credential whole and losslessly recoverable in text
 * that no spelling appears in — `"Basic " + Buffer.from(\`api:${k}\`)
 * .toString("base64")` and `printf %s "$K" | xxd -p` are one line each, and the
 * first is the standard HTTP credential idiom.
 *
 * So the run is decoded rather than matched, exactly as
 * {@link repairByteRenderings} reads a rendering's numbers: every maximal run
 * of one alphabet is decoded whole — a newline inside it is the wrap and is
 * skipped — and the bytes are searched. A byte span maps back to the characters
 * of the frames it lies in, so a frame the value SHARES with its prefix goes
 * with it; over-redacting argent's own text is the lesser fault. Case comes for
 * free, which is what covers a hex signature printed upper-case.
 *
 * Floored at {@link ENCODED_RUN_MIN_BYTES}, unlike every other pass here. A run
 * of ordinary letters decodes to bytes too, and nothing about it says it was
 * ever an encoding, so a short value would be found in the noise: four bytes
 * puts a chance hit past one in four billion per position, and a credential
 * shorter than that is not one.
 */
function repairEncodedRuns(
  text: string,
  secrets: readonly FlowScriptSecret[],
  cutAtEnd = false
): string {
  const needles = secrets
    .map(({ name, value }) => ({ name, bytes: Buffer.from(value, "utf8") }))
    .filter(({ bytes }) => bytes.length >= ENCODED_RUN_MIN_BYTES)
    .sort((a, b) => b.bytes.length - a.bytes.length);
  if (needles.length === 0) return text;
  const spans: Array<{ from: number; to: number; name: string }> = [];
  for (const view of ENCODED_VIEWS) {
    for (const run of encodedRuns(text, view.runs)) {
      const found = encodedRunSpans(run, view, needles);
      // A run that reaches the END of a text argent cut may hold the FRONT of a
      // value rather than the whole of it, and this pass had no branch for one:
      // `partialSecretTail` is the only cut guard on the path, and it searches
      // for a prefix of a SPELLING — which works only while the encoding is
      // character-local, and base64 is the encoding that is not. So the idiom
      // this pass exists for, `"Basic " + base64("api:" + key)`, left a
      // decodable prefix of the credential standing whenever argent's own 8 KiB
      // ceiling cut inside the payload.
      spans.push(...found);
      if (found.length === 0 && cutAtEnd && endsTheText(run, text)) {
        spans.push(...encodedCutSpans(run, view, needles));
      }
    }
  }
  return spliceSpans(text, spans);
}

/** Whether this run runs to the last character of the text. */
function endsTheText(run: EncodedRun, text: string): boolean {
  return run.at[run.at.length - 1] === text.length - 1;
}

/**
 * Where a run that argent's clamp cut spells the FRONT of a value.
 *
 * Longest first, and shorter than the value, exactly as {@link byteRunSpans}
 * reads a cut run and {@link quotedCutBefore} reads one in text space. Read at
 * every frame offset for the same reason the whole-value search is: a payload
 * does not have to start on one.
 *
 * Floored at {@link ENCODED_RUN_MIN_BYTES}, like the needles themselves — a
 * shorter tail says more about the alphabet than about the value, and this
 * branch asks about one position rather than every position in the run.
 */
function encodedCutSpans(
  run: EncodedRun,
  view: (typeof ENCODED_VIEWS)[number],
  needles: ReadonlyArray<{ name: string; bytes: Buffer }>
): Array<{ from: number; to: number; name: string }> {
  for (let offset = 0; offset < view.chars && offset < run.chars.length; offset++) {
    const decoded = Buffer.from(run.chars.slice(offset), view.encoding);
    for (const { name, bytes } of needles) {
      const longest = Math.min(bytes.length - 1, decoded.length);
      for (let n = longest; n >= ENCODED_RUN_MIN_BYTES; n--) {
        if (decoded.compare(bytes, 0, n, decoded.length - n, decoded.length) !== 0) continue;
        const first = offset + Math.floor((decoded.length - n) / view.bytes) * view.chars;
        return first < run.at.length
          ? [{ from: run.at[first]!, to: run.at[run.at.length - 1]! + 1, name }]
          : [];
      }
    }
  }
  return [];
}

const ENCODED_RUN_MIN_BYTES = 4;

/**
 * The alphabets a re-encoding is read in, with the frame each one writes.
 *
 * `base64url` is its own view rather than a lenient read of the standard
 * alphabet: `-` and `_` widen a run across ordinary hyphenated words, which
 * would move a standard payload out of its frame.
 */
const ENCODED_VIEWS = [
  { encoding: "hex", runs: /[0-9A-Fa-f][0-9A-Fa-f\r\n]*[0-9A-Fa-f]/g, chars: 2, bytes: 1 },
  {
    // `=` is left OUT of the alphabet on purpose. It is padding, so it only
    // ever ends a payload — and a decoder stops there, so `?token=<payload>`
    // read as one run decoded the word in front of the credential and nothing
    // after it. Ending the run at the `=` instead leaves the payload a run of
    // its own, which is what it is.
    encoding: "base64",
    runs: /[A-Za-z0-9+/][A-Za-z0-9+/\r\n]*[A-Za-z0-9+/]/g,
    chars: 4,
    bytes: 3,
  },
  {
    encoding: "base64url",
    runs: /[A-Za-z0-9\-_][A-Za-z0-9\-_\r\n]*[A-Za-z0-9\-_]/g,
    chars: 4,
    bytes: 3,
  },
] as const;

/** One run's alphabet characters, with where each of them sits in the text. */
interface EncodedRun {
  chars: string;
  at: number[];
}

/** Maximal runs of one alphabet, with the wrap newlines inside them dropped. */
function encodedRuns(text: string, pattern: RegExp): EncodedRun[] {
  const runs: EncodedRun[] = [];
  for (const match of text.matchAll(pattern)) {
    const run: EncodedRun = { chars: "", at: [] };
    for (let cursor = 0; cursor < match[0].length; cursor++) {
      const character = match[0][cursor]!;
      if (character === "\n" || character === "\r") continue;
      run.chars += character;
      run.at.push(match.index + cursor);
    }
    if (run.chars.length >= ENCODED_RUN_MIN_BYTES) runs.push(run);
  }
  return runs;
}

/** Where in the text this run spells a value, read in one alphabet. */
function encodedRunSpans(
  run: EncodedRun,
  view: (typeof ENCODED_VIEWS)[number],
  needles: ReadonlyArray<{ name: string; bytes: Buffer }>
): Array<{ from: number; to: number; name: string }> {
  const spans: Array<{ from: number; to: number; name: string }> = [];
  // Every frame offset the run can start on, because a run does not have to
  // start on one. The separator in front of a payload is what aligns it, and a
  // prefix glued straight on — `"u" + …`, or a query key the `=` no longer
  // ends — puts the whole payload one, two or three characters into its first
  // frame, where a single decode reads only rubbish. There are `chars` of them
  // and each is one linear decode.
  for (let offset = 0; offset < view.chars && offset < run.chars.length; offset++) {
    const decoded = Buffer.from(run.chars.slice(offset), view.encoding);
    for (const { name, bytes } of needles) {
      for (let found = decoded.indexOf(bytes); found >= 0; ) {
        const first = offset + Math.floor(found / view.bytes) * view.chars;
        const last = Math.min(
          run.at.length,
          offset + Math.ceil((found + bytes.length) / view.bytes) * view.chars
        );
        if (first < last) spans.push({ from: run.at[first]!, to: run.at[last - 1]! + 1, name });
        found = decoded.indexOf(bytes, found + bytes.length);
      }
    }
  }
  return spans;
}

/**
 * The spans replaced by their placeholders, earliest first.
 *
 * A span that STARTS inside one already replaced is clipped to what is left of
 * it, not dropped. Dropping it lost a whole credential: {@link encodedRunSpans}
 * widens a byte match out to the base64 frames it lies in, so two values inside
 * one payload — `Basic base64(user:key)`, the idiom this pass exists for —
 * produce spans that share a frame whenever the first value's length leaves the
 * second starting mid-frame. The first was replaced, the second was discarded
 * whole, and everything from the end of the first span to the end of the second
 * was copied out in the clear: one base64 hop from the key.
 *
 * Clipping can only ever over-redact, because a span says the text it covers
 * spells a value. Two placeholders then sit side by side, which is what two
 * values in one payload really are.
 */
function spliceSpans(
  text: string,
  spans: Array<{ from: number; to: number; name: string }>
): string {
  if (spans.length === 0) return text;
  let out = "";
  let copied = 0;
  for (const { from, to, name } of spans.sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (to <= copied) continue;
    out += `${text.slice(copied, Math.max(from, copied))}${SECRET_PLACEHOLDER_MARKER}${name}}}`;
    copied = to;
  }
  return out + text.slice(copied);
}

/** Node's ellipsis, in both spellings; argent's own markers carry a count. */
const FOREIGN_CUT_RE = /\.\.\.|…/g;

/** The same, without the `g` whose `lastIndex` a repeated `test` would carry. */
const GAP_CUT_RE = /\.\.\.|…/;

const CUT_QUOTES = new Set(['"', "'", "`"]);

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

/**
 * The document goes in, and the same file is what comes back out — which is
 * what makes the merge rule in a later PR identical for both languages, and
 * what will let a script that wants to ADD one key read what it was given
 * first. Nothing hands a document in yet: `flow-script-step.ts` passes
 * `output: {}` on every step, so what a `.sh` reads back today is always the
 * empty seed.
 *
 * The file carries the document, and the document may hold values derived from
 * a secret, so it is written 0600 rather than left to the umask. The barrier
 * that holds is the 0700 `mkdtemp` directory around it, not the mode on the
 * file: `docs/reference/flow-yaml.mdx` teaches writing a sibling and `mv`-ing
 * it into place - which is the way past the empty-file failure a redirection
 * straight into `$ARGENT_OUTPUT` gives - and a `mv` replaces the inode, so the
 * document Argent reads back carries the script's own umask, 0644 on an
 * ordinary host.
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
 * remove, and a throw from the write leaves the caller without one.
 */
function createExchange(
  root: string,
  outputJson: string,
  timeoutMs: number,
  sweepIntervalMs: number
): ExchangeFiles {
  startStaleExchangeSweep(root, sweepIntervalMs);
  // Rounded UP to a whole millisecond, because the sweep below reads the stamp
  // back with `/^(\d+)-/` and a `timeout: 30000.5` in a flow file is a positive
  // finite number the parser keeps. A `.` in the name matches nothing there, so
  // the directory would be passed over for good — and rounding up never shortens
  // the bound the owner claimed.
  const ownUntil = Math.ceil(Date.now() + timeoutMs + EXCHANGE_LIFE_MARGIN_MS);
  const dir = fs.mkdtempSync(path.join(root, `${EXCHANGE_DIR_PREFIX}${ownUntil}-`));
  try {
    const outputFile = path.join(dir, EXCHANGE_OUTPUT_FILE);
    fs.writeFileSync(outputFile, outputJson, { encoding: "utf8", mode: EXCHANGE_FILE_MODE });
    return { dir, outputFile };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function removeExchange(exchange: ExchangeFiles, notes: string[]): void {
  try {
    fs.rmSync(exchange.dir, { recursive: true, force: true });
  } catch (err) {
    // What the sweep can and cannot do, because it is the SAME call: both are a
    // recursive `rm` with `force`, one sync and one async. So a cause that
    // clears on its own - a Windows EBUSY from a descendant that has since
    // exited - is swept, and a cause that does not, such as a mode the script
    // put on the directory itself, is still there after every later step. The
    // note said "a later bash step sweeps it" for both, and the directory
    // holding the document sat in $TMPDIR for good.
    notes.push(
      `The script's private directory ${exchange.dir} could not be removed ` +
        `(${errorMessage(err)}); it still holds the document the script wrote. A later bash ` +
        `step sweeps it with the same recursive remove once this step's own time limit has ` +
        `passed, so a cause that call cannot get past - a mode the script changed on the ` +
        `directory itself - needs the directory removed by hand.`
    );
  }
}

let sweptStaleExchangesAt = 0;

/**
 * The sweep this process last started, until it finishes. `runOne` waits on it
 * before it returns, so a step never outlives its own sweep and a test can read
 * the root the moment `execute` resolves - the sweep itself runs beside the
 * step it was started for, not in front of it.
 */
let pendingSweep: Promise<void> | undefined;

/**
 * Start the sweep, at most once per interval, and never wait for it here. The
 * throttle bounds how OFTEN the root is read; it does not bound what one read
 * costs, and in production that root is `os.tmpdir()` - shared with every other
 * process on the host and bounded by nothing. A `readdirSync` there took 48 ms
 * on a machine holding 88 000 entries, on the tool server's main thread: no MCP
 * request, device socket or timer ran during it, and the bash step's own wall
 * time roughly doubled. The stall grows over a machine's life, since the
 * directory it reads is one the tool server never prunes.
 */
function startStaleExchangeSweep(root: string, sweepIntervalMs: number): void {
  const now = Date.now();
  if (now - sweptStaleExchangesAt < sweepIntervalMs) return;
  sweptStaleExchangesAt = now;
  const sweep = sweepStaleExchanges(root).finally(() => {
    if (pendingSweep === sweep) pendingSweep = undefined;
  });
  pendingSweep = sweep;
}

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
 *
 * Asynchronous throughout, for the reason {@link startStaleExchangeSweep}
 * gives: every call here is one the event loop can leave.
 */
async function sweepStaleExchanges(root: string): Promise<void> {
  const now = Date.now();
  let dir: fs.Dir;
  try {
    // `opendir` rather than `readdir`: a `readdir` of this root builds one
    // array of every name in it, and that array is built on the main thread
    // however the read itself was scheduled - 60 000 entries cost 33 ms of
    // blocked loop whether the call was `readdirSync` or awaited. A directory
    // handle hands back a small batch per turn instead, so no single slice is
    // one anything else has to wait behind.
    dir = await fs.promises.opendir(root, { bufferSize: EXCHANGE_SWEEP_BATCH });
  } catch {
    return;
  }
  try {
    for await (const entry of dir) {
      if (!entry.name.startsWith(EXCHANGE_DIR_PREFIX)) continue;
      const ownUntil = exchangeOwnedUntil(entry.name);
      if (ownUntil === undefined || ownUntil > now) continue;
      try {
        await fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true });
      } catch {
        // Raced with the step that owns it, or with another server's own sweep.
      }
    }
  } catch {
    // The directory went away, or became unreadable, while it was being read.
  }
}

/**
 * The moment the name is stamped with, or `undefined` for a name that carries
 * no stamp. Digits only, so the value is a non-negative integer and no range
 * check is owed: a digit string too long to be exact is at least 2^53, which
 * the caller reads as a directory still owned and leaves alone — the same
 * branch an unstamped name takes.
 */
function exchangeOwnedUntil(entry: string): number | undefined {
  const stamped = /^(\d+)-/.exec(entry.slice(EXCHANGE_DIR_PREFIX.length));
  return stamped ? Number(stamped[1]) : undefined;
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

export function buildChildEnv(
  overrides: Record<string, string> | undefined,
  extraAllowed: readonly string[] = []
): NodeJS.ProcessEnv {
  // Windows environment names are case-insensitive, so a host may surface any
  // of these under non-canonical casing; POSIX names are exact.
  const caseInsensitive = process.platform === "win32";
  const allowed = new Set(
    [...ALLOWED_ENV_NAMES, ...extraAllowed].map((name) =>
      caseInsensitive ? name.toLowerCase() : name
    )
  );
  const reservedName = (name: string) => reservedScriptEnvName(name, caseInsensitive);
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
          `(reserved names: ${reservedScriptEnvNamesForMessage()}).`
      );
    }
    // On Windows an override spelled differently from the host's own name is
    // the SAME variable, and writing it under the override's spelling would
    // send both to the fork. Node then dedupes them case-insensitively and
    // keeps whichever sorts first — so ASCII order, not the documented
    // precedence, would decide which value the script reads. The host's
    // spelling goes, the override's stays.
    if (caseInsensitive) {
      for (const existing of Object.keys(env)) {
        if (existing !== name && existing.toLowerCase() === name.toLowerCase())
          delete env[existing];
      }
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
 * Why the process would not start, with the one refusal that names nothing on
 * its own spelled out.
 *
 * The operating system caps the block of arguments and environment a new
 * process is handed (`ARG_MAX`), and Node reports the refusal as a bare
 * `spawn E2BIG`. Every other environment failure in this file is diagnosed by
 * name; this one would point the author nowhere, and an `env` map is the one
 * part of that block a flow controls.
 */
function spawnFailureMessage(err: unknown, env: NodeJS.ProcessEnv): string {
  const message = errorMessage(err);
  if (!/\bE2BIG\b/.test(message)) return `Could not start the script process: ${message}`;
  return (
    `Could not start the script process: ${message} — the environment it would carry is ` +
    `${environmentBytes(env)} bytes, past this operating system's limit for one process ` +
    `(ARG_MAX). Shorten the \`env\` values, or write the payload to a file and pass its path.`
  );
}

/**
 * When an environment is big enough to be worth naming as a possible cause of a
 * runner that died before it started the script.
 *
 * Well clear of an ordinary one — the host allowlist and a handful of flow
 * values come to a few kilobytes — so the note stays off every other way that
 * failure arrives. The smallest `ARG_MAX` argent runs on is an order of
 * magnitude above this, which is the point: the note is a lead, not a bound.
 */
const LARGE_ENVIRONMENT_BYTES = 128 * 1024;

/** What the environment costs against that limit: `NAME=value`, NUL-terminated. */
function environmentBytes(env: NodeJS.ProcessEnv): number {
  let total = 0;
  for (const [name, value] of Object.entries(env)) {
    total += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value ?? "", "utf8") + 2;
  }
  return total;
}

/**
 * Why this name cannot be an environment variable name, or null when it can.
 *
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
  // The one name the operating system WOULD carry that this function still
  // refuses: the copy above writes each entry onto a plain object, where
  // `__proto__` is an accessor rather than an entry, so the value would vanish
  // between here and the child with the step passing anyway.
  //
  // Nothing reaches it today. `describeScriptEnvProblem` refuses the name on
  // both YAML channels — a flow file's own `env:` and a `script` step's — and
  // `scriptEnvParameter` refuses it on the two tool channels, `flow-execute`'s
  // `env` and `flow-add-script`'s, where it has to be caught before `z.record`
  // rebuilds the map without it. Four call sites, not two, and the tool
  // channels refuse rather than drop. It is the last line, not the live one,
  // and it is kept because the hazard belongs to THIS function's own copy.
  if (name === PROTO_ENV_NAME) {
    return (
      "names an accessor on a plain object rather than an entry, so the value would be dropped " +
      "on the way to the child"
    );
  }
  return null;
}

/**
 * What the bash lookup cost, when it cost enough to explain a step that ran
 * longer than its own `timeout`.
 *
 * The lookup sits between `startedAt` and the timer `runChild` arms, so its
 * time is inside `durationMs` and outside `timeoutMs`, and the queue's
 * `queuedMs` does not carry it either — a step declared at 500 ms took 3.3
 * seconds behind a slow candidate, and 6.1 behind one that ignores SIGTERM,
 * with nothing anywhere saying why. `flow-yaml.mdx` names the queue as the one
 * source of an over-run and requires the step to report it; this is the second
 * source, and a `.mjs` step has no equivalent — everything between those two
 * points there is a `statSync` and a `JSON.stringify`.
 *
 * Reported against the step's own limit rather than at a fixed number of
 * milliseconds, so an ordinary lookup on an ordinary host stays silent and one
 * that is worth a sentence beside a short `timeout` gets one.
 */
function noteInterpreterLookup(lookupMs: number, timeoutMs: number, notes: string[]): void {
  if (lookupMs < Math.max(INTERPRETER_LOOKUP_NOTE_FLOOR_MS, timeoutMs / 2)) return;
  notes.push(
    `Finding the bash for this step took ${lookupMs} ms, which is outside the step's own ` +
      `${timeoutMs} ms limit: each candidate is run once and asked for its version. Set ` +
      `scripts.bash to the bash you want, and the search stops at it.`
  );
}

/** Below this the lookup is not worth a sentence, however short the `timeout`. */
const INTERPRETER_LOOKUP_NOTE_FLOOR_MS = 250;

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
 * A configuration value read against the FLOW's project, not against the tool
 * server's own working directory — which is whatever the editor that spawned it
 * chose, so the bare {@link configuredNumber} call above would read another
 * project's `.argent/config.json`, or none. `getConfigValue` resolves the
 * project scope from `options.cwd`.
 *
 * Only a key the project scope READS needs this. The script bounds do not:
 * `readScopeValue` gates a read on the key's own `scopes`, so a global-only key
 * ignores a project file whatever anchor it is given.
 */
function projectAnchoredConfigValue<T>(key: string, anchor: string | undefined): T | undefined {
  const def = getConfigDefinition(key) as ConfigDefinition<T> | undefined;
  if (!def) return undefined;
  return getConfigValue(def, anchor ? { cwd: anchor } : {});
}

/**
 * The names a project added to the allowlist through `scripts.env.allow`.
 *
 * The built-in list will never be complete — a project's own toolchain names
 * one the next project has never heard of — so it is extensible by
 * configuration. The extension is read from the project scope as well as the
 * global one, unlike the time and heap bounds, because it decides what a script
 * may READ rather than how much of the machine it may occupy.
 *
 * Anchored at the run's project root, not at the tool server's working
 * directory: that is a snapshot from whatever spawned the server, so the
 * default would read another project's configuration, or none at all.
 *
 * A name that would put argent's own credentials back is dropped and reported
 * in the run's notes rather than silently honoured. Without that rule a
 * checked-in `.argent/config.json` — a file an agent writes — could hand the
 * bearer token to every script in the repository.
 */
function configuredEnvAllowNames(
  projectRoot: string | undefined,
  notes: string[],
  alreadySaid: FlowScriptRunNotes | undefined
): string[] {
  // The configuration is the same for every step of a run, so each note is said
  // once and not on each of them. `alreadySaid` is the RUN's set, and a caller
  // that runs one script has no run — `flow-add-script` passes none — so the
  // fallback is a set of this call's own. Without it a host where the project
  // root IS the home directory resolves both scopes to one file and said every
  // note about that file twice, in one `reason`.
  const said = alreadySaid ?? new Set<string>();
  const say = (note: string): void => {
    if (said.has(note)) return;
    notes.push(note);
    said.add(note);
  };
  const options = projectRoot ? { cwd: projectRoot } : {};
  // Which file each name came from, for the notes below. The key is read
  // per-scope here and merged as a union afterwards, so this loop is the last
  // point that still knows: by the time a name is judged, the two lists are one.
  const listedIn = new Map<string, string[]>();
  // A value the key's own parser cannot read comes back as `undefined`, which
  // is what an UNSET key comes back as — so `scripts.env.allow: "DATABASE_URL"`,
  // the string spelling of a one-name list, went unread and every script ran
  // without the name, with nothing said. The raw document is the only place
  // that still says which of the two this was.
  for (const scope of ["project", "global"] as const) {
    const file = configFilePath(scope, options);
    // Read here rather than through `readConfigObject`, which answers `{}` for
    // a document it could not parse AND for one that is absent — the same
    // silence this note exists to end. A file that does not open is absent and
    // says nothing; one that opens and does not parse loses EVERY key it holds,
    // this one included, and that is worth a sentence.
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      say(
        `${file} is not valid JSON, so argent read nothing from it at all — ` +
          `${SCRIPT_ENV_ALLOW_KEY} included — and the script ran without every name it lists. ` +
          `Repair the file.`
      );
      continue;
    }
    const raw =
      typeof document === "object" && document !== null && !Array.isArray(document)
        ? getAtPath(document as Record<string, unknown>, SCRIPT_ENV_ALLOW_KEY)
        : undefined;
    if (Array.isArray(raw)) {
      // An entry that is not a string, or a blank one, is gone by the time the
      // four notes below run: the key's own parser drops it. So the raw array
      // in hand here is the last place that can name it, and without a note the
      // drop was the same silence the notes around it exist to end — a nested
      // list, the natural mis-grouping for a pair of names, took both of them
      // out of every script's reach and the run said nothing.
      const unreadable: string[] = [];
      // Trimmed, because `asStringArray` trims before the names are judged, so
      // an untrimmed key would never be found again.
      for (const entry of raw) {
        if (typeof entry !== "string" || entry.trim() === "") {
          unreadable.push(JSON.stringify(entry) ?? String(entry));
          continue;
        }
        const files = listedIn.get(entry.trim()) ?? [];
        files.push(file);
        listedIn.set(entry.trim(), files);
      }
      if (unreadable.length > 0) {
        const many = unreadable.length > 1;
        say(
          `${SCRIPT_ENV_ALLOW_KEY} in ${file} holds ${unreadable.join(", ")}, which argent reads ` +
            `no name from — an entry is a string naming one variable. ` +
            `${many ? "Those entries were" : "That entry was"} ignored and the script ran ` +
            `without ${many ? "them" : "it"}. A nested list is the usual way in: write ` +
            `["AWS_PROFILE", "AWS_REGION"], not [["AWS_PROFILE", "AWS_REGION"]].`
        );
      }
      continue;
    }
    if (raw === undefined) continue;
    say(
      `${SCRIPT_ENV_ALLOW_KEY} in ${file} is not a list, so argent ` +
        `read no names from it and the script ran without them. Write it as an array of names, ` +
        `e.g. ["DATABASE_URL"].`
    );
  }
  /**
   * Where the names a note drops are listed, as a closing sentence.
   *
   * The "is not a list" note beside these already names its file; these four
   * named none, so with a project list AND a global one configured the reader
   * was told a name was dropped and left to guess which of the two files holds
   * it. Once per note rather than once per name: every name in one note usually
   * comes from one file, and repeating a path after each of three names buries
   * the sentence that says what was wrong.
   *
   * Silent when only one file is configured — there is nothing to disambiguate
   * — and when the union merged the two lists into names this loop never saw.
   */
  const configuredFiles = new Set([...listedIn.values()].flat());
  const listedInClause = (names: readonly string[]): string => {
    if (configuredFiles.size < 2) return "";
    const files = [...new Set(names.flatMap((name) => listedIn.get(name) ?? []))];
    return files.length === 0 ? "" : ` Listed in ${files.join(" and ")}.`;
  };
  // Anchored on the flow's project: this is the one script key the project
  // scope is read for, and the tool server's own working directory is another
  // project's, or none.
  const configured = projectAnchoredConfigValue<string[]>(SCRIPT_ENV_ALLOW_KEY, projectRoot);
  if (!Array.isArray(configured) || configured.length === 0) return [];
  const kept: string[] = [];
  // Two buckets, because the two answers differ. An `ARGENT_*` name is one
  // argent keeps out of the copy it takes from its OWN environment, and the
  // value the script wanted can be passed under a name of the project's own. A
  // reserved name steers the RUNNER — `NODE_OPTIONS`, `npm_config_userconfig` —
  // so it never reaches the script whatever it is called, and there is no name
  // of your own to pass it under. Said as one sentence, each was told the
  // other's story.
  const owned: string[] = [];
  const reserved: string[] = [];
  const malformed: string[] = [];
  // Its own bucket. It satisfies the name rule to the letter — starts with `_`,
  // continues with letters and `_` — so the malformed note would state a rule
  // the name plainly meets, while the YAML channel explains the same name
  // correctly. Two contradictory answers to one question.
  const unusable: string[] = [];
  for (const name of configured) {
    // The name PATTERN is asked LAST, because one reserved name does not match
    // it — `npm_config_node-options`, npm's own spelling and the one every
    // other refusal here advertises. Asked first, it dropped that entry into
    // the malformed bucket, which states a rule the reference table's own
    // spelling of the name breaks.
    if (name === PROTO_ENV_NAME) unusable.push(name);
    else if (argentOwnedEnvName(name)) owned.push(name);
    else if (reservedScriptEnvName(name)) reserved.push(name);
    else if (!SCRIPT_ENV_NAME_PATTERN.test(name)) malformed.push(name);
    else kept.push(name);
  }
  if (owned.length > 0) {
    say(
      `${SCRIPT_ENV_ALLOW_KEY} names ${owned.join(", ")}, which argent keeps out of the copy ` +
        `it takes from its own environment; ` +
        `${owned.length > 1 ? "those entries were" : "that entry was"} ` +
        `ignored. Pass the value the script needs under a name of your own instead.${listedInClause(owned)}`
    );
  }
  if (reserved.length > 0) {
    // One clause for the whole list, and it is the one
    // {@link reservedScriptEnvReason} gives each of these names: the bash
    // exchange pair is the only reserved name with a different reason, and both
    // spellings start with `ARGENT_`, so they were taken by the bucket above.
    // A reserved name added later WITHOUT that prefix and with a reason of its
    // own belongs there too, or this sentence will speak for it wrongly.
    say(
      `${SCRIPT_ENV_ALLOW_KEY} names ${reserved.join(", ")}, which ` +
        `${reserved.length > 1 ? "steer" : "steers"} the runner's own process rather than ` +
        `reaching the script, so no allowlist entry can pass ` +
        `${reserved.length > 1 ? "them" : "it"} through; ` +
        `${reserved.length > 1 ? "those entries were" : "that entry was"} ignored.` +
        listedInClause(reserved)
    );
  }
  if (unusable.length > 0) {
    say(
      `${SCRIPT_ENV_ALLOW_KEY} names ${PROTO_ENV_NAME}, which argent cannot carry: the ` +
        `operating system takes the name, but every merge on the way to the child copies the ` +
        `map through a plain object, where ${PROTO_ENV_NAME} is an accessor rather than an ` +
        `entry. That entry was ignored. Use a name of your own.` +
        listedInClause(unusable)
    );
  }
  if (malformed.length > 0) {
    say(
      `${SCRIPT_ENV_ALLOW_KEY} names ${malformed.map((name) => JSON.stringify(name)).join(", ")}, ` +
        `which ${malformed.length > 1 ? "are not environment variable names" : "is not an environment variable name"} ` +
        `— a name starts with a letter or "_" and continues with letters, digits or "_". ` +
        `${malformed.length > 1 ? "Those entries were" : "That entry was"} ignored.` +
        listedInClause(malformed)
    );
  }
  return kept;
}

/**
 * A name argent's own process uses. The allowlist keeps these out by
 * construction; the configured extension must not be a way back in.
 *
 * The whole prefix, not a list of the names known today: the set this must keep
 * out — the bearer token, the port, every `ARGENT_SECRET_*` value, the telemetry
 * ingest token a release build exports — is exactly the set that grows without
 * this file being touched, which is the argument the built-in allowlist is
 * built on. A script that needs one of these values is asking for argent's own
 * configuration; pass what it needs under a name of the project's own.
 */
function argentOwnedEnvName(name: string): boolean {
  return name.toUpperCase().startsWith(ARGENT_ENV_PREFIX);
}

/**
 * Prefix of every environment name argent gives its own process — the bearer
 * token, the server's address, and every `ARGENT_SECRET_` value.
 */
const ARGENT_ENV_PREFIX = "ARGENT_";

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
  lastLine?: LastLineTracker;
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
  private stderrLastLine = "";

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
      if (state.lastLine) this.stderrLastLine = state.lastLine.end();
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

  /** The last line stderr carried that was not blank; see {@link LastLineTracker}. */
  get lastStderrLine(): string {
    return this.stderrLastLine;
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
          ? {
              collapser: new V8FrameCollapser(),
              watchForHeapFatal: true,
              lastLine: new LastLineTracker(),
            }
          : {}),
      };
      this.streams.set(stream, state);
    }
    return state;
  }

  private consume(state: StreamState, text: string, final: boolean): void {
    if (!text && !final) return;
    if (state.watchForHeapFatal) this.watchForHeapFatal(text);
    // Ahead of the scrub and the limits, which shape the log and not this: a
    // script that floods stderr and then says why it failed still says it.
    state.lastLine?.write(text);
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

/**
 * The last line a stream carried that was not blank: where a bash step that
 * exited non-zero says why, whether that is its own `echo … >&2` or the error of
 * the command `set -e` stopped on. Fed the text as the script wrote it, because
 * what this returns joins the failure message and is redacted with it.
 *
 * Only the head of each line is kept, so a long line is cut at its end: that is
 * where `redactTruncated` looks for the half of a value a cut leaves, and a cut
 * at the start would leave the other half where nothing looks.
 */
class LastLineTracker {
  private head = "";
  private length = 0;
  private blank = true;
  private last = "";

  write(text: string): void {
    let from = 0;
    for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", from)) {
      this.extend(text.slice(from, nl));
      this.close();
      from = nl + 1;
    }
    this.extend(text.slice(from));
  }

  end(): string {
    this.close();
    return this.last;
  }

  private extend(segment: string): void {
    const room = STDERR_REASON_LINE_CHARS - this.head.length;
    if (room > 0) this.head += segment.slice(0, room);
    this.length += segment.length;
    // Over the WHOLE line, not the head: a line of nothing but whitespace is
    // blank at any length, and one whose first character comes after the head
    // is not.
    if (this.blank && /\S/.test(segment)) this.blank = false;
  }

  private close(): void {
    if (!this.blank) this.last = this.length > this.head.length ? this.cut() : this.head.trim();
    this.head = "";
    this.length = 0;
    this.blank = true;
  }

  /**
   * The head, moved back off the first half of a surrogate pair the limit
   * split, then marked the way `clampText` marks a cut.
   */
  private cut(): string {
    const final = this.head.charCodeAt(this.head.length - 1);
    const kept = final >= 0xd800 && final <= 0xdbff ? this.head.slice(0, -1) : this.head;
    return `${kept.trimStart()}${omissionMarker(this.length - kept.length)}`;
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
