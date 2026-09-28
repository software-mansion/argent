// Imports nothing from the tool-server, so it needs no build step: it is copied
// next to the compiled executor and resolves its watchdogs against its own URL.

import fs from "node:fs";
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
 */
function exitOnParentDisconnect() {
  realExit(0);
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

function parseRequest(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  if (raw.type !== "execute") return null;
  if (typeof raw.scriptUrl !== "string") return null;
  if (typeof raw.outputJson !== "string") return null;
  if (!Number.isFinite(raw.deadlineMs) || raw.deadlineMs <= 0) return null;
  if (!Number.isFinite(raw.maxOutputBytes) || raw.maxOutputBytes <= 0) return null;
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

const POSIX_ERRNO_RE = /^E[A-Z]+$/;

/** Node's module loader, ESM and CommonJS alike. */
const LOADER_FRAME_RE = /node:internal\/modules\//;

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

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

const MAX_CAUSE_DEPTH = 8;
const CAUSED_BY = " — caused by: ";
const ALSO = "; ";

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
