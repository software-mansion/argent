import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  flowScriptExecutor,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("run");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(): FlowScriptExecutor {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000 });
}

describe("flow script executor — a passing run", () => {
  it("returns the script's output and its captured logs", async () => {
    const ws = workspace();
    const script = ws.write(
      "seed.mjs",
      `console.log("seeding order");
       console.error("a warning");
       output.order = { id: "ord_1", total: 42 };`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ order: { id: "ord_1", total: 42 } });
    expect(result.log).toContain("seeding order");
    expect(result.log).toContain("a warning");
    expect(result.logTruncated).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("carries the flow's existing output into the script", async () => {
    const ws = workspace();
    const script = ws.write("read.mjs", `output.seen = output.given + 1;`);
    const result = await executor().execute({
      scriptPath: script,
      output: { given: 41 },
      projectRoot: ws.dir,
    });
    expect(result.output).toEqual({ given: 41, seen: 42 });
  });
});

describe("flow script executor — work the module evaluation outlives", () => {
  it("waits for a floating main() to finish before reading output", async () => {
    const ws = workspace();
    const script = ws.write(
      "seed.mjs",
      `async function main() {
         console.log("seeding");
         await new Promise((r) => setTimeout(r, 100));
         output.order = { id: "ord_1" };
         console.log("seeded");
       }
       main();`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ order: { id: "ord_1" } });
    expect(result.log).toContain("seeded");
  });

  it("waits for callback-style I/O the script never awaited", async () => {
    const ws = workspace();
    const script = ws.write(
      "read.mjs",
      `import fs from "node:fs";
       fs.readFile(new URL(import.meta.url), "utf8", (err, text) => {
         output.bytes = text.length;
       });`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output?.bytes).toBeGreaterThan(0);
  });

  it("lets the script's own beforeExit handler finish the work it schedules", async () => {
    const ws = workspace();
    // The runner's probe was registered before the script loaded, so it ran
    // first and exited the process before anything a script's handler scheduled
    // could run. `setTimeout(() => fs.writeFileSync(…))` in a `beforeExit`
    // handler is the ordinary cleanup shape, and plain `node` writes the file.
    const marker = ws.resolve("cleanup.txt");
    const script = ws.write(
      "cleanup.mjs",
      `import fs from "node:fs";
       let ran = false;
       process.on("beforeExit", () => {
         if (ran) return;
         ran = true;
         setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "cleanup done"), 50);
       });
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ok: true });
    expect(fs.readFileSync(marker, "utf8")).toBe("cleanup done");
  });

  it("gives a beforeExit handler every round it asks for, not one", async () => {
    const ws = workspace();
    // A retry loop driven from `beforeExit` is the shape: the handler is
    // entered on each round and stops scheduling when it succeeds. Spending a
    // fixed number of rounds gave it one — the handler's own log line showed
    // the last attempt starting, and the work it scheduled was thrown away
    // while the step reported a green pass with an empty document. Plain `node`
    // runs all three.
    const script = ws.write(
      "retry.mjs",
      `let attempts = 0;
       let uploaded = false;
       process.on("beforeExit", () => {
         if (uploaded || attempts >= 3) return;
         attempts += 1;
         console.log("attempt", attempts);
         setTimeout(() => {
           if (attempts === 3) {
             uploaded = true;
             output.uploaded = true;
           }
         }, 5);
       });`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ uploaded: true });
    expect(result.log).toBe("attempt 1\nattempt 2\nattempt 3\n");
  });

  it("drains a queue a beforeExit handler works through over several rounds", async () => {
    const ws = workspace();
    // The partial-loss half of the same defect: the round that was taken away
    // committed one entry of two, so the document was wrong rather than empty.
    const script = ws.write(
      "drain.mjs",
      `const queue = ["a", "b", "c"];
       process.on("beforeExit", () => {
         const next = queue.shift();
         if (!next) return;
         setTimeout(() => {
           output[next] = true;
         }, 5);
       });`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ a: true, b: true, c: true });
  });

  it("fails the step when the script's beforeExit handler throws", async () => {
    const ws = workspace();
    // Swallowed entirely, with an empty log and a passing step, where plain
    // `node` exits 1.
    const script = ws.write(
      "bad-cleanup.mjs",
      `process.on("beforeExit", async () => {
         await new Promise((r) => setTimeout(r, 10));
         throw new Error("cleanup failed");
       });
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).toBe("cleanup failed");
  });
});

describe("flow script executor — the script is the main module", () => {
  it("runs a body behind an ESM main-module guard", async () => {
    const ws = workspace();
    // The standard shape for a script that is also importable by a test. Under
    // a runner that imported the script, every one of these answered "no" and
    // the step passed having run nothing.
    //
    // `import.meta.main` is compared against what plain `node script.mjs`
    // reports on this Node rather than against `true`: the property landed in
    // Node 24 and is `undefined` on 20 and 22, both inside the supported range.
    // The claim under test is the equivalence, and pinning the value instead
    // made the suite red on the version CI runs.
    const probe = ws.write("probe.mjs", `process.stdout.write(String(import.meta.main));`);
    const plainNode = execFileSync(process.execPath, [probe], { encoding: "utf8" }).trim();
    const script = ws.write(
      "guard.mjs",
      `import { fileURLToPath } from "node:url";
       output.isMain = String(import.meta.main);
       output.argvGuard = process.argv[1] === fileURLToPath(import.meta.url);
       if (output.argvGuard) output.ran = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ isMain: plainNode, argvGuard: true, ran: true });
  });

  it("evaluates a script reached through a symlink exactly once", async () => {
    const ws = workspace();
    const evaluations = ws.resolve("evaluations.txt");
    // The runner re-imports the entry module to tell a finished script from one
    // parked in a top-level `await`. Node caches a module by the real path it
    // resolved the entry from, so a request that named a different spelling of
    // the same file was a second module — and the script's body ran twice.
    const real = ws.write(
      "real.mjs",
      `import fs from "node:fs";
       fs.appendFileSync(${JSON.stringify(evaluations)}, "x");
       output.ok = true;`
    );
    const link = ws.resolve("link.mjs");
    fs.symlinkSync(real, link);
    const result = await executor().execute({ scriptPath: link, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(fs.readFileSync(evaluations, "utf8")).toBe("x");
  });

  it("runs a body behind a CommonJS require.main guard", async () => {
    const ws = workspace();
    const script = ws.write("guard.cjs", `if (require.main === module) output.ran = true;`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ran: true });
  });

  it("leaves a script's own child process and worker thread alone", async () => {
    const ws = workspace();
    // The runner rides in on `execArgv`, which a `fork` and a `new Worker` both
    // inherit. An inherited copy that thought it was the runner would wait for
    // a request nobody is sending, and the script would hang on its own child.
    ws.write("grandchild.mjs", `console.log("grandchild ran");`);
    ws.write(
      "worker.mjs",
      `import { parentPort } from "node:worker_threads";
       parentPort.postMessage("from the worker");`
    );
    const script = ws.write(
      "spawner.mjs",
      `import { fork } from "node:child_process";
       import { Worker } from "node:worker_threads";
       const child = fork(new URL("grandchild.mjs", import.meta.url).pathname);
       output.childExit = await new Promise((r) => child.on("exit", r));
       const worker = new Worker(new URL("worker.mjs", import.meta.url));
       output.fromWorker = await new Promise((r) => worker.on("message", r));`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 15_000,
    });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ childExit: 0, fromWorker: "from the worker" });
  }, 30_000);
});

describe("flow script executor — module loading", () => {
  it("loads built-ins, relative modules, ESM and CommonJS packages, JSON and top-level await", async () => {
    const ws = workspace();
    ws.write("helper.mjs", `export const helper = "relative";`);
    ws.write("data.json", `{ "fromJson": true }`);
    const script = ws.write(
      "imports.mjs",
      `import { platform } from "node:os";
       import { helper } from "./helper.mjs";
       import YAML from "yaml";
       import bytes from "bytes";
       import data from "./data.json" with { type: "json" };
       const awaited = await Promise.resolve("top-level await");
       output.builtin = typeof platform === "function";
       output.relative = helper;
       output.esmPackage = YAML.parse("a: 1").a;
       output.cjsPackage = bytes(1024);
       output.json = data.fromJson;
       output.awaited = awaited;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({
      builtin: true,
      relative: "relative",
      esmPackage: 1,
      cjsPackage: "1KB",
      json: true,
      awaited: "top-level await",
    });
  });

  it("reports a module that never loads as a load failure, not a runtime one", async () => {
    const ws = workspace();
    const script = ws.write("missing.mjs", `import "./nope.mjs";`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("load");
    expect(result.failure?.message).toContain("nope.mjs");
  });

  it("reports a syntax error as a load failure", async () => {
    const ws = workspace();
    const script = ws.write("broken.mjs", `const = ;`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("load");
  });

  it("reports a throwing script as a runtime failure, with its stack", async () => {
    const ws = workspace();
    const script = ws.write("throws.mjs", `throw new Error("backend refused the seed");`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).toBe("backend refused the seed");
    // Node opened the file itself, so the trace keeps a real line number.
    expect(result.failure?.stack).toContain("throws.mjs:1");
  });

  it("reports a rejection nobody awaited as a runtime failure, with its stack", async () => {
    const ws = workspace();
    const script = ws.write(
      "async-crash.mjs",
      `Promise.reject(new Error("upstream 503 from the metrics API"));
       await new Promise((r) => setTimeout(r, 200));
       output.done = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    // Not "the script stopped its own process with exit code 1": it did not,
    // and that message points the author at a `process.exit` that is not there.
    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).toBe("upstream 503 from the metrics API");
    expect(result.failure?.stack).toContain("async-crash.mjs:1");
  });

  it("reports a throw from a timer callback as a runtime failure", async () => {
    const ws = workspace();
    const script = ws.write(
      "late-throw.mjs",
      `setTimeout(() => { throw new Error("late boom"); }, 50);`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).toBe("late boom");
    expect(result.failure?.stack).toContain("late-throw.mjs:1");
  });

  it("lets a script recover through an uncaughtException handler of its own", async () => {
    const ws = workspace();
    // Node does not end a process that has an `uncaughtException` listener, so
    // this script carries on and finishes under plain `node`. The runner's own
    // handler is registered before the script loads, so it pre-empted the
    // script's and failed the step with an error the script had already dealt
    // with — its own log line saying so, right beside the verdict.
    const script = ws.write(
      "recovers.mjs",
      `process.on("uncaughtException", (err) => {
         console.log("recovered from " + err.message);
         output.recovered = true;
       });
       setTimeout(() => { throw new Error("boom in timer"); }, 20);
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ok: true, recovered: true });
    expect(result.log).toContain("recovered from boom in timer");
  });

  it("calls a SyntaxError from running code a runtime failure, not a load one", async () => {
    const ws = workspace();
    // The canonical script failure: the endpoint returned an HTML error page.
    // Telling this author their file never evaluated sends them somewhere else
    // entirely.
    const script = ws.write("html.mjs", `JSON.parse("<html>not json</html>");`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("runtime");
  });

  it("carries the causes Node would have printed into the failure message", async () => {
    const ws = workspace();
    // The dominant failure shape of a seeding script: `fetch` throws
    // `fetch failed` and puts the real reason in `.cause`. The runner's own
    // handler claims the exception, so Node's printout — which does show
    // `[cause]` — never happens, and the report had strictly less in it than
    // running the script by hand.
    const chained = ws.write(
      "chained.mjs",
      `throw new Error("could not seed the order", {
         cause: new Error("connect ECONNREFUSED 127.0.0.1:5432"),
       });`
    );
    const fromChain = await executor().execute({ scriptPath: chained, projectRoot: ws.dir });
    expect(fromChain.failure?.kind).toBe("runtime");
    expect(fromChain.failure?.message).toBe(
      "could not seed the order — caused by: connect ECONNREFUSED 127.0.0.1:5432"
    );

    // `Promise.any` puts every attempt in `errors`; they are siblings, not a
    // chain, and neither reached the report at all.
    const aggregate = ws.write(
      "aggregate.mjs",
      `throw new AggregateError(
         [new Error("ipv4 refused"), new Error("ipv6 refused")],
         "all attempts failed"
       );`
    );
    const fromAggregate = await executor().execute({ scriptPath: aggregate, projectRoot: ws.dir });
    expect(fromAggregate.failure?.message).toBe(
      "all attempts failed — caused by: ipv4 refused; ipv6 refused"
    );
  });

  it("carries a cause that is not an Error", async () => {
    const ws = workspace();
    // Neither field has to hold an `Error`. `cause: "HTTP 500 …"` is what a
    // handwritten wrapper puts there, and `Promise.any` over promises rejected
    // with strings puts strings in `errors`. Node prints both; the runner
    // dropped both, and it claims the exception, so the log had no second copy
    // to fall back on — the report was the wrapper's own message and nothing
    // else.
    const stringCause = ws.write(
      "string-cause.mjs",
      `throw new Error("upload failed", {
         cause: "HTTP 500 from https://api.example.com/v1/upload",
       });`
    );
    const fromString = await executor().execute({ scriptPath: stringCause, projectRoot: ws.dir });
    expect(fromString.failure?.kind).toBe("runtime");
    expect(fromString.failure?.message).toBe(
      "upload failed — caused by: HTTP 500 from https://api.example.com/v1/upload"
    );

    const rejected = ws.write(
      "rejected.mjs",
      `await Promise.any([Promise.reject("primary down"), Promise.reject("replica down")]);`
    );
    const fromRejected = await executor().execute({ scriptPath: rejected, projectRoot: ws.dir });
    expect(fromRejected.failure?.message).toBe(
      "All promises were rejected — caused by: primary down; replica down"
    );

    // An object cause renders as the data it is, nested keys included.
    const objectCause = ws.write(
      "object-cause.mjs",
      `throw new Error("request rejected", { cause: { status: 422, field: "email" } });`
    );
    const fromObject = await executor().execute({ scriptPath: objectCause, projectRoot: ws.dir });
    expect(fromObject.failure?.message).toBe(
      'request rejected — caused by: {"status":422,"field":"email"}'
    );

    // And an error with no cause still says only what it says: `.cause` is read
    // on every error and is absent from nearly all of them.
    const plain = ws.write("plain.mjs", `throw new Error("plain failure");`);
    const fromPlain = await executor().execute({ scriptPath: plain, projectRoot: ws.dir });
    expect(fromPlain.failure?.message).toBe("plain failure");
  });

  it("bounds a chain of causes, and survives one that points back at itself", async () => {
    const ws = workspace();
    // Both guards on the walk, neither of which the happy paths reach. A
    // re-wrapped error whose `.cause` climbs back up its own chain is the shape
    // the cycle guard exists for; without it the walk never returns and the
    // step runs to its time limit with no verdict at all.
    const cyclic = ws.write(
      "cyclic.mjs",
      `const outer = new Error("outer failed");
       const inner = new Error("inner failed", { cause: outer });
       outer.cause = inner;
       throw outer;`
    );
    const fromCyclic = await executor().execute({ scriptPath: cyclic, projectRoot: ws.dir });
    expect(fromCyclic.failure?.message).toBe("outer failed — caused by: inner failed");

    // And the depth bound: a long chain is cut rather than rendered whole.
    const deep = ws.write(
      "deep-chain.mjs",
      `let err = new Error("d11");
       for (let level = 10; level >= 0; level--) err = new Error("d" + level, { cause: err });
       throw err;`
    );
    const fromDeep = await executor().execute({ scriptPath: deep, projectRoot: ws.dir });
    expect(fromDeep.failure?.message).toContain("d8");
    expect(fromDeep.failure?.message).not.toContain("d9");
  });

  it("calls the script's own asynchronous failures runtime failures", async () => {
    const ws = workspace();
    // An error raised asynchronously carries the frames of wherever it was
    // constructed — nothing at all for an `fs` callback, undici for a response
    // body — so reading the *absence* of a file frame as proof of a load
    // failure made the same call flip verdict on whether it was awaited.
    const callback = ws.write(
      "callback.mjs",
      `import fs from "node:fs";
       fs.readFile("/nope/missing.csv", (err) => { if (err) throw err; });`
    );
    const fromCallback = await executor().execute({ scriptPath: callback, projectRoot: ws.dir });
    expect(fromCallback.failure?.kind).toBe("runtime");

    // The plan's own canonical example for why the distinction exists.
    const body = ws.write(
      "body.mjs",
      `async function main() { await new Response("<html>").json(); }
       main();`
    );
    const fromBody = await executor().execute({ scriptPath: body, projectRoot: ws.dir });
    expect(fromBody.failure?.kind).toBe("runtime");
  });

  it("keeps that verdict when a dependency has set Error.stackTraceLimit to 0", async () => {
    const ws = workspace();
    // A global any dependency may set. With no frames at all there is no
    // evidence either way, and absence-of-a-file-frame read it as a load
    // failure — for a plain synchronous throw.
    const script = ws.write(
      "no-frames.mjs",
      `Error.stackTraceLimit = 0;
       JSON.parse("<!doctype html>");`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("runtime");
  });

  it("calls a script file it cannot open a load failure, not a runtime one", async () => {
    const ws = workspace();
    const script = ws.write("locked.mjs", `output.ok = true;`);
    fs.chmodSync(script, 0o000);
    try {
      const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

      expect(result.failure?.kind).toBe("load");
      expect(result.failure?.message).toContain("EACCES");
    } finally {
      fs.chmodSync(script, 0o600);
    }
  });

  it("does not put a stream crash into the log of a passing step", async () => {
    const ws = workspace();
    // A script that ended its own stdout: writing to an ended stream raises an
    // unhandled error event, and the trace landed in the report of a step that
    // otherwise passed.
    const script = ws.write("ends-stdout.mjs", `console.log("done"); process.stdout.end();`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(true);
    expect(result.log).not.toContain("ERR_STREAM_WRITE_AFTER_END");
  });

  it("loads a script whose path holds a space and a #", async () => {
    const ws = workspace();
    const script = ws.write("a dir #1/odd name.mjs", `output.loaded = true;`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ loaded: true });
  });
});

describe("flow script executor — the tool server's one executor", () => {
  it("is shared, because the concurrency limit is per tool server", () => {
    expect(flowScriptExecutor()).toBe(flowScriptExecutor());
  });

  it("runs a script through the shared instance", async () => {
    const ws = workspace();
    // Through `flowScriptExecutor()` itself, not a local executor: the point of
    // the test is that the shared instance works, and a local one would pass
    // even if the singleton were replaced by a fresh instance per call.
    const result = await flowScriptExecutor().execute({
      scriptPath: ws.write("shared.mjs", `output.viaShared = true;`),
      projectRoot: ws.dir,
    });
    expect(result.output).toEqual({ viaShared: true });
  });
});
