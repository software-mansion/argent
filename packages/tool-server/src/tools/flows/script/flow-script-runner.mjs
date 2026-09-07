// Imports nothing from the tool-server, so it needs no build step: it is copied
// next to the compiled executor and resolves its watchdogs against its own URL.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { isMainThread, Worker } from "node:worker_threads";

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

let probing = false;

let idleResources = [];

let runnerIsSending = false;

/**
 * Set before anything can act on it, and read only by `exitOnParentDisconnect`.
 * In bash mode the process this file runs in has a child that nothing else will
 * reap once it is gone, so its exits are not interchangeable with node mode's.
 */
let bashMode = false;

/**
 * The signals a script can aim at its own process group, which this process
 * leads in bash mode. Held in `heldSignals` rather than acted on: see
 * `holdGroupSignals`.
 */
const GROUP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

const heldSignals = new Set();

/**
 * What a stray carriage return is named on disk. Windows is the one platform
 * where a CRLF checkout happens, and there bash is msys2 — a Cygwin fork, which
 * cannot put an ASCII control character in a file name and transposes it into
 * the private-use block instead. So the file the shell created is
 * `output.json` + U+F00D there and `output.json` + U+000D everywhere else, and
 * a check for only one of them misses on the very platform it is for.
 */
const STRAY_SUFFIXES = ["\r", "\uF00D"];

/**
 * How both exchange files are opened. `O_NONBLOCK` closes the window the check
 * above leaves: a named pipe put there between the `stat` and the `open`
 * answers at once instead of parking this thread on a writer that never comes.
 * It is a no-op on a regular file, and absent on a platform that has no such
 * flag.
 */
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

/**
 * How long bash's death by a signal waits for the SAME signal to arrive here,
 * before it is read as one from outside the group. `kill 0` reaches every
 * member of the group at one syscall, so the signal is already pending on this
 * process when bash's exit is seen; what varies is when libuv's own signal
 * watcher next gets a turn. Measured at up to 17 ms on a loaded machine, and
 * held under the parent's own stop grace so a runner that is waiting still
 * answers before the parent's SIGKILL lands on the group.
 */
const GROUP_SIGNAL_SETTLE_MS = 1_000;

const ENTRY_SETTLE_PROBE_MS = 1_000;

/**
 * In step with `flow-script-protocol.ts`, which this file cannot import. An IPC
 * message is deserialized whole into the parent's heap before anything can
 * inspect it, so only the sender can bound script-controlled failure text.
 */
const MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
const MAX_FAILURE_STACK_CHARS = 16 * 1024;

/**
 * What a bash step's `$ARGENT_REASON` may take of the message it rides in, with
 * the rest left for the exit line, the exit-code hint and the marker itself.
 */
const MAX_REASON_CHARS = MAX_FAILURE_MESSAGE_CHARS - 1024;

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
 */
const channelHandle = /** @type {{ fd?: number } | undefined} */ (
  /** @type {unknown} */ (process.channel)
);
const channelFd = typeof channelHandle?.fd === "number" ? channelHandle.fd : -1;

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
 * Every pattern and separator the functions below read, declared ABOVE the
 * activation call rather than beside its reader.
 *
 * `await prepare()` suspends this module's evaluation, and in bash mode
 * `prepare` never returns — it parks in `never()` so no entry module can load
 * behind the verdict — so a `const` written after that line stays in its
 * temporal dead zone for the life of the process. `errorMessage` is reached
 * from bash mode's very first failure (a bash that would not start), and
 * reading `CAUSED_BY` from there threw a ReferenceError that replaced the
 * report with an exit code 1 the parent could only call `protocol`. Node mode
 * had the same hazard on its own decode-failure path.
 */
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
  } catch (err) {
    finish({
      type: "failure",
      failureType: "protocol",
      message: `The script runner could not decode the flow output it was given: ${errorMessage(err)}`,
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
 * Bash mode: bash is an ordinary child of this process, and this process leads
 * the group both watchdogs kill — so the parent's group stop, the deadline
 * watchdog's kill and the lifeline watchdog's kill all reach a bash descendant
 * with no new code, and the parent classifies a bash step through exactly the
 * `classifyOutcome` a `.mjs` step goes through.
 */
function runBash(request) {
  bashMode = true;
  holdGroupSignals();
  // Registered here for the reason node mode registers it here: Node references
  // the IPC channel while a `disconnect` listener exists.
  keepListener("disconnect", exitOnParentDisconnect);

  let child;
  // In this process, 3 is the parent's sink, 4 is the lifeline and 5 is the
  // protocol channel. A bash `echo … >&5` landing on the protocol channel would
  // be parsed by Node inside its own read callback in the parent, and a forged
  // `result` line would be a forged verdict. Node marks every descriptor it
  // inherited close-on-exec at startup, so `"ignore"` in those slots happens to
  // close them — but that is a runtime startup detail, not a contract this may
  // rest on. Three null devices make the guarantee this process's own, on every
  // platform. One descriptor in three slots would be closed three times in the
  // child, which works and should not be relied on.
  const nulls = [];
  try {
    for (let slot = 0; slot < 3; slot++) nulls.push(fs.openSync(os.devNull, "r+"));
    // Before the spawn, and written straight to the channel rather than queued
    // behind a turn of the loop. `spawn` forks and execs, so the script's first
    // line runs while this process is still returning from the call — and a
    // script that kills the runner there ("`kill -9 $PPID`", or a group kill)
    // beat every later placement about one run in fifty, leaving the parent to
    // report a script that had already run as one that never started.
    //
    // Claiming it early costs nothing: a spawn that then fails sends a terminal
    // `spawn` failure, which the parent prefers over this, and a runner that
    // dies between the two is reported as the signal it was — the answer that
    // tells the caller its script may have left work behind, which is the
    // conservative one.
    announceStarted();
    child = spawn(request.interpreterPath, [request.scriptPath], {
      // The parent chose it, and it built this process's environment: the
      // allowlist, minus the activation flag this file deleted before anything
      // else ran, minus the `NODE_CHANNEL_FD` Node removes at its own startup.
      // The two exchange names are all this side adds.
      cwd: process.cwd(),
      env: {
        ...process.env,
        ARGENT_OUTPUT: request.outputFile,
        ARGENT_REASON: request.reasonFile,
      },
      // `bash <file>`, never `shell: true` and never the shebang: a path with a
      // space or a `$` must reach bash as one argument, the file needs no
      // execute bit, and honouring a `#!` would run an interpreter other than
      // the one the step resolved, reports and lets an operator pin. No `-e` or
      // `-u` either — strictness is the script's own `set -euo pipefail`.
      //
      // stdin is the null device, so a `read` gets end of file; there is no
      // caller to answer it. stdout and stderr are this process's pipes, which
      // the parent drains and discards.
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
    // One of the two is always non-null for a process that really ran, so both
    // null is a spawn that failed — and Node says `exit` "may or may not"
    // follow `error` there. Reading it as an exit code of 0 would send the
    // parent a document nothing wrote; the `error` handler above is what
    // reports it, and the deadline watchdog bounds a spawn that reported
    // neither.
    if (code === null && signal === null) return;
    // A signal that reached bash reached this process in the same instant when
    // it was aimed at the group, and `heldSignals` is what the report names it
    // by — so the answer waits for it to arrive.
    if (signal) whenGroupSignalHeld(signal, () => finish(bashOutcome(request, code, signal)));
    else finish(bashOutcome(request, code, signal));
  });
  return never();
}

/**
 * Take the group's signals away from Node's default, which is to end this
 * process. `trap 'kill 0' EXIT` is the standard bash idiom for reaping
 * background jobs, and `kill 0` means "signal my own process group" — the group
 * this process leads and bash joined, so it arrives here too. Ended here, the
 * runner dies before it can read `$ARGENT_OUTPUT` or send a verdict, and the
 * parent reports the SIGTERM on ITS child as an unexplained one: "the script
 * process was killed … it did not stop itself", about a process the script
 * never chose to run.
 *
 * Held rather than answered, because bash received the same signal and its own
 * exit is the verdict either way. Nothing is left holding the process open: the
 * parent's stop escalates to a SIGKILL on the group, and the deadline watchdog
 * bounds the run from inside.
 *
 * The EXIT trap is the only spelling this can see. A `kill 0` in the BODY of
 * the script — with bash still to run the rest of it — reaches bash alone:
 * measured on macOS, neither this process nor a plain `sleep` in the same group
 * received the signal, and the same `kill 0` under a `trap "" TERM` that makes
 * bash survive it reached both. So the signal a script sends itself is only
 * observable here when it does not kill its own sender, and `bashOutcome` says
 * so in the message it prints for the case this set is empty for.
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
 * Run `report` once `signal` is one this process holds, or once the window
 * above has passed without it.
 *
 * One turn of the loop was not enough. The signal and the child's exit both
 * arrive through libuv's signal pipe and the exit routinely wins, so a
 * `setImmediate` — a callback in the SAME iteration — read `heldSignals` before
 * the holding handler had run. `trap 'kill 0' EXIT` is the idiom the split
 * exists for, and it landed on either side of the fail/error line from run to
 * run: about one run in thirty on an idle machine, more under load.
 *
 * A listener rather than a poll, so the wait ends the instant the signal lands.
 * The holding listener was registered first and so runs first, which is what
 * leaves `heldSignals` correct for the report this hands off to.
 */
function whenGroupSignalHeld(signal, report) {
  if (heldSignals.has(signal) || !GROUP_SIGNALS.includes(signal)) {
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
  const timer = setTimeout(settle, GROUP_SIGNAL_SETTLE_MS);
  try {
    process.on(signal, settle);
  } catch {
    // A platform that does not know the name; the timer is the whole wait.
  }
}

/**
 * `started`, on the channel before this call returns. `process.send` only
 * queues, and the window between the queueing and the write is exactly what a
 * script's first line can end this process inside of.
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
 * The exit status is the whole verdict. A `128+N` status is bash reporting a
 * foreground command killed by signal N, and it is read as the script's own
 * exit code — the script chose to run that command and could have handled its
 * status — so it stays a `fail` and the message does not try to decode it. A
 * signal on THIS child is a different thing: nothing the script did.
 */
function bashOutcome(request, code, signal) {
  if (signal) {
    // A signal this process received too went to the group rather than to bash,
    // and the group is the step's own: nothing outside it knows the number.
    // That is the script's answer, not something the host did to it, so it is
    // an `exit` — the kind that reads "it stopped its own process".
    if (heldSignals.has(signal)) {
      return {
        type: "failure",
        failureType: "exit",
        message:
          `The step's process group was sent ${signal}, which killed bash before it exited ` +
          `(bash: ${request.interpreterPath}), so the step returned no output document. ` +
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
        // The other spelling of the mistake above. A `kill 0` in the body of
        // the script kills bash and reaches nothing else — not this process,
        // which is what the branch above reads a group signal by — so the two
        // causes arrive here identically and the message names both.
        (GROUP_SIGNALS.includes(signal)
          ? " A `kill 0` in the body of the script ends bash the same way and is not " +
            "distinguishable from this: signal each job's own pid instead."
          : ""),
    };
  }
  const status = code ?? 0;
  if (status !== 0) {
    const reason = readReasonFile(request.reasonFile);
    return {
      type: "failure",
      failureType: "exit",
      message:
        `The script exited with code ${status} (bash: ${request.interpreterPath}).` +
        exitCodeHint(status) +
        (reason ? ` ${reason}` : ""),
    };
  }
  const read = readOutputFile(request.outputFile, request.maxOutputBytes);
  // Only where there is something to explain: the document Argent read is the
  // one it seeded, or there is no document at all. A script that writes
  // `$ARGENT_OUTPUT` correctly and also happens to leave a `\r` sibling behind
  // is not a CRLF script, and its document is not the parent's to throw away.
  if (read.error || read.json === request.outputJson) {
    const strayed = carriageReturnProblem(request);
    if (strayed) return { type: "failure", failureType: "output", message: strayed };
  }
  return read.error
    ? { type: "failure", failureType: "output", message: read.error }
    : { type: "result", outputJson: read.json };
}

/**
 * The one CRLF symptom that is silent. A `.sh` checked out with CRLF line
 * endings carries the carriage return into the last word of every line, so
 * `> "$ARGENT_OUTPUT"` writes `output.json\r` and the file the parent reads is
 * still the one it seeded: exit code 0, and a document nothing wrote. The name
 * is the proof — the parent created these two files and nobody else may name
 * one with a carriage return after it.
 *
 * Asked only where the document is missing or unchanged, because this explains
 * THAT and nothing else. A stray sibling beside a document the script really
 * wrote is not this, and a mixed-ending script is the only kind that ever gets
 * here: a fully CRLF one dies at `set -euo pipefail\r` with exit 2.
 */
function carriageReturnProblem(request) {
  for (const [name, file] of [
    ["$ARGENT_OUTPUT", request.outputFile],
    ["$ARGENT_REASON", request.reasonFile],
  ]) {
    if (!STRAY_SUFFIXES.some((suffix) => fs.existsSync(`${file}${suffix}`))) continue;
    return (
      `the script wrote to a file one carriage return past the one ${name} names, so the ` +
      "document Argent read is the one it seeded: the script has CRLF line endings, and the " +
      "carriage return ends every line inside the word before it. Convert the file to LF " +
      "(`*.sh text eol=lf` in .gitattributes)"
    );
  }
  return null;
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
 * The document, after exit 0. One bounded read of `maxOutputBytes + 1` bytes:
 * the text becomes one IPC message the parent deserializes whole, and a `stat`
 * first would leave the read itself unbounded against a descendant still
 * writing. The parent parses and validates it exactly as it does a `.mjs`
 * script's — `encodeOutput` is for a live JavaScript value and JSON text is not
 * one.
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
    return { json: buffer.subarray(0, read).toString("utf8") };
  } catch (err) {
    return { error: `the file named by $ARGENT_OUTPUT could not be read: ${errorMessage(err)}` };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The failure text, read only on a non-zero exit. Four bytes per character is
 * the widest the ceiling can be, and the cut lands on a UTF-8 boundary so a
 * character split by the bound does not arrive as a replacement.
 *
 * The reason is clamped HERE, below the ceiling `finish` applies to the whole
 * message, so that the exit line in front of it is not what pays for a long
 * one — and so that `clampText` never fires on this path. Its marker counts the
 * characters of the string it was handed, and a bounded read is not the file:
 * a script writing five million characters was told 24,671 had been omitted.
 * The size of the file is knowable, so that is what the marker says.
 */
function readReasonFile(file) {
  if (irregularFileKind(file)) return "";
  let fd;
  try {
    fd = fs.openSync(file, READ_FLAGS);
  } catch {
    // Never written, or the script removed it. A failed step that wrote no
    // reason says only its exit code.
    return "";
  }
  try {
    const keep = MAX_REASON_CHARS * 4;
    const buffer = Buffer.alloc(keep + 4);
    const read = readInto(fd, buffer, buffer.length);
    const text = buffer
      .subarray(0, utf8SafeCut(buffer, Math.min(read, keep)))
      .toString("utf8")
      .trim();
    if (text.length <= MAX_REASON_CHARS && read <= keep) return text;
    return `${text.slice(0, MAX_REASON_CHARS)}… [${reasonSize(fd)}; this report keeps the first ${MAX_REASON_CHARS} characters]`;
  } catch {
    return "";
  } finally {
    fs.closeSync(fd);
  }
}

function reasonSize(fd) {
  try {
    return `$ARGENT_REASON holds ${fs.fstatSync(fd).size} bytes`;
  } catch {
    return "$ARGENT_REASON holds more";
  }
}

/**
 * What is at `file`, when it is not the regular file the parent created there.
 * Asked BEFORE the open, because `open` on a named pipe with no writer blocks
 * on this thread — inside the exit handler, where the runner holds SIGTERM, so
 * the parent's graceful stop cannot reach it either. A script that failed in
 * ten milliseconds was reported as having spent its whole time limit.
 *
 * The link is followed: the parent's own file is a regular one, so a symlink
 * here is the script's, and one pointing at a regular file is a document like
 * any other. `stat` never blocks, whatever it lands on.
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

/** In step with the parent's copy, which this file cannot import. */
function utf8SafeCut(buffer, max) {
  let cut = Math.min(max, buffer.length);
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  return cut;
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
 * In bash mode a bare exit would leave bash — and everything bash started —
 * running under a runner that is gone, so this takes the group first. The four
 * lines are in step with the lifeline watchdog's `stop`, which is a module
 * constant on the worker's own thread and so cannot be called from here.
 */
function exitOnParentDisconnect() {
  if (!bashMode) {
    realExit(0);
    return;
  }
  stopOwnGroup();
  process.kill(process.pid, "SIGKILL");
}

/**
 * In step with both watchdogs' `stop`. On Windows there is no group to name, so
 * `taskkill /t` walks the live tree from this process down — which reaches
 * bash and a `.mjs` script's own subprocesses alike, neither of which anything
 * reached there before.
 */
function stopOwnGroup() {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch {
    // No process group to name (Windows, or a runner that never led one).
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(process.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      // taskkill is absent or could not be launched; the self-kill is what is
      // left, and it is the outcome this call never returns from anyway.
    }
  }
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

/**
 * The protocol carries no version field, so an absent `interpreter` means the
 * pre-2.7 shape — node. The loader resolves whichever runner sits beside the
 * compiled executor, so an older parent really can reach this file.
 */
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
  if (typeof raw.reasonFile !== "string" || raw.reasonFile === "") return null;
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
  start(new URL(DEADLINE_WATCHDOG, here), { deadlineMs });

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
 * so a function or `undefined` vanishes silently, `NaN` and `Infinity` arrive
 * as `null`, and a BigInt or cycle throws inside `send`.
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
  return walk(root, "output", new Set());
}

function walk(value, path, ancestors) {
  if (value === null) return { value: null };
  const type = typeof value;
  if (type === "string" || type === "boolean") return { value };
  if (type === "number") {
    return Number.isFinite(value)
      ? { value }
      : { problem: `${path} is ${describeValue(value)}; output numbers must be finite` };
  }
  if (type !== "object") {
    return { problem: `${path} is ${describeValue(value)}; output must be JSON-compatible data` };
  }
  // Ancestors only, not every value seen: a value referenced twice in different
  // branches encodes fine; only a reference back *up* the tree cannot.
  if (ancestors.has(value)) {
    return { problem: `${path} is a cyclic reference; output must be a tree` };
  }

  if (Array.isArray(value)) {
    ancestors.add(value);
    const copy = [];
    for (let i = 0; i < value.length; i++) {
      // A hole is not `undefined` written by the author: `JSON.stringify`
      // encodes it as null, and rejecting it would name an index nobody wrote.
      const walked = walk(i in value ? value[i] : null, `${path}[${i}]`, ancestors);
      if (walked.problem) return walked;
      copy.push(walked.value);
    }
    ancestors.delete(value);
    return { value: copy };
  }
  if (value instanceof Date) {
    // Before the `toJSON` branch, which a Date would otherwise take: it encodes
    // to a string a later step cannot read back as a date.
    return {
      problem: `${path} is a Date; output must be JSON-compatible data (use an ISO string)`,
    };
  }
  if (typeof value.toJSON === "function") {
    // Recorded first, because the transform is a route back up the tree the
    // author cannot see: `{ toJSON() { return this; } }` would otherwise
    // recurse until V8 gave up, and report a stack overflow in place of the
    // path the cycle is on.
    ancestors.add(value);
    const walked = walk(value.toJSON(), path, ancestors);
    ancestors.delete(value);
    return walked;
  }
  if (!isPlainObject(value)) {
    return { problem: `${path} is ${describeValue(value)}; output must be JSON-compatible data` };
  }
  ancestors.add(value);
  const copy = {};
  for (const key of Object.keys(value)) {
    if (key === "__proto__") {
      // `JSON.parse` creates this as an own key, so a parsed body would carry
      // it into flow state, where a later `Object.assign` writes a prototype
      // rather than a property.
      return {
        problem: `${path} has an own "__proto__" key; output must be JSON-compatible data`,
      };
    }
    const walked = walk(value[key], `${path}${memberPath(key)}`, ancestors);
    if (walked.problem) return walked;
    copy[key] = walked.value;
  }
  ancestors.delete(value);
  return { value: copy };
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
