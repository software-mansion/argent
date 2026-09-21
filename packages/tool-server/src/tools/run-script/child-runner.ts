// Source of the child process that runs an agent-authored run-script body.
//
// It is shipped as a STRING so it survives esbuild bundling (see
// packages/argent/scripts/bundle-tools.cjs): the bundler inlines this literal
// into the single tool-server bundle, and `runtime.ts` writes it to a temp
// `.cjs` at spawn time and `fork()`s it. Keeping it a plain-CJS string avoids
// any asset-copy step or `__dirname` resolution against the bundle.
//
// The child IS the isolation boundary — a throwaway process launched with an
// empty env, a temp cwd, and no argv. The script body runs with only two
// injected globals (`ui`, `console`); `ui` calls are forwarded to the parent
// over the fork IPC channel, where the real facade runs. A constructor escape
// (`ui.describe.constructor("return process")()`) therefore reaches only this
// disposable child — no facade internals, no tool-server state, no auth token.
// This is process isolation, not a jail.

// Combined console output cap; older lines are dropped so the newest survive.
// Exported so the parent (runtime.ts) can size its own mirror of the buffer with
// the same policy when it replays streamed logs on the timeout / exit paths.
export const LOG_CAP = 4000;

// The vm filename the script's syntax errors and stack frames are reported
// under, so the agent never sees the internal wrapper or a host path. Mirrored
// by SCRIPT_FILENAME in runtime.ts.
export const SCRIPT_FILENAME = "<script>";

// The runner keeps a rolling buffer at twice the render cap so `collect()` can
// still prefix "…" and slice the exact tail, while memory stays bounded (fixes
// the unbounded-log retention finding: the cap is enforced on every write, not
// only at the end).
export const LOG_BUFFER_CAP = LOG_CAP * 2;

export const RUNNER_SOURCE = `"use strict";
const vm = require("node:vm");

const LOG_CAP = ${LOG_CAP};
const LOG_BUFFER_CAP = ${LOG_BUFFER_CAP};
const SCRIPT_FILENAME = ${JSON.stringify(SCRIPT_FILENAME)};

// --- captured console: a rolling buffer capped as each record is added ---
const lines = [];
let bufLen = 0;

function formatArg(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_e) {
    return String(value);
  }
}

function record(level) {
  return function () {
    const args = Array.prototype.slice.call(arguments);
    let line = "[" + level + "] " + args.map(formatArg).join(" ");
    // Cap each record: one giant line (console.log("X".repeat(1e8))) must not be
    // retained whole — the length-only trim loop below would keep it because it
    // never drops the last remaining line.
    if (line.length > LOG_BUFFER_CAP) line = line.slice(0, LOG_BUFFER_CAP - 1) + "…";
    lines.push(line);
    bufLen += line.length + 1;
    while (bufLen > LOG_BUFFER_CAP && lines.length > 1) {
      bufLen -= lines.shift().length + 1;
    }
    // Stream the record to the parent as it is produced so the console tail
    // survives the paths where the child is killed before it can send its final
    // result (timeout / interrupt / unexpected exit). Fire-and-forget.
    try {
      process.send({ t: "log", line: line });
    } catch (_e) {
      /* channel closed — parent is tearing the child down */
    }
  };
}

// Only the methods a script realistically calls; the rest are no-ops so
// console.table(...) etc. don't throw.
const captured = {
  log: record("log"),
  info: record("info"),
  warn: record("warn"),
  error: record("error"),
  debug: record("debug"),
};

function collect() {
  const text = lines.join("\\n");
  return text.length > LOG_CAP ? "…" + text.slice(text.length - LOG_CAP) : text;
}

// --- ui facade proxy: every property access becomes an async RPC to the parent ---
let nextId = 1;
const pending = new Map();

function rpc(method, args) {
  return new Promise(function (resolve, reject) {
    const id = nextId++;
    pending.set(id, { resolve: resolve, reject: reject });
    try {
      process.send({ t: "ui", id: id, method: method, args: args });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

const ui = new Proxy(
  {},
  {
    get: function (_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      return function () {
        return rpc(prop, Array.prototype.slice.call(arguments));
      };
    },
  }
);

function serializeError(err) {
  const e = err && typeof err === "object" ? err : {};
  return {
    name: typeof e.name === "string" ? e.name : "Error",
    message: typeof e.message === "string" ? e.message : String(err),
    stack: typeof e.stack === "string" ? e.stack : "",
  };
}

function sendAndExit(msg) {
  try {
    process.send(msg, function () {
      process.exit(0);
    });
  } catch (_e) {
    process.exit(1);
  }
}

process.on("message", function (msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "ui-res") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) {
      p.resolve(msg.value);
    } else {
      const err = new Error(msg.error && typeof msg.error.message === "string" ? msg.error.message : "ui call failed");
      if (msg.error) {
        if (typeof msg.error.name === "string") err.name = msg.error.name;
        if (typeof msg.error.stack === "string") err.stack = msg.error.stack;
      }
      // Preserve how the parent classified the failure so an uncaught rethrow
      // maps back to the same failure code (step-failed vs generic throw).
      Object.defineProperty(err, "__argentErrKind", {
        value: msg.kind || "other",
        enumerable: false,
      });
      p.reject(err);
    }
    return;
  }
  if (msg.t === "init") {
    run(msg.script);
  }
});

function run(script) {
  let compiled;
  try {
    // The body runs as an async IIFE so \`await\` and early \`return\` work; the
    // leading wrapper line is offset out so reported line numbers match the body.
    const wrapped = "(async (ui, console) => {\\n" + script + "\\n})(ui, console)";
    compiled = new vm.Script(wrapped, { filename: SCRIPT_FILENAME, lineOffset: -1 });
  } catch (err) {
    sendAndExit({ t: "compile-err", message: err && err.message ? String(err.message) : String(err) });
    return;
  }

  globalThis.ui = ui;
  globalThis.console = captured;

  Promise.resolve()
    .then(function () {
      return compiled.runInThisContext();
    })
    .then(
      function () {
        sendAndExit({ t: "done", logs: collect() });
      },
      function (err) {
        const kind = err && err.__argentErrKind ? err.__argentErrKind : "other";
        sendAndExit({ t: "err", error: serializeError(err), kind: kind, logs: collect() });
      }
    );
}
`;
