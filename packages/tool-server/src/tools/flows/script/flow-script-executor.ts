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
import { makeSensitiveBank } from "@zapier/secret-scrubber/lib/utils";
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
const STDERR_REASON_LINE_CHARS = 1_000;
const SETTLE_TIMEOUT_MS = 500;
/**
 * How long after the child exits the settle keeps waiting for a process that
 * still holds the output streams and is still writing to them. A stderr
 * consumer - `exec 2> >(…)`, the timestamp idiom - is still working through
 * its backlog when bash exits, and the stop would cut its last lines, the
 * script's own error among them. A job that never stops writing holds the step
 * this long, and then the log is marked cut.
 */
const SETTLE_WRITING_LIMIT_MS = 3_000;
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

const EXCHANGE_DIR_PREFIX = "argent-flow-script-";

/**
 * How long past its own time limit a step's exchange directory is still its
 * own. The owner removes it in a `finally` at about `timeout` plus the settle,
 * stop and force graces; the minute after that is room for a stall in the tool
 * server's event loop of the kind `CHILD_DEADLINE_MARGIN_MS` exists for.
 * Nothing waits on it but the collection of a directory whose server died.
 */
const EXCHANGE_LIFE_MARGIN_MS =
  SETTLE_WRITING_LIMIT_MS + CHILD_DEADLINE_MARGIN_MS + STOP_GRACE_MS + FORCE_GRACE_MS + 60_000;
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
 * blocks. {@link removeTree} reads a directory the same way, and keeps no more
 * removals than this in flight.
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
      const lookupStartedAt = Date.now();
      const found = await resolveBashInterpreter(env, request.signal, cwd);
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
        //
        // Redacted either way: a refusal quotes what the candidate wrote to
        // stderr, and the candidate ran under this step's resolved `env`.
        return emptyResult(
          {
            kind: "spawn",
            message: redactBounded(
              /\bE2BIG\b/.test(found.problem)
                ? spawnFailureMessage(new Error("spawn E2BIG"), env)
                : found.problem,
              request.secrets ?? [],
              SCRIPT_MAX_FAILURE_MESSAGE_CHARS
            ),
          },
          { notes, durationMs: Date.now() - startedAt }
        );
      }
      interpreterPath = found.path;
      if (found.note) notes.push(scrubScriptText(found.note, request.secrets ?? []));
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
      if (exchange) await removeExchange(exchange, notes);
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
    let stderrLineAtVerdict: string | undefined;
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

    let lastOutputAt = 0;
    let lastStderrAt = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      lastOutputAt = Date.now();
      capture.push("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      lastOutputAt = lastStderrAt = Date.now();
      capture.push("stderr", chunk);
    });

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
      // Where stderr stood when the runner answered, which in bash mode is when
      // bash exited: the reason falls back to it when a job the script left
      // running is still writing when the settle below gives up. Read on the
      // next turn, so that what bash wrote before it exited, already in the
      // pipe, is read first.
      setImmediate(() => (stderrLineAtVerdict = capture.stderrLineSoFar));
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
    // inherited the streams and is holding them open, and it stretches while
    // that descendant is still writing. A run cancelled after the script's
    // process exited ends it once the first settle has passed. One cancelled
    // before that was stopped already, and what it left holding the streams is
    // waited for as any other is.
    //
    // Beside it, the line stderr stood on when it first went quiet for a settle
    // after the script's process exited, which the reason takes: see below.
    const exitedAt = Date.now();
    const stderrQuietFor = () => Date.now() - Math.max(exitedAt, lastStderrAt);
    let stderrLineAtQuiet: string | undefined;
    let stderrQuietTimer: NodeJS.Timeout | undefined;
    let watchingStderr = true;
    const watchStderr = () => {
      if (!watchingStderr) return;
      const quietFor = stderrQuietFor();
      if (quietFor >= SETTLE_TIMEOUT_MS) stderrLineAtQuiet = capture.stderrLineSoFar;
      else {
        stderrQuietTimer = setTimeout(
          () => setImmediate(watchStderr),
          SETTLE_TIMEOUT_MS - quietFor
        );
      }
    };
    watchStderr();
    const settleSignal = request.signal?.aborted ? undefined : request.signal;
    const settled = await settleStreams(closed, () => lastOutputAt, settleSignal);
    watchingStderr = false;
    clearTimeout(stderrQuietTimer);
    if (
      stderrLineAtQuiet === undefined &&
      (settleSignal?.aborted === true || stderrQuietFor() >= SETTLE_TIMEOUT_MS)
    ) {
      stderrLineAtQuiet = capture.stderrLineSoFar;
    }
    await stop();
    capture.end();
    if (settled === "cut") {
      // Not "stopped": on Windows the tree stop reaches nothing once the runner
      // has exited, and on POSIX it cannot reach a job in a group of its own.
      // What holds everywhere is that Argent stops reading.
      notes.push(
        `A process the script left running was still writing to the log when Argent stopped ` +
          `reading it, so the log misses what it wrote after that. Stop or wait for each ` +
          `background job before the script exits.`
      );
    }
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
    // After bash exits, stderr carries two kinds of line: the script's own,
    // late - a consumer in front of stderr still working through its backlog -
    // and those of a job the script left running. The first come as one run
    // from the moment bash exits; a job writes whenever it writes. So the line
    // is the one stderr stood on when it first went quiet for a settle after
    // bash exited: that run counts, a later line does not, and neither does a
    // job's answer to the stop. Streams that closed while stderr was still
    // running on count in full. Stderr that never went quiet is a job still
    // writing, and then the line is the one bash exited on.
    let stderrLine = stderrLineAtQuiet;
    if (stderrLine === undefined) {
      stderrLine =
        settled === "closed"
          ? capture.lastStderrLine
          : (stderrLineAtVerdict ?? capture.lastStderrLine);
    }
    const verdict = redactSecrets(
      run.interpreter === "bash" ? withStderrLine(outcome, stderrLine) : outcome,
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
      logTruncated: capture.truncated || settled === "cut",
      durationMs: Date.now() - startedAt,
      queuedMs: 0,
      notes,
    };
  }
}

async function settleStreams(
  closed: Promise<void>,
  lastOutputAt: () => number,
  signal?: AbortSignal
): Promise<"closed" | "quiet" | "cut"> {
  const startedAt = Date.now();
  const limitAt = startedAt + SETTLE_WRITING_LIMIT_MS;
  const isClosed = closed.then(() => true);
  const abortFrom = startedAt + SETTLE_TIMEOUT_MS;
  let onAbort = (): void => {};
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    for (;;) {
      const quietAt = Math.max(startedAt, lastOutputAt()) + SETTLE_TIMEOUT_MS;
      const cancelled = signal?.aborted === true;
      if (cancelled && Date.now() >= abortFrom) {
        return lastOutputAt() > startedAt && quietAt > Date.now() ? "cut" : "quiet";
      }
      const wait = Math.min(quietAt, limitAt, cancelled ? abortFrom : Infinity) - Date.now();
      if (wait <= 0) return quietAt <= limitAt ? "quiet" : "cut";
      const racers: Promise<boolean>[] = [isClosed, sleep(wait).then(() => false)];
      if (!cancelled) racers.push(aborted);
      if (await Promise.race(racers)) return "closed";
      // A timer that fires after the loop was blocked runs before the poll
      // that reads what arrived meanwhile, so one turn goes by before the next
      // look at when output last came.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
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

function childProblem(
  value: unknown,
  at: string,
  depth: number,
  pending: Array<{ node: unknown; at: string; depth: number }>
): string | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) {
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

function memberPath(key: string): string {
  return IDENTIFIER_RE.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/**
 * Each resolved value, and each form of it `@zapier/secret-scrubber` looks
 * for, under the value's own name: the value as written, at any length, and
 * for a value of six characters or more its `encodeURIComponent` form, that
 * form with a space as `+`, its JSON-escaped body and its base64.
 *
 * Only the list comes from the scrubber. {@link scrubSecretValues} and
 * {@link scrubSecretChunk} replace every form in one pass, longest first
 * across every secret, so a value that holds another one is taken whole in
 * each of its forms - its encoding carries the other value's raw text.
 */
function secretForms(secrets: readonly FlowScriptSecret[]): FlowScriptSecret[] {
  const forms = [...secrets];
  for (const { name, value } of secrets) {
    for (const form of Object.keys(makeSensitiveBank([value]))) {
      if (!forms.some((seen) => seen.value === form)) forms.push({ name, value: form });
    }
  }
  return forms;
}

/**
 * One text of a failed script step with every form of each resolved value
 * replaced by its `{{secret:NAME}}` placeholder.
 *
 * Exported for the one caller that DECODES after the scrub has run:
 * `scriptFrames` reads the already-scrubbed stack and turns each `file://…`
 * frame back into a path. Whatever decodes has to scrub again, and this is
 * that scrub.
 */
export function scrubScriptText(text: string, secrets: readonly FlowScriptSecret[]): string {
  if (secrets.length === 0) return text;
  return scrubSecretValues(text, secretForms(secrets));
}

/**
 * A failure message is clamped by the child, the only side that can bound what
 * crosses the channel, and the child has no secret list — so a value straddling
 * the cut leaves a prefix that a whole-value replacement never matches. That
 * tail is dropped and counted, and only on text whose marker says it was cut.
 *
 * Both are read off the RAW text, before the scrub. Every character of the
 * marker is argent's own - the runner's wording and a number it counted - so a
 * secret whose value occurs in it (a value of `"0"` is enough) must not rewrite
 * it and hide the cut. And the tail is the front of one value, which can hold a
 * shorter secret that a scrub would replace, leaving a front no prefix matches.
 */
function redactTruncated(text: string, secrets: readonly FlowScriptSecret[]): string {
  const forms = secretForms(secrets);
  const omission = OMISSION_RE.exec(text);
  if (!omission) return scrubSecretValues(text, forms);
  const head = text.slice(0, omission.index);
  const partial = partialSecretTail(head, forms);
  const kept = scrubSecretValues(head.slice(0, head.length - partial), forms);
  return `${kept}${omissionMarker(Number(omission[1]) + partial)}`;
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

/**
 * `abort()` through the CRT, the fast-fail path V8 takes instead of it, and
 * Node's own abort, which on Windows exits with 134. That last one is what a
 * heap exhaustion reports there, and `process.abort()` as well.
 */
const WINDOWS_ABORT_CODES = new Set([3, 134, 0xc0000409]);

function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit code ${exit.code ?? 0}`;
}

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
 * file. A script can replace the file with a sibling via `mv`. The replacement
 * then has permissions from the script's own umask, typically 0644.
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

async function removeExchange(exchange: ExchangeFiles, notes: string[]): Promise<void> {
  try {
    await removeTree(exchange.dir);
  } catch (err) {
    notes.push(
      `The script's private directory ${exchange.dir} could not be removed ` +
        `(${errorMessage(err)}); it still holds the document the script wrote. A later bash ` +
        `step sweeps it with the same recursive remove once this step's own time limit has ` +
        `passed, so a cause that call cannot get past - a mode the script changed on the ` +
        `directory itself - needs the directory removed by hand.`
    );
  }
}

/**
 * A recursive remove that leaves the event loop free. What an exchange
 * directory holds is the script's business - a fixture it unpacked, a clone -
 * and 100 000 files there held the tool server's main thread, and with it every
 * request, device socket and flow on the host, for 3.9 s under `rmSync`. An
 * awaited `fs.promises.rm` of the whole tree is no cure: it starts one
 * operation per entry at once, and their completions come back in bursts that
 * the loop runs in one turn - 1.2 s for the same tree. So the tree is walked
 * here a batch of names at a time, with at most {@link EXCHANGE_SWEEP_BATCH}
 * removals in flight: 22 ms at worst. Each entry still goes through
 * `fs.promises.rm`, for its `force` and its Windows handling of a read-only
 * file.
 *
 * A tree can also run deeper than the longest path the system takes - 1 024
 * bytes on macOS - and no call by full path gets past that, `fs.promises.rm`
 * included. So a directory whose path has grown long is moved up under `top`
 * before it is walked, which shortens every path below it.
 */
async function removeTree(target: string, top = target): Promise<void> {
  // Never through a link at the top: `opendir` follows one, and the directory
  // it names is not this tree's - a name the sweep took for an abandoned
  // exchange, or a link a script left where its own directory was. The link
  // itself is removed, as a recursive `rm` removes it. Below the top a
  // directory entry already says whether it is a link.
  if (target === top) {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.lstat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (!stats.isDirectory()) {
      await fs.promises.rm(target, { force: true });
      return;
    }
  }
  const subdirectories: string[] = [];
  let removals: Promise<void>[] = [];
  // Caught where each removal starts rather than where its batch is awaited:
  // one that fails while the next names are still being read is otherwise an
  // unhandled rejection, which Node answers by ending the process.
  let failure: Error | undefined;
  const settle = async () => {
    await Promise.all(removals);
    removals = [];
    if (failure) throw failure;
  };
  let listed = false;
  try {
    const dir = await fs.promises.opendir(target, { bufferSize: EXCHANGE_SWEEP_BATCH });
    listed = true;
    for await (const entry of dir) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) {
        subdirectories.push(child);
      } else {
        removals.push(
          fs.promises.rm(child, { force: true }).catch((err: unknown) => {
            failure ??= err as Error;
          })
        );
      }
      if (removals.length >= EXCHANGE_SWEEP_BATCH) await settle();
    }
  } catch (err) {
    // Gone already, which `force` asks to be quiet about; not a directory; or
    // one this process may not list - which, when empty, `rmdir` removes all
    // the same, since it asks only the parent. The remove below takes each as
    // it is.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && !(code === "EACCES" && !listed)) throw err;
  }
  await settle();
  for (const child of subdirectories) await removeTree(await hoistIfDeep(child, top), top);
  await fs.promises.rm(target, { recursive: true, force: true });
}

/**
 * How long a path {@link removeTree} descends into before it moves the
 * directory up. A name can add 765 bytes - APFS takes 255 characters, of up to
 * three bytes each in UTF-8 - and a path macOS takes is at most 1 023 bytes,
 * so a directory is moved while its own path is short enough for any name
 * below it to fit.
 */
const REMOVE_TREE_HOIST_AT_BYTES = 257;

let hoistedDirectories = 0;

/**
 * `dir`, moved to sit directly under `top` first when its path has grown long.
 * Where the move is refused - moving a directory to another parent needs write
 * permission on the directory itself, which an empty read-only one lacks -
 * `dir` is walked where it is: its own path still fits, and an empty directory
 * needs nothing below it named.
 */
async function hoistIfDeep(dir: string, top: string): Promise<string> {
  if (Buffer.byteLength(dir) <= REMOVE_TREE_HOIST_AT_BYTES) return dir;
  const moved = path.join(top, `.argent-hoisted-${process.pid}-${hoistedDirectories++}`);
  try {
    await fs.promises.rename(dir, moved);
    return moved;
  } catch {
    return dir;
  }
}

let sweptStaleExchangesAt = 0;

let pendingSweep: Promise<void> | undefined;

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
        await removeTree(path.join(root, entry.name));
      } catch {
        // Raced with the step that owns it, or with another server's own sweep.
      }
    }
  } catch {
    // The directory went away, or became unreadable, while it was being read.
  }
}

function exchangeOwnedUntil(entry: string): number | undefined {
  const stamped = /^(\d+)-/.exec(entry.slice(EXCHANGE_DIR_PREFIX.length));
  return stamped ? Number(stamped[1]) : undefined;
}

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

function noteInterpreterLookup(lookupMs: number, timeoutMs: number, notes: string[]): void {
  if (lookupMs < Math.max(INTERPRETER_LOOKUP_NOTE_FLOOR_MS, timeoutMs / 2)) return;
  notes.push(
    `Finding the bash for this step took ${lookupMs} ms, which is outside the step's own ` +
      `${timeoutMs} ms limit: each candidate is run once and asked for its version. Set ` +
      `scripts.bash to the bash you want, and the search stops at it.`
  );
}

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
    // output file is the only reserved name with a different reason, and its
    // name starts with `ARGENT_`, so it was taken by the bucket above.
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
 * replacement never matches. It takes every form of each value that
 * {@link secretForms} lists.
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
    return scrubSecretValues(this.parts.join(""), secretForms(this.secrets()));
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  get heapFatalSeen(): boolean {
    return this.heapFatalFlag;
  }

  get lastStderrLine(): string {
    return this.stderrLastLine;
  }

  /** Whether nothing more may reach the log: it was cut, or its budget is spent. */
  private closed(): boolean {
    if (this.cut) return true;
    const runRemaining = this.runBudget ? this.runBudget.remainingBytes : Number.POSITIVE_INFINITY;
    return Math.min(this.stepRemaining, runRemaining) <= 0;
  }

  get stderrLineSoFar(): string {
    return this.streams.get("stderr")?.lastLine?.peek() ?? this.stderrLastLine;
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
    state.lastLine?.write(text);
    // Past the cut nothing more reaches the log, so there is nothing left to
    // scrub, and a flood past the limit costs no scrub at all.
    if (this.closed()) {
      if (text || state.holdback) this.truncatedFlag = true;
      state.holdback = "";
      state.holdbackAt = undefined;
      return;
    }
    const secrets = secretForms(this.secrets());
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
    const head = scrubSecretValues(released, secretForms(this.secrets()));
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

  peek(): string {
    if (this.blank) return this.last;
    return this.length > this.head.length ? this.cut() : this.head.trim();
  }

  private extend(segment: string): void {
    const room = STDERR_REASON_LINE_CHARS - this.head.length;
    if (room > 0) this.head += segment.slice(0, room);
    this.length += segment.length;
    if (this.blank && /\S/.test(segment)) this.blank = false;
  }

  private close(): void {
    this.last = this.peek();
    this.head = "";
    this.length = 0;
    this.blank = true;
  }

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
  if (!Number.isFinite(ms)) return "unbounded";
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${minutes.toFixed(minutes % 1 === 0 ? 0 : 1)}m`;
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${ms}ms`;
}
