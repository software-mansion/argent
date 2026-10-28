// Imports nothing from the tool-server, so it needs no build step: it is copied
// next to the compiled executor and resolves its watchdogs against its own URL.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { isMainThread, Worker } from "node:worker_threads";
import { stopOwnGroup } from "./flow-script-watchdog-deadline.mjs";

const LIFELINE_WATCHDOG = "flow-script-watchdog-lifeline.mjs";
const DEADLINE_WATCHDOG = "flow-script-watchdog-deadline.mjs";

/**
 * `--import` is inherited by a worker thread or `child_process.fork` the script
 * starts, and an active copy there would park in the handshake forever.
 * `isMainThread` covers the thread; clearing this covers the child, whose
 * environment is copied at spawn time.
 */
const ACTIVATION_ENV = "ARGENT_FLOW_SCRIPT_RUNNER";

let finished = false;

let maxOutputBytes = 0;

/**
 * The `output` object a `.mjs` script is handed, and its top-level keys, read
 * before the script runs. A key the script deletes from THIS object is one it
 * cleared; see `validate`.
 */
let handedOutput;
let handedKeys = [];

let probing = false;

let idleResources = [];

let runnerIsSending = false;

/** Bash mode leaves a child bash that nobody else reaps; read by `exitOnParentDisconnect`. */
let bashMode = false;

/**
 * The signals a script can aim at its own process group, which this process
 * leads in bash mode; held rather than acted on (see `holdGroupSignals`).
 * SIGQUIT too: Node's default kills on it while GNU bash ignores it.
 */
const GROUP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

const heldSignals = new Set();

/**
 * A stray carriage return as it lands in a file name: U+000D, or U+F00D under
 * msys2 bash on Windows, which maps control characters into the private-use area.
 */
const STRAY_SUFFIXES = ["\r", "\uF00D"];

/**
 * `O_NONBLOCK` so a named pipe swapped in after `irregularFileKind`'s `stat`
 * cannot block the open; a no-op on a regular file.
 */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/** Strict, so invalid UTF-8 is refused rather than replaced; see `readOutputFile`. */
const STRICT_UTF8 = new TextDecoder("utf8", { fatal: true });

/**
 * How long bash's death by a signal waits for the same signal to arrive here
 * before it is read as one from outside the group. Under the parent's stop grace.
 */
const GROUP_SIGNAL_SETTLE_MS = 1_000;

/**
 * How much of the step's time limit the wait above leaves alone, so the verdict
 * reaches the parent before its timer fires and reports a timeout instead.
 */
const GROUP_SIGNAL_SETTLE_GUARD_MS = 250;

const ENTRY_SETTLE_PROBE_MS = 1_000;

/**
 * In step with `flow-script-protocol.ts`, which this file cannot import. An IPC
 * message is deserialized whole into the parent's heap before anything can
 * inspect it, so only the sender can bound script-controlled failure text.
 */
const MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
const MAX_FAILURE_STACK_CHARS = 16 * 1024;

/**
 * Taken while this preload is the only code that has run: `process.send` is a
 * property a script may replace or delete, and reading it back later hands the
 * verdict to whatever stub took its place.
 */
const realSend = typeof process.send === "function" ? process.send : undefined;

const realExit = process.exit.bind(process);

/**
 * The protocol channel's own descriptor, read before any script code runs:
 * `process.channel` is a property a script may replace, and a wrong descriptor
 * would put the verdict into some other file. See `sendSynchronously`.
 *
 * None on Windows, where libuv frames each IPC message with its own header, so a
 * raw line would be unreadable; there the queued `process.send` frames it.
 */
const channelHandle = /** @type {{ fd?: number } | undefined} */ (
  /** @type {unknown} */ (process.channel)
);
const channelFd =
  process.platform !== "win32" && typeof channelHandle?.fd === "number" ? channelHandle.fd : -1;

/**
 * `JSON.stringify` and `JSON.parse` as they were before any script code ran: a
 * patch the script's dependency tree installs on the global would otherwise
 * decide the encoded verdict, including slipping a `__proto__` own key past the
 * validator that exists to reject it.
 */
const encodeJson = JSON.stringify;
const decodeJson = JSON.parse;

const runnerListeners = [];

/**
 * Set by the deadline watchdog before it stops this tree, so a bash killed first
 * by Windows' one-at-a-time `taskkill /t` is not reported as exit code 1.
 */
const deadlineFired = new Int32Array(new SharedArrayBuffer(4));

// Every pattern the functions below read is declared above the activation call:
// in bash mode `prepare` never returns, so a `const` declared after it stays in
// its temporal dead zone for the life of the process.
const POSIX_ERRNO_RE = /^E[A-Z]+$/;

/** Node's module loader, ESM and CommonJS alike. */
const LOADER_FRAME_RE = /node:internal\/modules\//;

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const MAX_CAUSE_DEPTH = 8;
const CAUSED_BY = " — caused by: ";
const ALSO = "; ";

if (isMainThread && process.env[ACTIVATION_ENV] === "1") {
  delete process.env[ACTIVATION_ENV];
  await prepare();
}

async function prepare() {
  const raw = await nextRequest();
  const request = parseRequest(raw);
  if (!request) {
    finish({
      type: "failure",
      failureType: "protocol",
      message: `The script runner received a malformed request: ${safeStringify(raw)}`,
    });
    return never();
  }

  maxOutputBytes = request.maxOutputBytes;
  startWatchdogs(request.deadlineMs);

  if (request.interpreter === "bash") return runBash(request);

  try {
    globalThis.output = decodeJson(request.outputJson);
    handedOutput = globalThis.output;
    handedKeys = Object.keys(handedOutput);
  } catch (err) {
    finish({
      type: "failure",
      failureType: "protocol",
      message: `The script runner could not decode the e2e test output it was given: ${errorMessage(err)}`,
    });
    return never();
  }

  // Claim the crash: Node's default is to print and exit 1, which reaches the
  // executor as "the script stopped its own process" and loses the error. An
  // unhandled rejection arrives here too, unless the script claims it.
  keepListener("uncaughtException", (err) => {
    // Unless the script has a handler of its own, which plain `node` would let
    // recover. This one is registered before the script loads, so any second
    // listener is the script's.
    if (process.listenerCount("uncaughtException") > 1) return;
    finish({
      type: "failure",
      failureType: classifyScriptError(err),
      message: errorMessage(err),
      stack: errorStack(err),
    });
  });

  // Registered before the script loads, so this runs before the script's own
  // `beforeExit` handlers: every firing is spent yielding so their scheduled
  // cleanup gets its round, and if they scheduled anything `beforeExit` comes
  // round again — the same unbounded retry loop plain `node` runs.
  keepListener("beforeExit", () => {
    if (finished || probing) return;
    setImmediate(() => {
      if (finished || probing) return;
      // Read after the yield, not during the emission: by now the handlers and
      // the microtasks an `async` one queued have all run.
      if (scriptScheduledWork()) return;
      probing = true;
      reportWhenEntrySettled(request.scriptUrl);
    });
  });

  closeChannelToScript();

  // Registered here rather than at module scope: Node references the IPC
  // channel while a `message` or `disconnect` listener exists, and in the
  // inactive preload a forked child inherits, that reference alone would keep
  // the script's own child alive.
  keepListener("disconnect", exitOnParentDisconnect);
  guardRunnerListeners();
  reportOnScriptExit();

  // The only thing that lets the executor tell "the runner never began the
  // script" apart from "the script stopped its own process".
  sendToParent({ type: "started" });

  // A live handle keeps the loop non-empty, so `beforeExit` would never fire.
  // Unreferencing only drops it from the liveness count; the channel stays open.
  if (process.channel && typeof process.channel.unref === "function") {
    process.channel.unref();
  }

  // Read last, so it is the loop as the script inherits it. Node awaits this
  // module before it loads the entry, so there is no later point that holds.
  idleResources = process.getActiveResourcesInfo();
}

/**
 * Bash mode: bash is an ordinary child in the group this process leads, so every
 * stop reaches it and the parent classifies it as it does a `.mjs` step.
 */
function runBash(request) {
  bashMode = true;
  // As close to the moment the parent armed its own timer as this side can see.
  const startedAt = Date.now();
  holdGroupSignals();
  // Registered here for the reason node mode registers it here: Node references
  // the IPC channel while a `disconnect` listener exists.
  keepListener("disconnect", exitOnParentDisconnect);

  let child;
  // fds 3-5 point at the null device: in this process 4 is the lifeline and 5 the
  // protocol channel, so a bash `echo … >&5` could otherwise forge a verdict.
  // Node's close-on-exec of inherited fds is a startup detail, not a contract.
  const nulls = [];
  try {
    for (let slot = 0; slot < 3; slot++) nulls.push(fs.openSync(os.devNull, "r+"));
    // Announced before the spawn, straight to the channel: the script's first
    // line can kill this process (`kill -9 $PPID`) before a queued message goes
    // out. A spawn that then fails still sends its own terminal failure.
    announceStarted();
    child = spawn(request.interpreterPath, [request.scriptPath], {
      // The environment the parent built; the exchange name is all this side adds.
      cwd: process.cwd(),
      env: {
        ...process.env,
        ARGENT_OUTPUT: request.outputFile,
      },
      // `bash <file>`, never `shell: true` or the shebang, so the path is one
      // argument, no execute bit is needed and the resolved bash is the one that
      // runs. stdin is the null device; stdout/stderr go to the parent's capture.
      stdio: ["ignore", "inherit", "inherit", ...nulls],
      // bash joins this process's group on POSIX; on Windows the parent's
      // `taskkill /t` on this process walks to it.
      windowsHide: true,
    });
  } catch (err) {
    finish(spawnFailure(request, err));
    return never();
  } finally {
    for (const fd of nulls) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed by a spawn that threw after taking it.
      }
    }
  }

  child.on("error", (err) => finish(spawnFailure(request, err)));
  child.on("exit", (code, signal) => {
    // Both null is a spawn that failed, which the `error` handler reports.
    if (code === null && signal === null) return;
    // A group signal reaches this process too; wait for it so the report names it.
    if (signal) {
      whenGroupSignalHeld(
        signal,
        () => finish(bashOutcome(request, code, signal)),
        groupSignalBudget(request, startedAt)
      );
    } else finish(bashOutcome(request, code, signal));
  });
  return never();
}

/**
 * Take the group's signals away from Node's default of ending this process:
 * `trap 'kill 0' EXIT` signals the whole group, and the runner must survive to
 * read `$ARGENT_OUTPUT` and send a verdict. Bash's own exit is the verdict.
 */
function holdGroupSignals() {
  for (const signal of GROUP_SIGNALS) {
    try {
      process.on(signal, () => heldSignals.add(signal));
    } catch {
      // A platform that does not know the name; the default stands for it.
    }
  }
}

/**
 * What is left of the settle above once the step's time limit is taken into
 * account: past the parent's timer, an answer only turns into a timeout.
 */
function groupSignalBudget(request, startedAt) {
  if (!Number.isFinite(request.timeoutMs)) return GROUP_SIGNAL_SETTLE_MS;
  const left = request.timeoutMs - (Date.now() - startedAt) - GROUP_SIGNAL_SETTLE_GUARD_MS;
  return Math.min(GROUP_SIGNAL_SETTLE_MS, left);
}

/**
 * Run `report` once `signal` is one this process holds, or once the window above
 * has passed. A listener, since the child's exit routinely arrives before the
 * signal; the holding listener was registered first, so `heldSignals` is current.
 */
function whenGroupSignalHeld(signal, report, budgetMs = GROUP_SIGNAL_SETTLE_MS) {
  if (heldSignals.has(signal) || !GROUP_SIGNALS.includes(signal) || budgetMs <= 0) {
    report();
    return;
  }
  let waited = false;
  const settle = () => {
    if (waited) return;
    waited = true;
    clearTimeout(timer);
    process.off(signal, settle);
    report();
  };
  const timer = setTimeout(settle, budgetMs);
  try {
    process.on(signal, settle);
  } catch {
    // A platform that does not know the name; the timer is the whole wait.
  }
}

/**
 * `started`, on the channel before this call returns (only queued on Windows,
 * which has no descriptor; see `channelFd`).
 */
function announceStarted() {
  if (sendSynchronously({ type: "started" })) return;
  try {
    sendToParent({ type: "started" });
  } catch {
    // The channel is gone; the parent's own exit verdict is what is left.
  }
}

function spawnFailure(request, err) {
  return {
    type: "failure",
    failureType: "spawn",
    message: `bash (${request.interpreterPath}) could not be started: ${errorMessage(err)}`,
  };
}

/**
 * A non-zero exit status is the whole verdict, `128+N` included: the script ran
 * that command and could have handled its status. A signal on bash itself is
 * read by whether this process received it too.
 */
function bashOutcome(request, code, signal) {
  if (signal) {
    // A signal this process received too went to the group, which is the step's
    // own, so it is the script's answer: an `exit`. The document is not read here.
    if (heldSignals.has(signal)) {
      return {
        type: "failure",
        failureType: "exit",
        message:
          `The step's process group was sent ${signal}, which killed bash before it exited ` +
          `(bash: ${request.interpreterPath}), so the step fails on the signal and reports no ` +
          "document — whatever the script had written to $ARGENT_OUTPUT before it. " +
          "`kill 0` reaches bash itself, not only the background jobs it is usually written " +
          "for: signal each job's own pid instead.",
      };
    }
    return {
      type: "failure",
      failureType: "signal",
      message:
        `The script was killed by ${signal} before it exited ` +
        `(bash: ${request.interpreterPath}).` +
        // A `kill 0` in the script's body kills bash alone, so it arrives here
        // the same way and the message names both causes.
        (GROUP_SIGNALS.includes(signal)
          ? " A `kill 0` in the body of the script ends bash the same way and is not " +
            "distinguishable from this: signal each job's own pid instead."
          : ""),
    };
  }
  const status = code ?? 0;
  if (status !== 0) {
    // The reason is on stderr, which the parent captures and appends.
    return {
      type: "failure",
      failureType: "exit",
      message:
        `The script exited with code ${status} (bash: ${request.interpreterPath}).` +
        exitCodeHint(status),
    };
  }
  const read = readOutputFile(request.outputFile, request.maxOutputBytes);
  // Only when the document is missing or still the seed: a stray `\r` sibling
  // beside a document the script did write is not a CRLF problem.
  if (read.error || read.json === request.outputJson) {
    const strayed = carriageReturnProblem(request);
    if (strayed) return { type: "failure", failureType: "output", message: strayed };
  }
  return read.error
    ? { type: "failure", failureType: "output", message: read.error }
    : { type: "result", outputJson: read.json };
}

/**
 * The one silent CRLF symptom: a CRLF `.sh` writes to `output.json\r`, leaving
 * the seeded document in place and exiting 0. A name with a carriage return
 * after it is the proof.
 */
function carriageReturnProblem(request) {
  if (!strayedByCarriageReturn(request.outputFile)) return null;
  return carriageReturnHint("$ARGENT_OUTPUT", "so the document Argent read is the one it seeded");
}

/** Whether the script wrote one carriage return past the name it was given. */
function strayedByCarriageReturn(file) {
  return STRAY_SUFFIXES.some((suffix) => fs.existsSync(`${file}${suffix}`));
}

/** The one CRLF sentence, with the consequence its caller can see. */
function carriageReturnHint(name, consequence) {
  return (
    `the script wrote to a file one carriage return past the one ${name} names, ${consequence}: ` +
    "the script has CRLF line endings, and the carriage return ends every line inside the word " +
    "before it. Convert the file to LF (`*.sh text eol=lf` in .gitattributes)"
  );
}

function exitCodeHint(status) {
  if (status === 127) {
    return (
      " Code 127 is bash's own \"command not found\": a tool missing from the tool server's PATH " +
      "snapshot, or a script checked out with CRLF line endings."
    );
  }
  if (status === 126) {
    return (
      ' Code 126 is bash\'s own "found, but could not be run": a file bash may not READ ' +
      "(`chmod +r` on the script), or a command in it that is found and not executable " +
      "(`chmod +x` on that command)."
    );
  }
  return "";
}

/**
 * The document, after exit 0, in one bounded read of `maxOutputBytes + 1` bytes;
 * the parent parses and validates it.
 */
function readOutputFile(file, maxOutputBytes) {
  const irregular = irregularFileKind(file);
  if (irregular) {
    return {
      error:
        irregular === "missing"
          ? "the file named by $ARGENT_OUTPUT is gone, so the script returned no output document"
          : `the file named by $ARGENT_OUTPUT is ${irregular} rather than a regular file, so there is no document to read`,
    };
  }
  let fd;
  try {
    fd = fs.openSync(file, READ_FLAGS);
  } catch (err) {
    return {
      error:
        err && err.code === "ENOENT"
          ? "the file named by $ARGENT_OUTPUT is gone, so the script returned no output document"
          : `the file named by $ARGENT_OUTPUT could not be read: ${errorMessage(err)}`,
    };
  }
  try {
    const cap = maxOutputBytes + 1;
    const buffer = Buffer.alloc(cap);
    const read = readInto(fd, buffer, cap);
    if (read > maxOutputBytes) {
      return {
        error:
          `the document the script wrote to $ARGENT_OUTPUT is over the ` +
          `${describeBytes(maxOutputBytes)} limit`,
      };
    }
    if (read === 0) {
      return {
        error:
          "the file named by $ARGENT_OUTPUT is empty — a redirection truncates it before the " +
          "command writing it runs, so write to a sibling and `mv` it into place",
      };
    }
    // Decoded strictly: replacement characters would silently corrupt the value
    // and make the size here (file bytes) disagree with the parent's.
    try {
      return { json: STRICT_UTF8.decode(buffer.subarray(0, read)) };
    } catch {
      return {
        error:
          "the document the script wrote to $ARGENT_OUTPUT is not valid UTF-8, and Argent will " +
          "not rewrite the bytes a script emitted: write the document as UTF-8 (a JSON document " +
          "is UTF-8 by definition)",
      };
    }
  } catch (err) {
    return { error: `the file named by $ARGENT_OUTPUT could not be read: ${errorMessage(err)}` };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * What is at `file` when it is not a regular file, asked before the open so the
 * report names it. A symlink is followed: one to a regular file is a document.
 */
function irregularFileKind(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return err && err.code === "ENOENT" ? "missing" : null;
  }
  if (stat.isFile()) return null;
  if (stat.isDirectory()) return "a directory";
  if (stat.isFIFO()) return "a named pipe";
  if (stat.isSocket()) return "a socket";
  return "a device";
}

function readInto(fd, buffer, cap) {
  let read = 0;
  while (read < cap) {
    const chunk = fs.readSync(fd, buffer, read, cap - read, null);
    if (chunk === 0) break;
    read += chunk;
  }
  return read;
}

/**
 * Whether anything the script's `beforeExit` handlers just scheduled is still
 * pending. Counted per kind rather than by length: a script that closes a
 * standard stream while also scheduling work would otherwise come out even.
 */
function scriptScheduledWork() {
  const idle = new Map();
  for (const kind of idleResources) idle.set(kind, (idle.get(kind) ?? 0) + 1);
  for (const kind of process.getActiveResourcesInfo()) {
    const left = idle.get(kind) ?? 0;
    if (left === 0) return true;
    idle.set(kind, left - 1);
  }
  return false;
}

/**
 * An empty event loop is not proof the script finished: a top-level `await`
 * that never settles leaves nothing to run either. Re-importing the entry tells
 * them apart — Node caches by URL, so a finished module resolves from the cache
 * without evaluating again, while a parked one awaits the very promise that is
 * not settling. The executor sends the real path Node resolved the entry from,
 * so this is always a cache hit; a rejection counts as settled.
 *
 * The timer both holds the loop open while the probe runs and bounds the wait.
 */
function reportWhenEntrySettled(scriptUrl) {
  const bound = setTimeout(() => {
    finish({
      type: "failure",
      failureType: "runtime",
      message:
        "The script stopped at a top-level `await` that never settled: nothing was " +
        "left to run and no output was produced.",
    });
  }, ENTRY_SETTLE_PROBE_MS);
  const report = () => {
    clearTimeout(bound);
    const code = process.exitCode;
    if (code !== undefined && code !== null && code !== 0) {
      finish({
        type: "failure",
        failureType: "exit",
        message: `The script set process.exitCode to ${code}, which means it failed.`,
      });
      return;
    }
    // Read the global back rather than a reference captured earlier: a script
    // may mutate the object or replace the binding outright, and both are legal.
    const encoded = encodeOutput(globalThis.output, maxOutputBytes);
    finish(
      encoded.error
        ? { type: "failure", failureType: "output", message: encoded.error }
        : { type: "result", outputJson: encoded.json }
    );
  };
  import(scriptUrl).then(report, report);
}

function keepListener(event, handler) {
  runnerListeners.push({ event, handler });
  process.on(event, handler);
}

/**
 * `process.removeAllListeners()` with no argument is ordinary cleanup code and
 * takes the runner's `beforeExit` probe with it. Re-registering inside the call
 * also restores the runner's handlers to first place, which both depend on.
 */
function guardRunnerListeners() {
  const realRemoveAllListeners = process.removeAllListeners;
  process.removeAllListeners = (...args) => {
    const result = realRemoveAllListeners.apply(process, args);
    for (const { event, handler } of runnerListeners) {
      if (!process.listeners(event).includes(handler)) process.on(event, handler);
    }
    return result;
  };
}

/**
 * `beforeExit` does not fire after an explicit exit, so the common
 * `main().then(() => process.exit(0))` would report as self-termination with no
 * output. A non-zero exit is left to the parent's `exit` verdict.
 */
function reportOnScriptExit() {
  // Cast because `process.exit` is typed as returning `never` and an arrow that
  // ends in a call to it is inferred as returning that call's type.
  process.exit = /** @type {typeof process.exit} */ (
    (...args) => {
      const code = args.length > 0 ? args[0] : process.exitCode;
      if (!finished && (code === undefined || code === null || Number(code) === 0)) {
        const encoded = encodeOutput(globalThis.output, maxOutputBytes);
        finishSynchronously(
          encoded.error
            ? { type: "failure", failureType: "output", message: encoded.error }
            : { type: "result", outputJson: encoded.json }
        );
      }
      // Forwarded by arity, not by value: `realExit(undefined)` differs from
      // `realExit()` in whether a `process.exitCode` the script set survives.
      return realExit(...args);
    }
  );
}

/**
 * `fork` leaves a working `process.send` in the child and the executor trusts
 * whatever arrives on it, so a script that pings its parent could tear down a
 * healthy run or forge its own verdict. The channel stays open for the runner;
 * script code gets a `send` that accepts and drops and a `disconnect` that
 * closes nothing.
 *
 * Both stubs must still *answer* the way Node does, or a script awaiting the
 * send callback or the `disconnect` event parks with an empty event loop —
 * which the runner would read as a pass.
 */
function closeChannelToScript() {
  // `_send` is Node's undocumented implementation behind `send`, reachable by
  // name from a script, so it is guarded too.
  const host = /** @type {{ _send?: Function }} */ (/** @type {unknown} */ (process));
  const realLowLevelSend = host._send;
  // `send` calls `this._send`, so one flag guards both names — the runner's own
  // call sets it for the length of that call.
  process.send = (...args) => {
    if (runnerIsSending) return realSend.apply(process, args);
    acknowledge(args);
    return true;
  };
  if (typeof realLowLevelSend === "function") {
    host._send = (...args) => {
      if (runnerIsSending) return realLowLevelSend.apply(process, args);
      acknowledge(args);
      return true;
    };
  }
  process.disconnect = () => {
    // Nothing is actually closed, so the runner's own handler is skipped, but
    // the script's listeners still expect the event Node would have emitted.
    for (const listener of process.listeners("disconnect")) {
      if (listener === exitOnParentDisconnect) continue;
      setImmediate(() => listener.call(process));
    }
  };
}

/**
 * Call a `process.send` callback the way Node would: asynchronously, with no
 * error. It is the last argument of both `send` and the `_send` behind it.
 */
function acknowledge(args) {
  const callback = args[args.length - 1];
  if (typeof callback === "function") setImmediate(() => callback(null));
}

/**
 * Only reached while the event loop is still turning; a synchronous infinite
 * loop never gets here, which is what the lifeline watchdog thread is for.
 *
 * In bash mode it takes the group down first, as the lifeline watchdog does, so
 * bash is not left running under a runner that is gone.
 */
function exitOnParentDisconnect() {
  if (!bashMode) {
    realExit(0);
    return;
  }
  stopOwnGroup();
  process.kill(process.pid, "SIGKILL");
}

function nextRequest() {
  return new Promise((resolve) => {
    process.once("message", resolve);
  });
}

/**
 * Park forever. `finish` exits from inside a stream callback, so returning
 * after a verdict would let Node load the entry module in the meantime.
 */
function never() {
  return new Promise(() => {});
}

/** An absent `interpreter` is an older executor's request, which means node. */
function parseRequest(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  if (raw.type !== "execute") return null;
  if (!Number.isFinite(raw.deadlineMs) || raw.deadlineMs <= 0) return null;
  if (!Number.isFinite(raw.maxOutputBytes) || raw.maxOutputBytes <= 0) return null;
  const interpreter = raw.interpreter ?? "node";
  if (interpreter === "node") {
    if (typeof raw.scriptUrl !== "string") return null;
    if (typeof raw.outputJson !== "string") return null;
    return { ...raw, interpreter };
  }
  if (interpreter !== "bash") return null;
  if (typeof raw.interpreterPath !== "string" || raw.interpreterPath === "") return null;
  if (typeof raw.scriptPath !== "string" || raw.scriptPath === "") return null;
  if (typeof raw.outputFile !== "string" || raw.outputFile === "") return null;
  if (typeof raw.outputJson !== "string") return null;
  return raw;
}

/**
 * Two worker threads, started before the script loads and unref'd so they never
 * hold the process open. A worker has its own OS thread, so a main thread
 * spinning in a synchronous loop cannot starve it. They cannot share one: the
 * deadline's `Atomics.wait` blocks its thread for the whole time limit, so a
 * lifeline there would not see the parent go until the deadline had passed.
 */
function startWatchdogs(deadlineMs) {
  const here = import.meta.url;
  // Read here rather than in the worker: `process.ppid` is a property script
  // code may replace, and the worker's own `process` is not the main thread's.
  start(new URL(LIFELINE_WATCHDOG, here), { parentPid: process.ppid });
  start(new URL(DEADLINE_WATCHDOG, here), { deadlineMs, fired: deadlineFired });

  function start(url, workerData) {
    try {
      // `execArgv: []` keeps this preload out of the worker, which would
      // otherwise inherit it and re-run this file for nothing.
      const worker = new Worker(url, { execArgv: [], ...(workerData ? { workerData } : {}) });
      worker.on("error", (err) => reportWatchdogProblem(url, err));
      worker.unref();
    } catch (err) {
      reportWatchdogProblem(url, err);
    }
  }
}

function reportWatchdogProblem(url, err) {
  try {
    const name = url.href.slice(url.href.lastIndexOf("/") + 1);
    process.stderr.write(`[argent] script watchdog ${name} unavailable: ${errorMessage(err)}\n`);
  } catch {
    // Reporting must never be what ends the run.
  }
}

/**
 * Which side of the load boundary failed. The module codes below are
 * unambiguous; the two rows after them are not, since the same error class
 * arrives from both sides — a `SyntaxError` is a module that would not parse
 * *or* `JSON.parse` of an HTML error page, and a POSIX errno is the loader
 * failing to open the script *or* the script's own I/O. Loader frames separate
 * them.
 */
function classifyScriptError(err) {
  const code = err && typeof err === "object" ? err.code : undefined;
  if (
    typeof code === "string" &&
    (code.startsWith("ERR_MODULE") ||
      code.startsWith("ERR_UNSUPPORTED") ||
      code === "MODULE_NOT_FOUND" ||
      code === "ERR_UNKNOWN_FILE_EXTENSION" ||
      code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
      code === "ERR_IMPORT_ATTRIBUTE_MISSING" ||
      code === "ERR_IMPORT_ATTRIBUTE_UNSUPPORTED" ||
      code === "ERR_INVALID_MODULE_SPECIFIER")
  ) {
    return "load";
  }
  const fromLoader = isLoaderFailure(err);
  if (err instanceof SyntaxError) return fromLoader ? "load" : "runtime";
  if (typeof code === "string" && POSIX_ERRNO_RE.test(code)) return fromLoader ? "load" : "runtime";
  return "runtime";
}

/**
 * True only for a loader frame with no frame naming a file above it. A file
 * frame settles it the other way whatever else is on the stack — a top-level
 * throw carries `ModuleJob.run` under the script's own frame — and no loader
 * frame at all is not evidence either way, which is the answer for an error
 * raised asynchronously or with no frames.
 */
function isLoaderFailure(err) {
  const stack = errorStack(err);
  if (typeof stack !== "string") return false;
  let loaderSeen = false;
  for (const line of stack.split("\n").slice(1)) {
    const frame = line.trim();
    if (!frame.startsWith("at ")) continue;
    if (LOADER_FRAME_RE.test(frame)) {
      loaderSeen = true;
      continue;
    }
    if (frame.includes("node:")) continue;
    if (frame.includes("file:") || /[/\\]/.test(frame)) return false;
  }
  return loaderSeen;
}

/**
 * Validation cannot happen in the parent: the IPC channel serializes as JSON,
 * so a function vanishes silently, `NaN` and `Infinity` arrive as `null`, and a
 * BigInt or cycle throws inside `send`. An `undefined` member vanishes there
 * too, and at the top level that loss would keep an earlier step's value; see
 * `walk`.
 *
 * What is encoded is the copy the walk built, never a second read of the live
 * object: a getter, a Proxy trap or a `toJSON` may answer differently the
 * second time, and that answer would be the one that ships.
 */
function encodeOutput(value, maxOutputBytes) {
  let checked;
  try {
    checked = validate(value);
  } catch (err) {
    return { error: `output could not be read: ${errorMessage(err)}` };
  }
  if (checked.problem) return { error: checked.problem };

  let json;
  try {
    json = encodeJson(checked.value);
  } catch (err) {
    return { error: `output could not be encoded: ${errorMessage(err)}` };
  }
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > maxOutputBytes) {
    return {
      error: `output is ${describeBytes(bytes)} encoded; the limit is ${describeBytes(maxOutputBytes)}`,
    };
  }
  return { json };
}

function validate(root) {
  // The root is what later steps read paths out of: a replaced `output = "done"`
  // has nothing to merge and no path to address.
  if (root === null || typeof root !== "object" || Array.isArray(root) || !isPlainObject(root)) {
    return { problem: `output is ${describeValue(root)}; output must be a plain object` };
  }
  const walked = walk(root, "output");
  // The parent merges this document over the run's, so a key missing here keeps
  // its earlier value. A key deleted from the object the script was handed is
  // one it cleared. A script that assigns a new object keeps every key it
  // leaves out, as a `.sh` that writes a new file does. A `toJSON` on the root
  // can make the copy something other than an object; the parent refuses that.
  if (
    walked.problem === undefined &&
    root === handedOutput &&
    walked.value !== null &&
    typeof walked.value === "object" &&
    isPlainObject(walked.value)
  ) {
    for (const key of handedKeys) {
      if (!Object.hasOwn(walked.value, key)) walked.value[key] = null;
    }
  }
  return walked;
}

/**
 * The deepest document the parent accepts (`MAX_OUTPUT_DEPTH` in
 * `flow-script-executor.ts`, with the same message), held here as well because
 * the walk below has no stack to run out of: output that grows as it is read —
 * a getter or a `toJSON` that makes a fresh object each time — would otherwise
 * fill the heap before the parent could refuse it.
 */
const MAX_OUTPUT_DEPTH = 256;

const MAX_PROBLEM_PATH_CHARS = 80;

/**
 * Validates and copies the document with an explicit stack: every script is
 * handed the run's whole document, at any depth the parent accepts.
 *
 * Depth-first and in key order, so the first problem is the one a recursive
 * walk would report. Each value is read once and the copy is built from those
 * reads, never from a second look at the live object.
 */
function walk(root, rootPath) {
  const ancestors = new Set();
  const frames = [];
  /** @type {unknown} Assigned inside `enter`, which control flow cannot follow. */
  let result;

  const release = (held) => {
    for (const value of held) ancestors.delete(value);
  };

  // A container is assigned its empty copy at once and filled by its frame. It
  // stays in `ancestors` until that frame is done, and so does every object
  // whose `toJSON` produced it: that is how a cycle through `toJSON` is seen.
  const open = (source, copy, path, assign, held) => {
    // `frames` holds exactly the containers above this one, so this is its depth.
    if (frames.length + 1 > MAX_OUTPUT_DEPTH) {
      const shown =
        path.length <= MAX_PROBLEM_PATH_CHARS ? path : `${path.slice(0, MAX_PROBLEM_PATH_CHARS)}…`;
      return (
        `${shown} nests deeper than ${MAX_OUTPUT_DEPTH} levels; output must be a document a ` +
        "later step can read back."
      );
    }
    ancestors.add(source);
    held.push(source);
    assign(copy);
    frames.push({
      source,
      copy,
      path,
      held,
      next: 0,
      keys: Array.isArray(source) ? undefined : Object.keys(source),
    });
    return undefined;
  };

  const enter = (start, path, assign) => {
    let value = start;
    const held = [];
    for (;;) {
      if (value === null || typeof value === "string" || typeof value === "boolean") {
        assign(value);
        release(held);
        return undefined;
      }
      const type = typeof value;
      if (type === "number") {
        if (!Number.isFinite(value)) {
          return `${path} is ${describeValue(value)}; output numbers must be finite`;
        }
        assign(value);
        release(held);
        return undefined;
      }
      if (type !== "object") {
        return `${path} is ${describeValue(value)}; output must be JSON-compatible data`;
      }
      if (ancestors.has(value)) return `${path} is a cyclic reference; output must be a tree`;
      if (Array.isArray(value)) return open(value, [], path, assign, held);
      // Before the `toJSON` branch, which a Date would otherwise take: it encodes
      // to a string a later step cannot read back as a date.
      if (value instanceof Date) {
        return `${path} is a Date; output must be JSON-compatible data (use an ISO string)`;
      }
      if (typeof value.toJSON === "function") {
        ancestors.add(value);
        held.push(value);
        value = value.toJSON();
        continue;
      }
      if (!isPlainObject(value)) {
        return `${path} is ${describeValue(value)}; output must be JSON-compatible data`;
      }
      return open(value, {}, path, assign, held);
    }
  };

  const first = enter(root, rootPath, (copy) => {
    result = copy;
  });
  if (first !== undefined) return { problem: first };

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    let problem;
    if (frame.keys === undefined) {
      if (frame.next >= frame.source.length) {
        release(frames.pop().held);
        continue;
      }
      const i = frame.next++;
      // An element cannot be dropped the way a member is: every element after
      // it would move down an index. `null` holds the position instead, which
      // is what `JSON.stringify` writes for `undefined` and an empty slot alike.
      const element = i in frame.source ? frame.source[i] : null;
      problem = enter(element === undefined ? null : element, `${frame.path}[${i}]`, (copy) => {
        frame.copy.push(copy);
      });
    } else {
      if (frame.next >= frame.keys.length) {
        release(frames.pop().held);
        continue;
      }
      const key = frame.keys[frame.next++];
      if (key === "__proto__") {
        // `JSON.parse` creates this as an own key, so a parsed body would carry
        // it into flow state, where a later `Object.assign` writes a prototype
        // rather than a property.
        return {
          problem: `${frame.path} has an own "__proto__" key; output must be JSON-compatible data`,
        };
      }
      const member = frame.source[key];
      // Not refused: a script that writes `output.promo = user.promo?.code` is
      // saying "there is no promo", and a later step's `??` fallback can supply
      // one. At the top level the key becomes `null`, which clears it: the
      // parent merges this document over the run's, so a dropped key would keep
      // an earlier step's promo. Deeper down it is dropped, as `JSON.stringify`
      // drops it, because its top-level value replaces the old one whole. Only a
      // plain `undefined` earns this: a function or a symbol is still a mistake
      // worth naming.
      if (member === undefined) {
        if (frames.length === 1) frame.copy[key] = null;
        continue;
      }
      problem = enter(member, `${frame.path}${memberPath(key)}`, (copy) => {
        frame.copy[key] = copy;
      });
    }
    if (problem !== undefined) return { problem };
  }
  return { value: result };
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function memberPath(key) {
  return IDENTIFIER_RE.test(key) ? `.${key}` : `[${encodeJson(key)}]`;
}

function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = typeof value;
  if (type === "number") {
    if (Number.isNaN(value)) return "NaN";
    return value > 0 ? "Infinity" : "-Infinity";
  }
  if (type === "function") return "a function";
  if (type === "symbol") return "a symbol";
  if (type === "bigint") return "a BigInt";
  if (type === "string") return "a string";
  if (type === "boolean") return "a boolean";
  if (Array.isArray(value)) return "an array";
  const name = value.constructor && value.constructor.name;
  return name ? `a ${name}` : "an object with an unusual prototype";
}

function describeBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

/**
 * Follows the parent's `formatErrorForAgent`, which this file cannot import.
 * The depth bound also guards a `.cause` that points back up its own chain.
 */
function errorMessage(err) {
  if (!(err instanceof Error)) return describeThrown(err);
  const parts = [];
  visitError(err, 0, CAUSED_BY, parts, new Set());
  return parts.map((part, at) => (at === 0 ? part.text : part.joiner + part.text)).join("");
}

function describeThrown(value) {
  return typeof value === "string" ? value : safeStringify(value);
}

function addPart(parts, joiner, text) {
  if (text && !parts.some((part) => part.text.includes(text))) parts.push({ joiner, text });
}

function visitError(err, depth, joiner, parts, seen) {
  if (depth > MAX_CAUSE_DEPTH) return;
  if (!(err instanceof Error)) {
    if (err !== undefined) addPart(parts, joiner, describeThrown(err));
    return;
  }
  if (seen.has(err)) return;
  seen.add(err);
  addPart(parts, joiner, err.message || String(err));
  const siblings = /** @type {{ errors?: unknown }} */ (err).errors;
  if (Array.isArray(siblings)) {
    const before = parts.length;
    for (const nested of siblings) {
      visitError(nested, depth + 1, parts.length === before ? CAUSED_BY : ALSO, parts, seen);
    }
  }
  visitError(err.cause, depth + 1, CAUSED_BY, parts, seen);
}

function errorStack(err) {
  return err instanceof Error && typeof err.stack === "string" ? err.stack : undefined;
}

function safeStringify(value) {
  try {
    return encodeJson(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * `process.stdout` is asynchronous when it is a pipe, so a bare `process.exit`
 * would discard buffered log output; the callback of an empty write on each
 * stream runs after every earlier write has flushed.
 *
 * The exit code is always 0 — the parent classifies on the terminal message.
 */
function finish(response) {
  if (finished) return;
  finished = true;
  // The deadline watchdog is stopping this tree; the parent's timer answers for it.
  if (Atomics.load(deadlineFired, 0) === 1) return;
  const bounded = boundFailureText(response);
  const exit = () => realExit(0);
  let pending = 2;
  const flushed = () => {
    if (--pending === 0) exit();
  };
  const flush = () => {
    // A stream whose peer is gone never calls back; without this fallback that
    // becomes a hang for the deadline watchdog to clean up.
    setTimeout(exit, 1000).unref();
    flushStream(process.stdout, flushed);
    flushStream(process.stderr, flushed);
  };
  try {
    sendToParent(bounded, flush);
  } catch {
    flush();
  }
}

/**
 * The same verdict, from inside the script's own `process.exit`, where there is
 * no turn of the event loop left to flush a stream in and there must not be
 * one. The buffered stdout lost here is lost under plain `node` too.
 */
function finishSynchronously(response) {
  if (finished) return;
  finished = true;
  const bounded = boundFailureText(response);
  if (sendSynchronously(bounded)) return;
  try {
    sendToParent(bounded);
  } catch {
    // The channel is gone; the parent's exit verdict is what is left.
  }
}

/**
 * `process.send` only queues: a message past the pipe buffer is written by
 * libuv over later turns of the loop, and the `process.exit` this runs inside
 * leaves before any of them — so a script reporting a result larger than about
 * 64 KiB through `main().then(() => process.exit(0))` delivered nothing, which
 * is the idiom this whole path exists for.
 *
 * The channel carries newline-delimited JSON, which is what `fork` uses unless
 * the parent asks for `serialization: "advanced"` — the executor does not. The
 * descriptor is non-blocking, so a full pipe answers `EAGAIN`, and the parent
 * is reading, so waiting for room is a sleep rather than a spin.
 *
 * The wait carries no clock of its own: the parent's loop blocks for seconds at
 * a time, and a window that ended inside one of those stalls would cut the
 * frame in half. The deadline watchdog ends a wait the parent never answers,
 * and it ends the process rather than the write, so the parent reads the step
 * as the timeout it is instead of a clean exit with nothing captured.
 */
function sendSynchronously(message) {
  if (channelFd < 0) return false;
  let payload;
  try {
    payload = Buffer.from(`${encodeJson(message)}\n`, "utf8");
  } catch {
    return false;
  }
  const slot = new Int32Array(new SharedArrayBuffer(4));
  let written = 0;
  while (written < payload.length) {
    try {
      written += fs.writeSync(channelFd, payload, written);
    } catch (err) {
      if (err && err.code === "EAGAIN") {
        Atomics.wait(slot, 0, 0, 1);
        continue;
      }
      // The parent is gone rather than slow. Half a frame may already be out,
      // and a second copy behind it would be a line the parent cannot parse —
      // which it parses inside its own stream callback. Sending again is worse
      // than sending nothing.
      return written > 0;
    }
  }
  return true;
}

function boundFailureText(response) {
  if (response.type !== "failure") return response;
  return {
    ...response,
    message: clampText(response.message, MAX_FAILURE_MESSAGE_CHARS),
    ...(response.stack === undefined
      ? {}
      : { stack: clampText(response.stack, MAX_FAILURE_STACK_CHARS) }),
  };
}

/**
 * The marker counts against the ceiling: left outside it the result exceeds the
 * ceiling, and the parent re-clamps at that same number, dropping this marker
 * and writing one that reports only the marker's own length.
 */
function clampText(text, max) {
  if (typeof text !== "string" || text.length <= max) return text;
  let cut = max;
  let marked = `${text.slice(0, cut)}${omissionMarker(text.length - cut)}`;
  // Two passes at most — the marker only grows by the digits the larger count
  // adds — and the `cut > 0` guard ends it for a ceiling narrower than a marker.
  while (marked.length > max && cut > 0) {
    cut = Math.max(0, cut - (marked.length - max));
    marked = `${text.slice(0, cut)}${omissionMarker(text.length - cut)}`;
  }
  return marked;
}

/** The tail {@link clampText} leaves behind; the parent reads it back. */
function omissionMarker(omitted) {
  return `… [${omitted} more characters omitted]`;
}

/**
 * An empty write, so the callback runs after everything already buffered. A
 * script may have ended the stream itself, and writing to an ended stream
 * raises an unhandled `error` event that would land in the step's own log.
 */
function flushStream(stream, done) {
  if (!stream || stream.writableEnded || stream.destroyed) {
    done();
    return;
  }
  stream.once("error", done);
  try {
    stream.write("", done);
  } catch {
    done();
  }
}

/**
 * The only path onto the protocol channel; see `closeChannelToScript`. Goes
 * through the `send` captured at load rather than whatever `process.send` names
 * by now, which is the script's to replace or delete.
 */
function sendToParent(message, callback) {
  const send = realSend ?? process.send;
  runnerIsSending = true;
  try {
    return send.call(process, message, callback);
  } finally {
    runnerIsSending = false;
  }
}
