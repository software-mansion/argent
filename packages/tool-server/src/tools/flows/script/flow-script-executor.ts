/**
 * Runs one trusted local JavaScript file in one fresh Node.js child process and
 * returns a structured outcome.
 *
 * **Trust.** A script has the same trust level as a local npm script: it can
 * read and write host files, make network requests, start processes, load
 * installed and native packages, and stop its own process. The child process is
 * a *reliability* boundary, not a security one. What it buys is that a
 * synchronous infinite loop, a heap exhaustion, or a `process.exit` cannot take
 * down the tool server — which matters, because a wedged tool server makes the
 * MCP client respawn it and rotate its auth token.
 *
 * Nothing in this file is reachable from a tool yet. It takes the output
 * document, the environment map, the working directory and the time limit as
 * parameters and does not know where any of them came from.
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
  type ConfigDefinition,
} from "@argent/configuration-core";
import { isElectronHostedEnv } from "../../../utils/electron-env";
import { formatErrorForAgent } from "../../../utils/format-error";
import { scrubSecretValues } from "../../../utils/secrets";
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

// ── Bounds ────────────────────────────────────────────────────────────────

/** Time limit for a step that does not ask for one. */
const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
/** Captured log kept for one step. */
export const SCRIPT_STEP_LOG_LIMIT_BYTES = 64 * 1024;
/** Captured log kept for one flow run, across every script step in it. */
const SCRIPT_RUN_LOG_LIMIT_BYTES = 256 * 1024;
/** How long the outcome waits for the log streams once it is otherwise known. */
const SETTLE_TIMEOUT_MS = 500;
/** Grace between asking a process tree to stop and forcing it. */
const STOP_GRACE_MS = 1_500;
/**
 * How far behind the parent's timer the child's own deadline watchdog sits.
 *
 * The watchdog is the second line, for a parent that cannot act — one that is
 * gone, or whose event loop is blocked. Given the same number as the parent's
 * timer, its only margin was the child's boot time, about thirty milliseconds:
 * one synchronous `execFileSync` on the tool server's loop across the moment
 * the limit expired was enough for the child to SIGKILL its own group first, so
 * the parent's timer never ran and a timed-out step was reported as an
 * unexplained signal — the wrong line of code entirely, and a different
 * `failure.kind`. The tool server does make such calls (`stop-metro` shells out
 * to `lsof` and `netstat`), so the margin has to be an ordinary stall wide.
 */
const CHILD_DEADLINE_MARGIN_MS = 2_000;
/** How often the stop path re-checks whether a process group has emptied. */
const GROUP_POLL_MS = 50;
/** How long a forced stop waits for the kernel to finish tearing the tree down. */
const FORCE_GRACE_MS = 500;
/** Steps allowed to queue for a slot before a step is refused outright. */
const QUEUE_DEPTH_LIMIT = 32;
/** A queue wait longer than this is worth telling the caller about. */
const QUEUE_WAIT_REPORT_MS = 5_000;
/** A partial stderr line longer than this is passed through unclassified. */
const MAX_BUFFERED_LINE_CHARS = 8 * 1024;
/**
 * V8's heap-exhaustion banner, matched on the live stream. Deliberately coarse:
 * it must not depend on the frame layout, the address format or the surrounding
 * wording, none of which is a stability contract, and it must hold on both
 * Node 20.12 and current. An unrecognized abort degrades to the signal report
 * rather than to a wrong verdict.
 */
const V8_HEAP_FATAL_RE = /FATAL ERROR:[^\n]*(?:heap limit|heap out of memory|Allocation failed)/i;
/** Enough of the stream to hold a banner split across two pipe chunks. */
const HEAP_FATAL_WINDOW_CHARS = 256;

const RUNNER_FILE = "flow-script-runner.mjs";

/** Marks the one process the runner preload may activate in. See `buildChildEnv`. */
const RUNNER_ACTIVATION_ENV = "ARGENT_FLOW_SCRIPT_RUNNER";

/**
 * Environment names copied from the tool server into a script process.
 *
 * The list is an allowlist rather than a denylist because the thing it must
 * keep out — the tool-server bearer token, the tool-server port, every
 * `ARGENT_SECRET_*` value — is exactly the set that grows without this file
 * being touched. It is leak hygiene, not containment: a script has file system
 * access, so one that *wants* the token can read `~/.argent/tool-server.json`.
 * What it stops is the accident — a script that prints `process.env` while
 * debugging, forwards its environment to a subprocess, or posts a crash report
 * with the environment attached.
 */
const ALLOWED_ENV_NAMES: readonly string[] = [
  // Shell basics.
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
  // Temp.
  "TMPDIR",
  "TEMP",
  "TMP",
  // Windows. `SystemRoot` is required for DNS and crypto there — a script that
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
  // Network and TLS. `NODE_EXTRA_CA_CERTS` covers the script's own process; the
  // two `SSL_CERT_*` names cover a subprocess such as `curl` or `git`.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Node toolchain. The version-manager names matter because a host using fnm,
  // asdf, mise or volta would otherwise run against a different Node than the
  // developer's shell, or against none at all.
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
  // Mobile toolchain.
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_AVD_HOME",
  "ANDROID_USER_HOME",
  "JAVA_HOME",
  "GRADLE_USER_HOME",
  "DEVELOPER_DIR",
  // Other.
  "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "CI",
];

/** Every `npm_config_*` name is copied, so a project's npm settings survive. */
const ALLOWED_ENV_PREFIXES: readonly string[] = ["npm_config_"];

/**
 * Names refused in a caller-supplied environment map. Each one breaks the
 * runner rather than the host: `NODE_CHANNEL_FD` and `NODE_UNIQUE_ID` steer the
 * IPC channel this protocol runs on, `NODE_OPTIONS` would silently override the
 * heap limit set through `execArgv`, `ELECTRON_RUN_AS_NODE` decides whether the
 * child boots as Node at all, and the runner activation flag decides which
 * process the runner preload takes over. This is a reliability rule, not a
 * security one.
 */
const RESERVED_ENV_NAMES: readonly string[] = [
  "NODE_CHANNEL_FD",
  "NODE_UNIQUE_ID",
  "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  RUNNER_ACTIVATION_ENV,
];

// ── Public shapes ─────────────────────────────────────────────────────────

/** A resolved secret whose value must never reach a report. */
export interface FlowScriptSecret {
  name: string;
  value: string;
}

/**
 * The log allowance shared by every script step in one flow run. Callers create
 * one per run with {@link createScriptLogBudget} and pass the same object to
 * each step, so a chatty first step cannot be paid for twice.
 */
export interface FlowScriptLogBudget {
  remainingBytes: number;
}

/** A fresh run-scoped log allowance. */
export function createScriptLogBudget(): FlowScriptLogBudget {
  return { remainingBytes: SCRIPT_RUN_LOG_LIMIT_BYTES };
}

export interface FlowScriptRequest {
  /** The script file. Resolved against the working directory when relative. */
  scriptPath: string;
  /** The flow output handed to the script as its `output` global. */
  output?: Record<string, unknown>;
  /** Environment values layered on top of the allowlist. */
  env?: Record<string, string>;
  /** Per-step time limit. Defaults to 30s, clamped to the configured maximum. */
  timeoutMs?: number;
  /** The caller's `project_root` — first choice for the working directory. */
  projectRoot?: string;
  /** Directory of the flow file naming the step — the working-directory fallback. */
  flowDir?: string;
  /**
   * Values to redact from captured logs. Run-scoped and read live on every
   * chunk, so a set that grows as the run resolves more secrets is respected
   * mid-step.
   */
  secrets?: readonly FlowScriptSecret[];
  /** The run's shared log allowance. Omitted ⇒ only the per-step limit applies. */
  logBudget?: FlowScriptLogBudget;
  /** Cancels the step; a queued step gives up its position at once. */
  signal?: AbortSignal;
  /** Test seam: the directory holding the runner and watchdog `.mjs` files. */
  runnerDir?: string;
}

/** Why a script step did not produce output. */
export type FlowScriptFailureKind =
  /** The module never evaluated — missing file, bad syntax, a refused import. */
  | "load"
  /** The script's own code threw. */
  | "runtime"
  /** The value in `output` cannot cross into flow state. */
  | "output"
  /** The runner misbehaved, or never reached the script. */
  | "protocol"
  /** The step ran past its time limit and was stopped. */
  | "timeout"
  /** The run was cancelled. */
  | "cancelled"
  /** The script stopped its own process, or reported failure through its exit code. */
  | "exit"
  /** The process was killed by a signal it did not choose. */
  | "signal"
  /** The process exhausted its heap limit. */
  | "heap"
  /** The child could not be started at all. */
  | "spawn"
  /** The step never got a concurrency slot. */
  | "queue"
  /** The request itself was not usable. */
  | "invalid";

export interface FlowScriptFailure {
  kind: FlowScriptFailureKind;
  message: string;
  stack?: string;
}

export interface FlowScriptResult {
  /** True only when the script returned a valid output document. */
  ok: boolean;
  /** The validated output document. Present exactly when `ok`. */
  output?: Record<string, unknown>;
  /** Why the step failed. Present exactly when not `ok`. */
  failure?: FlowScriptFailure;
  /** stdout and stderr in written order, redacted and possibly truncated. */
  log: string;
  /** True when a log limit dropped some of the script's output. */
  logTruncated: boolean;
  /** Wall clock from spawn to outcome. Excludes the queue wait. */
  durationMs: number;
  /** Wall clock spent waiting for a free concurrency slot. */
  queuedMs: number;
  /** Things worth telling the caller that are not failures. */
  notes: string[];
}

export interface FlowScriptExecutorOptions {
  /**
   * How many script processes run at once. Defaults to a CPU-derived limit;
   * there is no configuration key, because the bound protects the host and the
   * CPU count is what determines it.
   */
  concurrency?: number;
  /** Overrides `scripts.maxTimeoutMs`. */
  maxTimeoutMs?: number;
  /** Overrides `scripts.heapLimitMb`. */
  heapLimitMb?: number;
  /**
   * How long a step may wait for a concurrency slot before it is refused.
   * Defaults to twice the maximum script time limit — generous enough that only
   * a host already in trouble reaches it.
   */
  queueWaitMs?: number;
}

// ── Executor ──────────────────────────────────────────────────────────────

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

/**
 * A cancellation raised out of the queue, before any process exists. Separate
 * from a queue refusal so the caller can tell "you stopped it" from "the host
 * was full".
 */
class ScriptCancelledError extends Error {}

/** A request that cannot be turned into a spawn. Carries its own verdict kind. */
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
  private bounds: ResolvedBounds | undefined;

  constructor(private readonly options: FlowScriptExecutorOptions = {}) {}

  /**
   * The three host bounds, read once per executor.
   *
   * Two of them are configuration — `scripts.maxTimeoutMs` and
   * `scripts.heapLimitMb` — and both are global-scope only: a project scope
   * would let a checked-in `.argent/config.json`, a file an agent writes, raise
   * the ceiling on how much of the developer's machine any flow in that
   * repository may occupy. The third, the concurrency limit, has no key at all;
   * it is derived from the CPU count, because the CPU count is what decides it.
   * Reading once rather than per step keeps a script step off the filesystem
   * for a value that only changes with a server restart.
   */
  private resolveBounds(): ResolvedBounds {
    if (!this.bounds) {
      this.bounds = {
        // `positive` rather than `??`: `concurrency: 0` is not nullish, so it
        // reached the executor intact and every step then queued until the wait
        // bound refused it.
        concurrency: positive(this.options.concurrency) ?? defaultConcurrency(),
        // Capped at the largest delay `setTimeout` can hold: past that Node
        // clamps the timer to 1ms, so a maximum of a few weeks made every
        // script "time out" immediately.
        maxTimeoutMs: Math.min(
          MAX_TIMER_MS,
          positive(this.options.maxTimeoutMs) ??
            configuredNumber("scripts.maxTimeoutMs") ??
            5 * 60_000
        ),
        // Floored, not just defaulted: a heap too small to start V8 makes every
        // step fail during the child's own startup, with a message that names
        // neither this bound nor the value that caused it.
        heapLimitMb: Math.max(
          MIN_SCRIPT_HEAP_LIMIT_MB,
          positive(this.options.heapLimitMb) ?? configuredNumber("scripts.heapLimitMb") ?? 512
        ),
      };
    }
    return this.bounds;
  }

  /** Steps currently holding a slot. Exposed for tests and diagnostics. */
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

  // ── Concurrency ─────────────────────────────────────────────────────────
  //
  // One tool server serves every local agent and every project, so two runs can
  // each reach a script step. The limit protects the HOST, not the throughput
  // of one script: a typical script waits on a network call, but a script *can*
  // spin a core, and eight spinning runners on a four-core laptop is what stops
  // the tool server, the device servers, and every other agent on the machine.
  //
  // Both bounds below exist because `flow-execute` is long-running and nothing
  // else aborts the call. They are deliberately generous — they stop an
  // unbounded queue rather than shape normal use.

  private acquireSlot(signal: AbortSignal | undefined, waitBoundMs: number): Promise<() => void> {
    // Idempotent: a slot released twice would leave `running` below the number
    // of live processes and quietly raise the effective limit for the rest of
    // the tool server's life.
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
    if (this.running < this.resolveBounds().concurrency) {
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
    const limit = this.resolveBounds().concurrency;
    while (this.running < limit) {
      const waiter = this.waiting.shift();
      if (!waiter) return;
      if (waiter.settled) continue;
      this.running += 1;
      waiter.grant();
    }
  }

  // ── One run ─────────────────────────────────────────────────────────────

  private async runOne(
    request: FlowScriptRequest,
    bounds: ResolvedBounds
  ): Promise<FlowScriptResult> {
    const notes: string[] = [];
    const startedAt = Date.now();
    // An abort raised between the queue's check and this one — `const p =
    // execute(…); if (bad) controller.abort();` is an ordinary synchronous
    // cancellation — lands in the gap that the promise the queue returns opens
    // up. Nothing spawns for it.
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
      // Before the fork, and inside this guard: a cyclic or BigInt document
      // makes `JSON.stringify` throw, and doing it after the fork made
      // `execute` reject with a raw TypeError — no `FlowScriptResult` for the
      // caller, and a child left running until the time limit reaped it. Every
      // other unusable request is a verdict.
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
    // through `realpath`, and the runner re-imports that URL to tell a finished
    // script from one parked inside a top-level `await`. A different spelling of
    // the same file would be a second module, and the script would run twice.
    const scriptPath = realPathOrSelf(path.resolve(cwd, request.scriptPath));

    let child: ChildProcess;
    try {
      // `windowsHide` is a documented `fork` option that this @types/node
      // release does not carry on ForkOptions; widen rather than drop it.
      const forkOptions: ForkOptions & { windowsHide?: boolean } = {
        cwd,
        env,
        // Set, never appended to. `fork` defaults `execArgv` to the parent's, so
        // appending would carry a dev-mode parent's ts-node/vitest loaders — and
        // any stack-size or inspector flag it was started with — into every
        // script process.
        //
        // The runner rides in as a preload rather than as the entry module, so
        // the *script* is what Node runs: `import.meta.main`, `process.argv[1]`
        // and `require.main` then all name the script, and the ordinary
        // "am I the main module?" guard runs its body instead of being skipped.
        // Node awaits an `--import` module before it loads the entry, which is
        // what leaves room for the runner's handshake.
        execArgv: [
          `--max-old-space-size=${bounds.heapLimitMb}`,
          "--import",
          pathToFileURL(runnerPath).href,
        ],
        // Index 4 is the lifeline: a pipe the parent holds open and never uses.
        // Its closing is how a runner learns its parent is gone.
        stdio: ["ignore", "pipe", "pipe", "ipc", "pipe"],
        // On POSIX the runner leads its own process group so a group stop aimed
        // at the tool server does not also stop it — and so a group stop aimed
        // at the runner reaches its descendants. Windows has no process group
        // for this purpose; `taskkill /T` covers the tree there instead.
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

    // The lifeline end holds a reference on the tool server's event loop, so one
    // script step would otherwise keep the server alive past its idle shutdown.
    // Never read from or write to it: on POSIX it is one end of a socketpair,
    // and Node exposes it as a readable *and* writable Socket.
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
    /** See {@link interrupt}. Closes the window in which a verdict still counts. */
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
    // `close` fires once every stdio stream AND the IPC channel have closed, so
    // it is the point at which no further message or log byte can arrive.
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    // The one cleanup path, whatever ended the step. A script's descendants
    // outlive it — they are reparented to init, not stopped — so a step that
    // returned normally has to reap them too, not only one that was interrupted.
    let stopped: Promise<void> | undefined;
    const stop = () => (stopped ??= stopProcessTree(child, STOP_GRACE_MS));

    /**
     * Record why the step is being stopped, and start stopping it.
     *
     * `??=` because the first interruption is the true one: a script that
     * survives SIGTERM long enough for its deadline to pass during the stop
     * grace was cancelled, not timed out.
     *
     * The seal is what keeps a stop from being reported as a pass. A verdict
     * the script produced *before* the stop still outranks the interruption —
     * that message was already on the channel and Node simply delivered it late
     * — but SIGTERM is a normal shutdown request, and a script with the
     * ordinary handler for it releases what was holding its event loop, empties
     * the loop, and lets the runner report a half-written document as a result.
     * The stop is what produced that verdict, so it is not one.
     *
     * The seal is armed *and the stop is sent* from the same check-phase
     * callback, in that order, so no wall-clock reasoning is involved: a
     * message the child produced in answer to the SIGTERM cannot exist before
     * the SIGTERM, and the SIGTERM cannot be sent before the seal. Sealing from
     * a later turn than the kill was what left a window — one turn is enough
     * grace for an in-flight message only while nothing delays the parent, and
     * the child answers a SIGTERM in about a millisecond, so a tool server
     * whose own loop was blocked across that moment (`stop-metro` shells out to
     * `lsof` and `netstat`; see `CHILD_DEADLINE_MARGIN_MS`) took the stop's
     * verdict for the script's and reported a stopped step as a pass.
     *
     * A message already readable on the channel keeps its grace: it is
     * delivered in this same iteration's poll phase, ahead of this check-phase
     * callback. Delaying the kill by that one turn costs nothing — a parent
     * that could not act sooner is exactly what the child's own deadline
     * watchdog is the second line for.
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
      // A second terminal response is ignored rather than obeyed: the run
      // already has its verdict, and a runner that keeps talking after it has
      // finished is running arbitrary code that is no longer following the
      // protocol.
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
      // A verdict the stop had time to produce is the stop's, not the script's.
      // See `interrupt`.
      if (interruptionSealed) return;
      terminal = message;
    });

    const timer = setTimeout(() => interrupt("timeout"), timeoutMs);
    const onAbort = () => interrupt("cancelled");
    request.signal?.addEventListener("abort", onAbort, { once: true });
    // `addEventListener` never fires for a signal that aborted before it was
    // attached, and nothing else re-reads the flag.
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
        // A send that fails means the channel died before the script could be
        // named. The child cannot do anything useful without the request, so
        // stop it rather than wait out its time limit.
        protocolProblem ??= `The script runner closed its channel before the request arrived: ${errorMessage(err)}`;
        void stop();
      });
    } catch (err) {
      protocolProblem ??= `The script runner could not be given its request: ${errorMessage(err)}`;
      void stop();
    }

    const exit = await exited;
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);

    // End the step only when the outcome is known AND both log streams have
    // closed. The protocol runs on IPC and the logs run on the standard
    // streams, and the two have no shared order: a terminal message routinely
    // arrives *before* the log text of the same script. The bound covers a
    // descendant that inherited the streams and is holding them open — stopping
    // the process group first closes them in the normal case.
    await Promise.race([closed, sleep(SETTLE_TIMEOUT_MS)]);
    // Idempotent, and on a passing step this is the only cleanup there is: the
    // runner has exited, and on POSIX anything it started that is still running
    // is reaped here rather than left behind holding a port or a database
    // connection — the process group outlives the runner, so the group stop
    // still reaches it. A descendant that deliberately left the group —
    // `detached` — is out of reach on purpose, which is how a script starts
    // something meant to outlive it. Windows has no such group and `taskkill`
    // has nothing to walk from once the child is gone, so a descendant of a
    // normally-returning step survives there; `stopProcessTree` records it.
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

/** The tool server's one executor — the concurrency limit is per server. */
export function flowScriptExecutor(): FlowScriptExecutor {
  shared ??= new FlowScriptExecutor();
  return shared;
}

// ── Verdict ───────────────────────────────────────────────────────────────

interface ClassifyInput {
  exit: { code: number | null; signal: NodeJS.Signals | null };
  spawnProblem: string | null;
  protocolProblem: string | null;
  terminal: ScriptTerminalResponse | null;
  startedSeen: boolean;
  interrupted: "timeout" | "cancelled" | null;
  timeoutMs: number;
  heapFatalSeen: boolean;
  heapLimitMb: number;
}

/**
 * The exit is read *together with* the messages received, never alone.
 *
 * The signal row is the one that matters: a process killed by a signal did not
 * choose to stop, and reporting it as self-termination sends the author to the
 * wrong line of code. Nothing here asks anything of a process that is already
 * leaving — an exit handler in the runner would not be a reliable send point,
 * because `process.send` is not guaranteed to complete during process exit.
 */
function classifyOutcome(
  input: ClassifyInput
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  const { exit } = input;
  if (input.spawnProblem) return failed("spawn", input.spawnProblem);
  if (input.protocolProblem) return failed("protocol", input.protocolProblem);

  // A verdict the script actually produced outranks an interruption that landed
  // after it — for a cancel exactly as for a timeout, which was already ordered
  // this way. The two are the same narrow race, and the answer to both is that
  // the work was finished before the stop arrived. Only a verdict that reached
  // the parent before the stop had a turn to take effect is recorded as one;
  // `interrupt` in `runOne` is where that line is drawn.
  if (input.terminal) {
    if (input.terminal.type === "failure") {
      // The child bounds both fields before sending; this is the same second
      // line the output size gets, for a child that stopped being compliant.
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

  if (input.interrupted === "timeout") {
    return failed(
      "timeout",
      `The script did not finish within its ${describeDuration(input.timeoutMs)} time limit ` +
        `and its process tree was stopped.`
    );
  }

  // V8 does not throw when it hits the heap limit: it prints a fatal error and
  // aborts. Without this row the plain classification below says "the script
  // stopped its own process", which it did not. Ahead of the row below because
  // a script can exhaust the heap while it is still loading its imports, and
  // "the runner never started the script" is then the wrong thing to say about
  // a process that ran out of memory.
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
 * Every field of a verdict carries the same redaction the log does.
 *
 * None of this text is the executor's. A `runtime` failure is the script's own
 * error message and stack, and a script that resolves a secret puts it there
 * without ever writing it into a string itself — `assert.equal(returned,
 * process.env.TOK)` quotes both values, and so does a template literal in a
 * throw. The output document is the same shape one step further on: an API
 * commonly echoes the credential it was given back in its response, and
 * `output.session = await res.json()` stores it. A report that redacts the log
 * beside either one reads as safe while carrying the plaintext — and in a flow
 * the document outlives the report, because later steps read it.
 */
function redactSecrets(
  verdict: Pick<FlowScriptResult, "ok" | "output" | "failure">,
  secrets: readonly FlowScriptSecret[]
): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  if (secrets.length === 0) return verdict;
  if (verdict.output) scrubDocument(verdict.output, secrets);
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
 * Scrub every string in a parsed output document, keys included.
 *
 * In place, because the document was just parsed here and nothing else holds
 * it. Iterative rather than recursive: the value came from a child that ran
 * arbitrary code, and a megabyte of `[[[[…` is a legal document that would
 * overflow the stack — inside `execute`, which owes its caller a verdict rather
 * than a throw.
 */
function scrubDocument(root: Record<string, unknown>, secrets: readonly FlowScriptSecret[]): void {
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
      // A secret can be the key as easily as the value — `output[apiKey] = …`
      // is how a script indexes a per-credential result.
      const scrubbedKey = scrubSecretValues(key, secrets);
      if (scrubbedKey !== key) {
        record[scrubbedKey] = record[key];
        delete record[key];
      }
    }
  }
}

function commitOutput(outputJson: string): Pick<FlowScriptResult, "ok" | "output" | "failure"> {
  // A second line only — a compliant child already enforced this. It exists
  // because the parent must not depend on a child staying compliant after
  // arbitrary script code has run inside it.
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
  return { ok: true, output: parsed as Record<string, unknown> };
}

/**
 * Scrub a field the ceiling may already have cut, including across the cut.
 *
 * The same truncation boundary the log capture scrubs ahead of, arriving from
 * the other side. A failure message is clamped by the child — the only side
 * that can bound what crosses the channel — and the child has no secret list,
 * so a value straddling the cut leaves its prefix in the kept text, where a
 * whole-value replacement matches nothing. Sixteen characters of a
 * thirty-three character key survived that way, from the shape the runner's own
 * comment names: `throw new Error(\`Unexpected response: \${await res.text()}\`)`
 * where the body echoes the credential.
 *
 * A tail that could still grow into a secret is dropped and counted, and only
 * on text that says it was cut — the marker is what makes the extra characters
 * honest rather than silent.
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

/** The tail {@link clampText} leaves behind, read back by {@link redactTruncated}. */
const OMISSION_RE = /… \[(\d+) more characters omitted]$/;

/** The same tail, written. The runner carries its own copy of both. */
function omissionMarker(omitted: number): string {
  return `… [${omitted} more characters omitted]`;
}

/**
 * Cut child-controlled text to a ceiling, saying how much was left out.
 *
 * The marker counts against the ceiling, exactly as it does in the runner's
 * copy of this function: a result longer than the ceiling would be cut again by
 * whatever applies the same number next, and that second cut can only report
 * how much *it* dropped — which is the marker, not the text the marker speaks
 * for.
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
  // A signal, never an exit code. 128+SIGABRT is a *shell's* way of reporting
  // an aborted child, and there is no shell between the executor and the
  // runner — but there often is one inside the script. A wrapper that runs a
  // build through `sh` and forwards its status returns 134 while allocating
  // nothing itself, and the build's own banner lands in the inherited stream,
  // so reading it as this process aborting asserted something false about the
  // wrong process and named the wrong limit.
  return exit.signal === "SIGABRT" && heapFatalSeen;
}

function describeExit(exit: { code: number | null; signal: NodeJS.Signals | null }): string {
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit code ${exit.code ?? 0}`;
}

// ── Setup ─────────────────────────────────────────────────────────────────

/**
 * The working directory is always set explicitly, to the first candidate that
 * exists on the server.
 *
 * The existence check is load-bearing: `project_root` names the *calling
 * agent's* working directory and can be a path that is mistyped or has since
 * moved. Without it the child spawns into a directory that does not exist and
 * fails with a bare `ENOENT` naming a path the script author never wrote.
 *
 * The tool server's own working directory is never inherited. That value is not
 * a project path — an editor sets it when it spawns the server, and it can be
 * `/` or `$HOME`, which would make a relative `fs` path in a script resolve
 * against the filesystem root.
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
      // Every rejected candidate is named, not just a missing project_root: a
      // fallback that happens silently is how a wrong input keeps working until
      // it does not.
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

/**
 * Why a candidate cannot be the working directory, or `null` when it can.
 *
 * The absolute-path rule is the load-bearing one, and it is the same rule
 * `assertValidProjectRoot` in `flow-utils.ts` applies to every other flow path.
 * A relative candidate is resolved by the OS against the *tool server's* own
 * working directory — the one value this function exists to keep out, because
 * an editor sets it when it spawns the server and it can be `/` or `$HOME`. A
 * relative root that happens to exist also beat a perfectly good absolute
 * fallback, defeating this machinery exactly when the input was wrong.
 */
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

/** Encode the caller's output document, as a verdict rather than a throw. */
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
 * The real path of a file, or the path itself when it cannot be resolved —
 * a missing script is Node's error to report, with the name the author wrote.
 */
function realPathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

/**
 * The three layouts the runner can be in — the published bundle (beside
 * `tool-server.cjs` in `dist`), the compiled package (beside the compiled
 * executor) and the workspace source (beside this file) — are all
 * `path.join(__dirname, name)`. The tool-server package is CommonJS, so
 * `__dirname` is available here and under vitest; this mirrors how
 * `preview-window.ts` finds its bundled main script.
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

/**
 * The child environment, built from the allowlist rather than from the tool
 * server's own environment.
 */
function buildChildEnv(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  // Windows environment names are case-insensitive, so a host may surface any
  // of these under non-canonical casing; POSIX names are exact.
  const caseInsensitive = process.platform === "win32";
  const allowed = new Set(
    ALLOWED_ENV_NAMES.map((name) => (caseInsensitive ? name.toLowerCase() : name))
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const key = caseInsensitive ? name.toLowerCase() : name;
    if (allowed.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[name] = value;
    }
  }

  // `process.execPath` is normally the Node binary, but an Electron-based MCP
  // host makes it the Electron binary — and such a host puts
  // ELECTRON_RUN_AS_NODE in our own environment, which is the only reason a
  // plain `fork` from it boots as Node today. The allowlist does not carry the
  // name, so it has to be put back deliberately.
  //
  // The read is case-insensitive for the same reason the strip in
  // `electron-env.ts` is, and is the same predicate: a Windows host may surface
  // `Electron_Run_As_Node`, and a case-sensitive read here would say the server
  // is not Electron-hosted when it is — booting a GUI Electron process for
  // every script step.
  if (isElectronHostedEnv()) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }

  for (const [name, value] of Object.entries(overrides ?? {})) {
    const reserved = RESERVED_ENV_NAMES.find((candidate) =>
      caseInsensitive ? candidate.toLowerCase() === name.toLowerCase() : candidate === name
    );
    if (reserved) {
      throw new ScriptSetupError(
        "invalid",
        `${name} cannot be set for a script: it steers the runner's own process ` +
          `(reserved names: ${RESERVED_ENV_NAMES.join(", ")}).`
      );
    }
    env[name] = value;
  }

  // Set last, so a caller cannot shadow it. The runner preload activates only
  // when it sees this, and clears it before the script runs: `--import` is
  // inherited by a worker thread the script starts and by a `child_process`
  // `fork` from the script, and an activated preload in either would wait for a
  // request that is never sent. A child's environment is copied at spawn time,
  // so clearing it in this process is what keeps it out of theirs.
  env[RUNNER_ACTIVATION_ENV] = "1";
  return env;
}

function clampTimeout(
  requested: number | undefined,
  maxTimeoutMs: number,
  notes: string[]
): number {
  // A step that asked for nothing gets the default, quietly bounded by the
  // host maximum. The note below is for a caller that asked for more than the
  // host allows, and a host that deliberately tightened the ceiling below the
  // default was getting it on every step.
  const wanted = positive(requested);
  if (wanted === undefined) return Math.min(DEFAULT_SCRIPT_TIMEOUT_MS, maxTimeoutMs);
  if (wanted <= maxTimeoutMs) return wanted;
  notes.push(
    `The requested ${describeDuration(wanted)} time limit is above this host's maximum of ` +
      `${describeDuration(maxTimeoutMs)}; the step ran with the maximum.`
  );
  return maxTimeoutMs;
}

/**
 * Derived from the CPU count because the failure it prevents is a CPU one. The
 * floor of 2 keeps a two-core CI box from serializing every script step.
 */
function defaultConcurrency(): number {
  const cpus = os.cpus()?.length || 1;
  return Math.max(2, Math.min(8, cpus - 2));
}

/** The largest delay `setTimeout` holds; past it Node clamps the timer to 1ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** A caller-supplied bound, or `undefined` when it is not a usable one. */
function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function configuredNumber(key: string): number | undefined {
  const def = getConfigDefinition(key) as ConfigDefinition<number> | undefined;
  if (!def) return undefined;
  const value = getConfigValue(def);
  return typeof value === "number" && value > 0 ? value : undefined;
}

// ── Stopping a process tree ───────────────────────────────────────────────

/**
 * Request normal termination, wait a short grace, then force.
 *
 * A trusted script may start descendants, and a step should not leave them
 * running. The two platform mechanisms differ in reach, and the difference is
 * worth being exact about rather than promising the same thing on both:
 *
 * - **POSIX** names the runner's process group, which every descendant that
 *   did not deliberately leave it is still in. That is the one this waits on:
 *   an empty group is the proof that the tree is gone.
 * - **Windows** has no such group, so `taskkill /T` walks the live
 *   parent-child tree instead — a grandchild whose own parent already exited
 *   has been re-parented and escapes it, and once the child itself is gone
 *   there is nothing left to walk from. It runs while the child is still
 *   alive, which is the only moment it can reach anything. On the clean path
 *   the child has already exited by the time this runs, so a descendant of a
 *   normally-returning step survives there; only an interrupted step reaches
 *   the tree. POSIX has no such gap — the group outlives the runner.
 *
 * A deliberately detached descendant is out of reach on either, which is how a
 * script starts something meant to outlive its step.
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
      // A `spawn` that cannot launch reports it asynchronously, through an
      // `error` event and not through a throw the `tryKill` above could catch.
      // With no listener that event is unhandled, and an unhandled `error`
      // ends the tool server — from the one stop path Windows has, on every
      // timed-out or cancelled step, over exactly the conditions that make a
      // step time out in the first place: a `taskkill.exe` the inherited
      // `PATH` cannot resolve, or a saturated host answering `EAGAIN`.
      // `child.kill()` below is already the fallback for a `taskkill` that
      // could not run, so there is nothing further to do here.
      killer.on("error", () => {});
      killer.unref();
    });
    await waitForGroupToEmpty(child, pid, graceMs);
    if (!hasExited(child)) tryKill(() => child.kill());
    return;
  }

  if (!groupHasMembers(pid)) return;
  killGroup(child, pid, "SIGTERM");
  // What has to be gone is the *group*, not the runner. The runner installs no
  // SIGTERM handler and dies in milliseconds, so waiting on it alone reported
  // success while a descendant that ignores SIGTERM — or is simply slower — was
  // still running, and the escalation below never happened.
  await waitForGroupToEmpty(child, pid, graceMs);
  if (!groupHasMembers(pid)) return;
  killGroup(child, pid, "SIGKILL");
  // A SIGKILL is delivered at once but the kernel still has to tear the process
  // down, so the step would otherwise return a moment before the tree is
  // actually gone — which is the difference between "we asked" and "they are
  // stopped", and the latter is what the verdict claims.
  await waitForGroupToEmpty(child, pid, FORCE_GRACE_MS);
}

/** Poll until nothing is left in the runner's process group, or the grace runs out. */
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
 * Whether anything is still running in the process group the runner leads.
 *
 * Signal 0 checks reachability without delivering anything. `ESRCH` is the only
 * answer that means "nothing there": `EPERM` means the group exists and this
 * process may not signal it, which still has to count as alive.
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
    // The negative pid names the process group the runner leads because it was
    // forked `detached`.
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // No group — the fork fell back to the parent's, or the tree is already
      // gone. Aim at the process itself rather than at the tool server's group.
      tryKill(() => child.kill(signal));
    }
  }
}

function tryKill(action: () => void): void {
  try {
    action();
  } catch {
    // A process that is already gone is the outcome we wanted.
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

// ── Log capture ───────────────────────────────────────────────────────────

interface StreamState {
  decoder: StringDecoder;
  holdback: string;
  /** The place in the shared buffer the hold-back belongs in. See `release`. */
  holdbackAt?: number;
  collapser?: V8FrameCollapser;
  /** Only stderr carries V8's fatal banner. */
  watchForHeapFatal?: boolean;
}

/**
 * stdout and stderr, captured into one buffer in arrival order.
 *
 * Only the two standard streams are captured, and console text deliberately
 * does *not* also travel over IPC. `console.log`/`console.info` already write
 * to stdout and `console.warn`/`console.error` to stderr, and any subprocess
 * the script starts writes to the same two descriptors, so one channel captures
 * everything in written order. Two channels would interleave unpredictably, and
 * an IPC message is serialized whole before sending — so one large
 * `console.log` would be built in full before any limit could apply, where pipe
 * data arrives in chunks and can be limited while draining.
 *
 * The cost is that a report shows the stream rather than the four console
 * levels. That matches what a developer sees running the script by hand.
 *
 * Order is arrival order, and it is faithful to written order for anything the
 * script writes in separate turns of its event loop. What it cannot reproduce
 * is a burst written to *both* streams inside one turn: those arrive as two
 * `data` events, one per pipe, and nothing in the bytes says which write came
 * first. Merging the two descriptors in the child would need `dup2`, which
 * Node does not expose. Nothing else here is allowed to add reordering on top
 * of that — see the hold-back and the frame collapser below.
 *
 * Redaction runs on the live stream, ahead of both limits, because each
 * boundary leaks a secret into a report if it runs last:
 *
 * - **Chunk boundary.** A secret value can straddle two pipe chunks and a
 *   per-chunk replacement sees neither half. The tail of each chunk is held
 *   back and prepended to the next.
 * - **Truncation boundary.** The cap keeps the earliest bytes, so a value
 *   straddling the cut would leave its prefix in the kept text — and a
 *   whole-value replacement matches no prefix, so it would reach the report
 *   intact.
 */
class ScriptLogCapture {
  private readonly parts: string[] = [];
  private readonly streams = new Map<string, StreamState>();
  private stepRemaining: number;
  private truncatedFlag = false;
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
   * Never pauses the stream. A paused stream fills the pipe buffer, blocks the
   * child, and stops the child from ever reaching its own time limit — so past
   * the limit the data is still drained and simply discarded.
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

  /**
   * A last pass with the secret set as it stands at the end of the step.
   *
   * The streaming scrub can only match what it can see: a value straddling a
   * chunk boundary is held back against the secrets known *at that chunk*, so a
   * value whose head was released before the run resolved it — the set grows as
   * a run resolves more secrets — has its two halves rejoined here in
   * plaintext. Streaming stays first, because it is what protects the
   * truncation boundary: a value split by the cut leaves a prefix that matches
   * nothing.
   */
  get text(): string {
    return scrubSecretValues(this.parts.join(""), this.secrets());
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  /**
   * Whether V8 printed a heap-exhaustion banner while the process was alive.
   *
   * Read here rather than off the finished log because the log is what the
   * limits act on: V8 prints its banner last, so a script that logged past its
   * step budget before dying lost the one line that names the cause — and
   * "logged a line per item, then ran out of heap" is the ordinary shape of a
   * script that hits this limit. A rolling window carries a banner split
   * across two pipe chunks.
   */
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
        // A V8 fatal error prints its banner and frame dump on stderr, so only
        // that stream pays the cost of line buffering or of being watched.
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
    // Only a tail that could still grow into a secret is held back. Holding
    // back a fixed `longest value - 1` characters delayed whole lines that
    // could never match — with a 32-character secret configured, a 19
    // character line waited for that stream's next chunk and landed after text
    // the script wrote later. Adding a secret to a flow must not reorder its
    // log.
    //
    // Measured on the text as written, and scrubbed only after the split. One
    // secret's value can sit inside another's — a host inside a URL that is
    // itself a secret, the case the longest-first replacement exists for — and
    // scrubbing first rewrote the host to `{{secret:HOST}}`, so the chunk no
    // longer ended in anything that could grow into the URL. The whole chunk
    // went out, and neither this pass nor the final one could ever match the
    // URL again.
    const split = final
      ? pending.length
      : Math.max(0, pending.length - partialSecretTail(pending, secrets));
    const emit = scrubSecretValues(pending.slice(0, split), secrets);
    state.holdback = pending.slice(split);
    this.release(state, held, emit);
    // A collapsed frame dump is output the report does not carry, which is what
    // `logTruncated` means.
    if (state.collapser?.collapsed) this.truncatedFlag = true;
    // Where the tail now held back belongs in the shared buffer, taken before
    // the other stream can append past it. Text still held from an earlier
    // chunk keeps the place it already had; a tail drawn from this chunk takes
    // a new one, after everything written before it.
    if (!state.holdback) state.holdbackAt = undefined;
    else if (split >= held.length) state.holdbackAt = this.parts.push("") - 1;
  }

  /**
   * Write what this chunk released, each half where the script wrote it.
   *
   * The hold-back is per stream and the buffer is shared, so released text
   * that was held from an earlier chunk belongs *before* whatever the other
   * stream wrote in between — appending it now would move it past that text.
   * One character is enough to trigger it, since any first character of a
   * secret is a prefix worth holding, and the shape it hits is the one the
   * hold-back was made short for: an unterminated progress line, then output on
   * the other stream. The place was reserved when the tail was taken; this
   * fills it.
   */
  private release(state: StreamState, held: string, emit: string): void {
    const at = state.holdbackAt;
    if (at === undefined || !emit) {
      this.append(state.collapser ? state.collapser.write(emit) : emit);
      return;
    }
    // Scrubbing the held text on its own says how much of `emit` is that text,
    // whenever no value spans the join. A value that does span it has no side
    // to belong to, so its replacement goes with the chunk that completed it.
    const head = scrubSecretValues(held, this.secrets());
    const headText = emit.startsWith(head) ? head : "";
    // The collapser is a stream transform, so it has to see the two in order.
    this.append(state.collapser ? state.collapser.write(headText) : headText, at);
    const tailText = emit.slice(headText.length);
    this.append(state.collapser ? state.collapser.write(tailText) : tailText);
  }

  /** Append to the end of the buffer, or into the place reserved at `at`. */
  private append(text: string, at?: number): void {
    if (!text) return;
    const runRemaining = this.runBudget
      ? Math.max(0, this.runBudget.remainingBytes)
      : Number.POSITIVE_INFINITY;
    const allowed = Math.min(this.stepRemaining, runRemaining);
    if (allowed <= 0) {
      this.truncatedFlag = true;
      return;
    }
    const buffer = Buffer.from(text, "utf8");
    const taken = buffer.length <= allowed ? buffer.length : utf8SafeCut(buffer, allowed);
    if (taken > 0) {
      const kept = taken === buffer.length ? text : buffer.subarray(0, taken).toString("utf8");
      if (at === undefined) this.parts.push(kept);
      else this.parts[at] += kept;
      this.stepRemaining -= taken;
      if (this.runBudget) this.runBudget.remainingBytes -= taken;
    }
    if (taken < buffer.length) this.truncatedFlag = true;
  }
}

/**
 * How many characters at the end of `text` are a proper prefix of some secret
 * value — the only tail a later chunk could complete into a whole value, and so
 * the only tail worth holding back.
 */
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

/** Back off to the start of a UTF-8 sequence so a cut never splits a character. */
function utf8SafeCut(buffer: Buffer, max: number): number {
  let cut = Math.min(max, buffer.length);
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  return cut;
}

const V8_FRAME_RE = /^\s*\d+:\s+0x[0-9a-f]+/i;
/**
 * What a V8 frame dump follows. Until one of these prints, nothing is
 * collapsed. Coarse on purpose, and coarse enough to match ordinary prose that
 * happens to contain the words — a script's own `Fatal error in the inferior`
 * arms it, and four `N: 0xHEX` lines after that are collapsed. The cost of a
 * false arm is a marker line in place of frame-shaped output; the cost of
 * missing a real dump is sixty lines of the log budget.
 */
const ARM_FRAME_COLLAPSE_RE = /FATAL ERROR|Fatal error in|Fatal JavaScript|# Fatal/i;
/** Below this many consecutive frame lines, the run is passed through as written. */
const COLLAPSE_THRESHOLD = 3;

/**
 * Collapses a V8 fatal-error frame dump — roughly sixty lines of internal frame
 * addresses — to one marker line, so an abort does not flood the step's log
 * budget and push the script's own output out of the report.
 *
 * ```
 *  1: 0x104941aec node::OOMErrorHandler(char const*, v8::OOMDe...
 *  2: 0x104b94314 v8::internal::V8::FatalProcessOutOfMemory(v8...
 * ```
 *
 * Best-effort by design: the `Last few GCs` summary that names the cause and
 * every line the script itself wrote pass through untouched, a run shorter than
 * {@link COLLAPSE_THRESHOLD} is emitted verbatim so an ordinary log line that
 * happens to look like a frame survives, and an unrecognized dump costs log
 * budget without ever changing the verdict.
 */
class V8FrameCollapser {
  private partial = "";
  private held: string[] = [];
  private heldCount = 0;
  private armed = false;
  private armWindow = "";
  private collapsedAny = false;

  /** Whether any frame line has been replaced by a marker. */
  get collapsed(): boolean {
    return this.collapsedAny;
  }

  write(text: string): string {
    if (!text) return "";
    if (!this.armed) {
      // Until V8 has printed a fatal error there is no frame dump to collapse,
      // and line buffering would only hold text back: an unterminated write —
      // a progress indicator — waited for its newline while stdout written
      // afterwards was appended first. Pass everything straight through, and
      // watch a window wide enough to catch a banner split across two chunks.
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
    // A line that never ends would otherwise buffer without bound; past this
    // length it cannot usefully be classified anyway.
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

// ── Shared helpers ────────────────────────────────────────────────────────

function emptyResult(
  failure: FlowScriptFailure,
  extras: { notes?: string[]; queuedMs?: number; durationMs?: number } = {}
): FlowScriptResult {
  return {
    ok: false,
    failure,
    log: "",
    logTruncated: false,
    durationMs: extras.durationMs ?? 0,
    queuedMs: extras.queuedMs ?? 0,
    notes: extras.notes ?? [],
  };
}

/**
 * An error as a message. `formatErrorForAgent` for the `Error` case, which
 * walks the `.cause` chain — a `fetch failed` wrapping `connect ECONNREFUSED`
 * is exactly the shape a script produces. Anything else keeps the capped
 * rendering, since a value that is not an `Error` can be arbitrarily large.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return formatErrorForAgent(err) || String(err);
  return typeof err === "string" ? err : describeUnknown(err);
}

/** A short rendering of an unexpected value, for a message that quotes it. */
function describeUnknown(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  // A misbehaving runner controls this string, so it must not be able to make
  // the failure message arbitrarily long.
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

function describeDuration(ms: number): string {
  if (ms >= 60_000) {
    const minutes = ms / 60_000;
    return `${minutes.toFixed(minutes % 1 === 0 ? 0 : 1)}m`;
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${ms}ms`;
}
