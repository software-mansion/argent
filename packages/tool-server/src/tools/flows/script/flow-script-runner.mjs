// The flow `script` step's runner: a preload the executor puts in front of the
// script with `node --import <this file> <script>`.
//
// The script is the process's **entry module**, not something this file
// imports. That is what makes the process behave like `node script.mjs`:
// `process.argv[1]` is the script, `require.main` is the script's own module in
// CommonJS, `import.meta.main` answers whatever it answers under plain `node`
// on this version — true from Node 24, `undefined` on 20 and 22 — and the event
// loop runs until it empties. A script written with the ordinary `if (this is
// the main module) main()` guard therefore runs its body, where an imported
// script silently skipped it and reported a green pass.
//
// A preload is what buys that while still giving the script an `output` global
// and the executor a verdict: `--import` is awaited before the entry module
// loads, so the handshake below completes first, and this file keeps the send
// point the entry module cannot have.
//
// This file imports nothing from the tool-server, so it needs no build step —
// it is copied next to the compiled executor and resolves its two watchdogs
// against its own module URL.

import { isMainThread, Worker } from "node:worker_threads";

const LIFELINE_WATCHDOG = "flow-script-watchdog-lifeline.mjs";
const DEADLINE_WATCHDOG = "flow-script-watchdog-deadline.mjs";

/**
 * The executor sets this for the one process it starts, and the preload clears
 * it before the script runs.
 *
 * `--import` is inherited twice over: a worker thread the script starts gets
 * it, and so does a `child_process.fork` from the script, which passes the
 * parent's `execArgv` on by default. Either would park inside the handshake
 * below waiting for a request that is never coming, and the script would hang
 * on its own worker. `isMainThread` covers the thread case; clearing the
 * variable covers the process case, because a child's environment is copied at
 * spawn time.
 */
const ACTIVATION_ENV = "ARGENT_FLOW_SCRIPT_RUNNER";

/** One terminal message per process; see `finish`. */
let finished = false;

/** The encoded-output ceiling from the request, read again at `beforeExit`. */
let maxOutputBytes = 0;

/** One outcome probe per process; `beforeExit` can fire more than once. */
let probing = false;

/**
 * The event loop with nothing the script put in it: the two standard-stream
 * pipes, measured rather than named. The IPC channel and both watchdog workers
 * are unreferenced by the time it is read, so Node does not count them. Set at
 * the end of `prepare`, which is the last point before the script loads.
 */
let idleResources = [];

/** Set only while the runner itself is on the channel. See `closeChannelToScript`. */
let runnerIsSending = false;

/** How long the entry module gets to prove it finished. See `reportWhenEntrySettled`. */
const ENTRY_SETTLE_PROBE_MS = 1_000;

/**
 * Ceilings on the free text of a failure, in step with `flow-script-protocol.ts`
 * (this file imports nothing from the package, so it carries its own copy). An
 * error message is script-controlled and an IPC message is deserialized whole
 * into the parent's heap before anything can inspect it, so the sender is the
 * only side that can bound it: a `throw new Error(\`Unexpected response:
 * \${await res.text()}\`)` put 8 MiB through the channel and into the result.
 */
const MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
const MAX_FAILURE_STACK_CHARS = 16 * 1024;

/**
 * The real `process.send`, taken while this preload is the only code that has
 * run. Everything the runner reports goes through it rather than through
 * whatever `process.send` names later: a script that replaces or deletes the
 * property — a test double, a stub for a dependency that pings its parent —
 * silently took the verdict with it, and a step that had done all of its work
 * and set its output was reported as having stopped its own process.
 */
const realSend = typeof process.send === "function" ? process.send : undefined;

/** The real `process.exit`, so the runner's own exits skip the guard below. */
const realExit = process.exit.bind(process);

/**
 * `JSON.stringify` and `JSON.parse` as they were before any script code ran.
 *
 * The output document is validated and then encoded, and reading the encoder
 * off the global at that point handed the step's whole result to whatever the
 * script's dependency tree had installed there — an instrumentation shim, a
 * polyfill, a serialization wrapper. A patched `JSON.stringify` committed a
 * document the script never wrote, and one returning `{"__proto__":…}` walked
 * an own key past the validator that exists to reject it. A script is trusted,
 * so this is not containment: it is the same rule the parent follows for the
 * byte limit, that a verdict must not depend on the process staying compliant
 * after arbitrary code has run inside it.
 */
const encodeJson = JSON.stringify;
const decodeJson = JSON.parse;

/**
 * The listeners the runner cannot lose. `process.removeAllListeners()` with no
 * arguments is ordinary cleanup code, and it took the `beforeExit` probe with
 * it — after which a script that finished normally simply exited, and the step
 * was reported as self-termination.
 */
const runnerListeners = [];

if (isMainThread && process.env[ACTIVATION_ENV] === "1") {
  delete process.env[ACTIVATION_ENV];
  await prepare();
}

/**
 * Everything that has to be true before the script's first line runs.
 *
 * Node awaits this module's evaluation before it loads the entry module, so
 * the `output` global, the watchdogs and the crash handlers are all in place
 * by then — and a request that never arrives parks here rather than running a
 * script the executor cannot report on.
 */
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

  // A crash the script raises — a module that never parsed, a throw at the top
  // level, a rejected promise nobody awaited, a throw inside a timer callback —
  // would otherwise end the process before it could report anything. Node's
  // default is to print the error and exit 1, which reaches the executor as
  // "the script stopped its own process", naming an exit code the author never
  // wrote and losing the error itself. Claim it and report what it was. An
  // unhandled rejection arrives here too: Node raises it as an uncaught
  // exception unless an `unhandledRejection` listener claims it first.
  keepListener("uncaughtException", (err) => {
    // Unless the script has a handler of its own, in which case it is the one
    // recovering and this one is in its way. Node does not end a process that
    // has an `uncaughtException` listener, so under plain `node` such a script
    // carries on and finishes; claiming the error unconditionally failed the
    // step with an error the script had already dealt with — its own log line
    // saying so, right beside the verdict. This handler is registered before
    // the script loads, so it runs first and a second listener can only be the
    // script's. The mirrored `unhandledRejection` case needs nothing: Node
    // routes a rejection here only when the script claimed neither.
    if (process.listenerCount("uncaughtException") > 1) return;
    finish({
      type: "failure",
      failureType: classifyScriptError(err),
      message: errorMessage(err),
      stack: errorStack(err),
    });
  });

  // The script is done when the event loop empties — the same point at which
  // `node script.mjs` would leave, so a timer, a callback-style read and a
  // floating `main()` have all finished. A script that leaves a handle open
  // never reaches it and would not have exited under plain `node` either; the
  // step's time limit is what bounds that.
  //
  // `beforeExit` can fire more than once and does not fire at all after an
  // explicit `process.exit`. The first is handled by `finish` reporting once;
  // the second is the executor's `exit` verdict, which is the right one.
  //
  // Every firing is spent yielding, because this handler was registered before
  // the script loaded and therefore runs before the script's own. A
  // `beforeExit` handler that schedules cleanup — `setTimeout(() => fs.writeFileSync(…))`
  // is the ordinary shape — had that work thrown away, and one that threw after
  // an `await` was swallowed while the step still passed; plain `node` writes
  // the file and exits 1 respectively.
  //
  // The yield keeps the loop alive past this round; what the script's handlers
  // scheduled during it is then what decides. Anything at all, and the round
  // belongs to the script: the loop runs it, empties again, and `beforeExit`
  // comes round once more — exactly the loop plain `node` runs, so a
  // `beforeExit` retry that needs three attempts gets three. Spending a fixed
  // number of rounds instead gave a handler one, and a script whose third
  // attempt was the one that set the output reported a green pass with an empty
  // document, its own log showing the attempt it never completed.
  keepListener("beforeExit", () => {
    if (finished || probing) return;
    setImmediate(() => {
      if (finished || probing) return;
      // Read after the yield, not during the emission: the handlers have all
      // run by now, and so have the microtasks an `async` one queued. The yield
      // itself is the callback running, and Node does not count that.
      if (scriptScheduledWork()) return;
      probing = true;
      reportWhenEntrySettled(request.scriptUrl);
    });
  });

  closeChannelToScript();

  // Registered here rather than at module scope because Node references the IPC
  // channel for as long as a `message` or `disconnect` listener exists. In an
  // inactive preload — the copy a `child_process.fork` from the script
  // inherits — that reference alone kept the script's own child alive after its
  // work was done, and the step ran to its time limit.
  keepListener("disconnect", exitOnParentDisconnect);
  guardRunnerListeners();
  reportOnScriptExit();

  // Load-bearing. This is the only thing that lets the executor tell "the
  // runner never began the script" apart from "the script stopped its own
  // process".
  sendToParent({ type: "started" });

  // The IPC channel is a live handle, so the event loop is never empty while it
  // counts and `beforeExit` above would never fire. Unreferencing only removes
  // it from the loop's liveness count — the channel stays open and
  // `process.send` still works.
  if (process.channel && typeof process.channel.unref === "function") {
    process.channel.unref();
  }

  // Read last, so it is the loop as the script inherits it and nothing the
  // script scheduled is in it. Node awaits this module before it loads the
  // entry, so there is no earlier or later point that holds. See
  // `scriptScheduledWork`.
  idleResources = process.getActiveResourcesInfo();
}

/**
 * Whether anything the script's `beforeExit` handlers just scheduled is still
 * pending.
 *
 * Counted per kind against the idle loop rather than compared by length: a
 * script is free to close a standard stream — `process.stdout.end()` — and one
 * that does while also scheduling work would otherwise come out even.
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
 * An empty event loop is not proof that the script finished: a top-level
 * `await` that never settles leaves nothing to run either, and reading `output`
 * there would report a green pass for a script stopped halfway.
 *
 * Importing the entry module again is what tells the two apart. Node caches it
 * by URL, so a module that finished evaluating resolves from the cache without
 * running a second time, while one still parked inside a top-level `await`
 * awaits the very promise that is not settling. The executor sends the same
 * real path Node resolved the entry from, so this is always the cache entry and
 * never a second evaluation. A rejection counts as settled: the script threw,
 * and `uncaughtException` above has already reported it.
 *
 * The timer both holds the loop open while the probe runs — without it the
 * process could leave before a cache hit resolves — and bounds the wait, so an
 * unsettled script is reported in about a second instead of occupying its slot
 * until the step's time limit.
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
    // `try { await main() } catch (e) { console.error(e); process.exitCode = 1 }`
    // is the recommended way to fail a script — preferred over `process.exit(1)`
    // precisely because it does not truncate stdout — and the exit code is the
    // script saying it failed. Reading the verdict off the IPC message alone
    // threw that away and reported the step as passing.
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
    // may mutate the object (`output.user = user`) or replace the binding
    // (`output = { user }`, which resolves to this global property), and both
    // are legal.
    const encoded = encodeOutput(globalThis.output, maxOutputBytes);
    finish(
      encoded.error
        ? { type: "failure", failureType: "output", message: encoded.error }
        : { type: "result", outputJson: encoded.json }
    );
  };
  import(scriptUrl).then(report, report);
}

/** Register a process listener the runner needs, and remember it. */
function keepListener(event, handler) {
  runnerListeners.push({ event, handler });
  process.on(event, handler);
}

/**
 * Put back any of the runner's own listeners a script removes.
 *
 * `process.removeAllListeners()` is ordinary cleanup code — a test harness
 * between cases, a library tearing down its own handlers — and with no argument
 * it takes every listener on the process, the runner's included. Losing the
 * `beforeExit` probe means a script that finished all of its work and set its
 * output simply exits, and the executor reports self-termination.
 *
 * Re-registering inside the call keeps the runner's handler first, which is
 * where it was: `beforeExit` yields to the script's handlers before probing,
 * and `uncaughtException` checks for a handler of the script's own.
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
 * Read the output document when a script ends the process itself successfully.
 *
 * `main().then(() => process.exit(0))` is a very common idiom, and it was a
 * hard failure: `beforeExit` does not fire after an explicit exit, so the
 * runner never reported, and the parent said "the script stopped its own
 * process ... no output was captured" about a script whose log proved the work
 * was done and whose `output` was set. Exiting with zero *is* the script
 * declaring success, so the document it had is the document it meant.
 *
 * A non-zero exit is left alone: that is the script reporting its own failure,
 * and the parent's `exit` verdict already names the code.
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
      // Forwarded by arity, not by value: `realExit(undefined)` is not the same
      // call as `realExit()`, and the difference is whether a `process.exitCode`
      // the script set survives.
      return realExit(...args);
    }
  );
}

/**
 * Take the protocol channel away from the script.
 *
 * `fork` leaves a working `process.send` in the child, and the executor trusts
 * whatever arrives on it. A script that pings its parent on startup — the
 * readiness ping a file written to double as a forked worker sends, directly or
 * through a dependency — tore down a healthy run and blamed the runner for a
 * message it never sent; feature detection (`if (process.send)`) steers a
 * script straight into it, and under plain `node` the same detection is a
 * no-op. A script could also send a well-formed `result` and replace its own
 * verdict with one the executor has no way to question.
 *
 * The channel stays open — the runner still needs it — but only the runner may
 * use it. Script code gets a `send` that accepts and drops, which is what "a
 * channel with nobody listening" should look like, and a `disconnect` that
 * leaves the channel alone, since closing it would leave the run with no way to
 * report at all.
 *
 * Both stubs still have to *answer* the way Node does. A guard that only
 * swallows is a guard that hangs: `await new Promise((r) => process.send(m, r))`
 * and `process.disconnect()` followed by waiting for the `disconnect` event are
 * both ordinary code, reached by the very feature detection this guard exists
 * for, and a script parked on either one empties its event loop — so the step
 * ends as a pass carrying whatever half-written document the script had reached.
 */
function closeChannelToScript() {
  // `_send` is Node's undocumented implementation behind `send`, and not on the
  // public type — but a script can reach it by name, so it is guarded too.
  const host = /** @type {{ _send?: Function }} */ (/** @type {unknown} */ (process));
  const realLowLevelSend = host._send;
  // `send` calls `this._send`, so both names are guarded by the one flag rather
  // than replaced — the runner's own call sets it for the length of that call.
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
    // Node emits `disconnect` once the channel is closed. Nothing is closed
    // here, so the runner's own handler is skipped — the parent has not gone
    // anywhere — but the event still has to reach the script's listeners.
    for (const listener of process.listeners("disconnect")) {
      if (listener === exitOnParentDisconnect) continue;
      setImmediate(() => listener.call(process));
    }
  };
}

/**
 * Call a `process.send` callback the way Node always would: asynchronously,
 * with no error. It is the last argument of both `send(message[, handle[,
 * options]][, callback])` and the `_send` behind it.
 */
function acknowledge(args) {
  const callback = args[args.length - 1];
  if (typeof callback === "function") setImmediate(() => callback(null));
}

/**
 * The parent going away ends the run. A convenience for a runner whose event
 * loop is still turning — a synchronous infinite loop never reaches it, which
 * is what the lifeline watchdog thread is for.
 */
function exitOnParentDisconnect() {
  realExit(0);
}

/** The one `execute` request. A second message is ignored rather than obeyed. */
function nextRequest() {
  return new Promise((resolve) => {
    process.once("message", resolve);
  });
}

/**
 * Park forever. Used after a verdict that must not be followed by the script
 * running: `finish` exits from inside a stream callback, so returning here
 * would let Node load the entry module in the meantime.
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
 * Two worker threads, started before the script loads.
 *
 * A worker thread is a real OS thread, so a blocked main thread cannot starve
 * it, and `process.kill` on the runner's own pid stops the whole process —
 * which is the point, because a synchronous infinite loop is the whole reason
 * this runs in a child process at all. Both are unref'd so they never hold the
 * process open; an empty script still exits in tens of milliseconds.
 *
 * One thread cannot do both duties, and the reason is the deadline's, not the
 * lifeline's: `Atomics.wait` blocks its thread outright for the whole time
 * limit, so a lifeline sharing it would not notice the parent going away until
 * the deadline had already passed. The lifeline itself does not block — it
 * waits on socket events.
 */
function startWatchdogs(deadlineMs) {
  const here = import.meta.url;
  start(new URL(LIFELINE_WATCHDOG, here));
  start(new URL(DEADLINE_WATCHDOG, here), { deadlineMs });

  function start(url, workerData) {
    try {
      // `execArgv: []` keeps this preload out of the worker: a worker
      // inherits the process's own `execArgv`, and re-running this file on a
      // watchdog thread would load it for nothing.
      const worker = new Worker(url, { execArgv: [], ...(workerData ? { workerData } : {}) });
      // A watchdog that cannot start must not take the run with it: the parent
      // keeps its own copy of the time limit, so the step is still bounded.
      // It does have to be visible, though — the missing file is otherwise
      // silent at runtime and only a build check would ever catch it.
      worker.on("error", (err) => reportWatchdogProblem(url, err));
      worker.unref();
    } catch (err) {
      reportWatchdogProblem(url, err);
    }
  }
}

/** One line on stderr, the same way the lifeline reports an unusable fd. */
function reportWatchdogProblem(url, err) {
  try {
    const name = url.href.slice(url.href.lastIndexOf("/") + 1);
    process.stderr.write(`[argent] script watchdog ${name} unavailable: ${errorMessage(err)}\n`);
  } catch {
    // Reporting must never be what ends the run.
  }
}

/**
 * Which side of the load boundary failed.
 *
 * What a report needs is "the file never ran" versus "your code threw". The
 * module codes below are the reliable half. The other two rows exist because
 * the same error class reaches this function from both sides:
 *
 * - A `SyntaxError` is a module that would not parse *or* `JSON.parse` of an
 *   HTML error page — the canonical script failure, "the endpoint returned
 *   HTML" — and telling that author their file never evaluated sends them to
 *   the wrong place entirely.
 * - A POSIX errno from the loader (`chmod 000` on the script) is a file that
 *   never opened, and calling it "your code threw" is the same mistake
 *   mirrored.
 *
 * The loader leaves its own frames on the stack, and that is what tells the two
 * apart. Asking instead whether *no* file frame is present read absence as
 * proof: an error raised asynchronously carries the frames of wherever it was
 * constructed, which for `fs.readFile("/nope", cb)` is nothing at all and for
 * `await res.json()` is undici — so a script's own I/O failure was reported as
 * "the module never evaluated", and the same call flipped verdict on whether it
 * was awaited. `Error.stackTraceLimit = 0`, which any dependency may set, made
 * even a plain synchronous throw look like a load failure.
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
 * Whether the stack says Node's module loader is what failed.
 *
 * A loader frame with no frame naming a file above it: the loader was reading,
 * parsing or resolving, and nothing the script owns had run yet. A frame naming
 * a file settles it the other way whatever else is on the stack — a top-level
 * throw carries `ModuleJob.run` under the script's own frame — and a stack with
 * no loader frame at all is not evidence of anything, which is the answer for
 * an error raised asynchronously or with no frames at all. A `node:` frame is
 * internal however it is written: some carry the function name in parentheses
 * and some do not.
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
 * Validate the output document, then encode what was validated.
 *
 * Validation cannot happen in the parent. The IPC channel serializes as JSON,
 * so it changes the value before the parent ever sees it: a function and an
 * `undefined` vanish with no error, `NaN` and `Infinity` arrive as `null`, and a
 * BigInt or a cyclic value throws inside `send` — so the parent sees a crash
 * rather than a verdict. A silent `null` is worse than a rejection, because the
 * flow keeps running on a value the script never wrote.
 *
 * What is encoded is the copy the walk built, not the live object read a second
 * time. Reading twice is what let the corruption back in: every accessor on the
 * document — a getter, a Proxy trap, a `toJSON`, a queue that drains as it is
 * read — is free to answer differently the second time, and the second answer
 * was the one that shipped. `output.data = { get id() { … } }` returning `1`
 * and then `NaN` passed validation and committed `{"data":{"id":null}}`.
 */
function encodeOutput(value, maxOutputBytes) {
  let checked;
  try {
    checked = validate(value);
  } catch (err) {
    // A throwing getter, a Proxy trap — anything the walk itself provoked.
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

/** Either `{ problem }` naming what cannot be encoded, or `{ value }` to encode. */
function validate(root) {
  // The root is what later steps read paths out of, so it has to be a document.
  // A replaced `output = "done"` has nothing to merge and no path to address.
  if (root === null || typeof root !== "object" || Array.isArray(root) || !isPlainObject(root)) {
    return { problem: `output is ${describeValue(root)}; output must be a plain object` };
  }
  return walk(root, "output", new Set());
}

/** Same shape as {@link validate}: the walked copy is what gets encoded. */
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
  // branches encodes fine, it is a reference back *up* the tree that cannot.
  if (ancestors.has(value)) {
    return { problem: `${path} is a cyclic reference; output must be a tree` };
  }

  if (Array.isArray(value)) {
    ancestors.add(value);
    const copy = [];
    for (let i = 0; i < value.length; i++) {
      // A hole is not `undefined` written by the author — `JSON.stringify`
      // encodes it as null, and rejecting it named an index nobody wrote.
      const walked = walk(i in value ? value[i] : null, `${path}[${i}]`, ancestors);
      if (walked.problem) return walked;
      copy.push(walked.value);
    }
    ancestors.delete(value);
    return { value: copy };
  }
  if (value instanceof Date) {
    // Checked before `toJSON` below, which a Date has: it encodes to an opaque
    // string a later step cannot read back as a date.
    return {
      problem: `${path} is a Date; output must be JSON-compatible data (use an ISO string)`,
    };
  }
  if (typeof value.toJSON === "function") {
    // What `JSON.stringify` would have encoded, so that is what is walked — and
    // now also what is kept. Walking the object instead let a `toJSON` on the
    // root smuggle a function through as null, and refused a plain object whose
    // `toJSON` encodes perfectly well.
    return walk(value.toJSON(), path, ancestors);
  }
  if (!isPlainObject(value)) {
    // A Map, a Set, a class instance: each encodes to something a later step
    // cannot read back — `{}` for a Map.
    return { problem: `${path} is ${describeValue(value)}; output must be JSON-compatible data` };
  }
  ancestors.add(value);
  const copy = {};
  for (const key of Object.keys(value)) {
    if (key === "__proto__") {
      // `JSON.parse` creates this as an own key, so `output.settings =
      // JSON.parse(body)` carries it into flow state, where a later
      // `Object.assign` would write a prototype rather than a property.
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

/** Name the offending value the way its author would recognise it. */
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
 * An error as a message, carrying the causes Node itself would have printed.
 *
 * `err.message` alone loses the whole reason for the dominant failure shape of
 * a seeding script: `fetch("…")` throws `fetch failed` and puts
 * `connect ECONNREFUSED 127.0.0.1:5432` in `.cause`, and `Promise.any` puts
 * every attempt in `AggregateError.errors`. Node prints both, but the runner's
 * `uncaughtException` handler claims the exception, so that printout never
 * happens and the log is empty beside the message — leaving a report with
 * strictly less in it than running the script by hand.
 *
 * The rendering, the depth bound and the skip-what-is-already-said rule are the
 * parent's `formatErrorForAgent`; this file imports nothing from the package,
 * so it carries its own copy. The bound also guards a `.cause` that points back
 * up its own chain.
 */
function errorMessage(err) {
  if (!(err instanceof Error)) return describeThrown(err);
  const parts = [];
  visitError(err, 0, CAUSED_BY, parts, new Set());
  return parts.map((part, at) => (at === 0 ? part.text : part.joiner + part.text)).join("");
}

/** What a value that is not an `Error` reads as. */
function describeThrown(value) {
  return typeof value === "string" ? value : safeStringify(value);
}

/**
 * Add one part, unless an earlier one already says it.
 *
 * Text an earlier part already carries adds nothing: a wrapper that quotes its
 * own cause is the ordinary shape.
 */
function addPart(parts, joiner, text) {
  if (text && !parts.some((part) => part.text.includes(text))) parts.push({ joiner, text });
}

/** How far {@link errorMessage} follows a chain of causes. */
const MAX_CAUSE_DEPTH = 8;
const CAUSED_BY = " — caused by: ";
/** `AggregateError.errors` are siblings, not a chain: every attempt that failed. */
const ALSO = "; ";

function visitError(err, depth, joiner, parts, seen) {
  if (depth > MAX_CAUSE_DEPTH) return;
  // Neither a `.cause` nor an `AggregateError.errors` entry has to be an
  // `Error`: `new Error("upload failed", { cause: "HTTP 500 …" })` and
  // `Promise.any` over promises rejected with strings are both ordinary, and
  // Node prints both. Dropping them left the report carrying the wrapper's own
  // message and nothing else — and the log has no second copy to fall back on,
  // because the runner claims the exception, so Node's own printout never runs.
  // A leaf either way: `safeStringify` of an object renders whatever it nests.
  if (!(err instanceof Error)) {
    // `undefined` is an absent cause rather than a value. Every error is asked
    // for one and almost none has it.
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
 * Send the verdict, flush both standard streams, then leave.
 *
 * `process.stdout` is asynchronous when it is a pipe, so a bare `process.exit`
 * discards buffered log output — a measured run lost the entire log line of a
 * passing script. Queuing an empty write on each stream and exiting inside its
 * callback runs after every earlier write has flushed.
 *
 * The exit code is always 0: the terminal message decides the verdict, and the
 * parent's classification depends on the message, not the code.
 */
function finish(response) {
  // One verdict per process. `beforeExit` can fire more than once, and a script
  // can crash while the runner is already reporting; the first outcome is the
  // one the parent hears.
  if (finished) return;
  finished = true;
  const bounded = boundFailureText(response);
  const exit = () => realExit(0);
  let pending = 2;
  const flushed = () => {
    if (--pending === 0) exit();
  };
  const flush = () => {
    // A stream whose peer is gone never calls back; the fallback keeps this
    // from becoming the hang that the deadline watchdog has to clean up.
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
 * The same verdict, sent from inside the script's own `process.exit`.
 *
 * There is no turn of the event loop left there to flush a stream in, and there
 * must not be one: `process.exit` does not return, and a script that continues
 * past it is not the script its author wrote. The write is the whole of it —
 * `process.send` puts a small message on the channel before it returns, and the
 * buffered stdout that a bare `process.exit` discards is discarded under plain
 * `node` too, which is what the script asked for.
 */
function finishSynchronously(response) {
  if (finished) return;
  finished = true;
  try {
    sendToParent(boundFailureText(response));
  } catch {
    // The channel is gone; the parent's exit verdict is what is left.
  }
}

/** Both free-text fields of a failure, cut to what may cross the channel. */
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
 * Cut runner-controlled text to a ceiling, saying how much was left out.
 *
 * The marker counts against the ceiling. Left outside it the result is *longer*
 * than the ceiling, and the parent re-clamps at the very same number as its
 * second line against a child that stopped being compliant — so on every
 * compliant child that second cut landed on the same boundary, threw away this
 * marker, and wrote one of its own reporting the length of the marker it had
 * just dropped. A message that lost a megabyte said it had lost thirty-four
 * characters.
 */
function clampText(text, max) {
  if (typeof text !== "string" || text.length <= max) return text;
  let cut = max;
  let marked = `${text.slice(0, cut)}${omissionMarker(text.length - cut)}`;
  // Two passes at most: the marker only grows by the digits the larger count
  // adds. The guard is what ends it for a ceiling narrower than a marker.
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
 * Queue an empty write so the callback runs after everything already buffered.
 *
 * A script may have ended the stream itself (`process.stdout.end()`), and
 * writing to an ended stream raises an unhandled `error` event — which put an
 * `ERR_STREAM_WRITE_AFTER_END` trace naming this file into the log of a step
 * that otherwise passed.
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
 * The only path onto the protocol channel. See `closeChannelToScript`.
 *
 * Through the `send` captured at load, never through whatever `process.send`
 * names by now: the property is the script's to replace or delete, and reading
 * it back here handed the verdict to a stub.
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
