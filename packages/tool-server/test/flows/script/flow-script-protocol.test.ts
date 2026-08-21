import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptFailure,
  type FlowScriptRequest,
} from "../../../src/tools/flows/script/flow-script-executor";
import {
  parseScriptResponse,
  type ScriptFailureType,
  type ScriptResponse,
} from "../../../src/tools/flows/script/flow-script-protocol";
import {
  createScriptWorkspace,
  SOURCE_RUNNER_DIR,
  type ScriptWorkspace,
} from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];
const cleanups: Array<() => void> = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("proto");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor() {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000 });
}

/**
 * Run a script against a stand-in runner that misbehaves in a chosen way.
 *
 * The runner is a preload, so a fake one is loaded before the script and parks
 * instead of returning: Node waits for an `--import` module to finish before it
 * loads the entry, and none of these cases wants the script to run. That is the
 * real runner's own shape on a request it cannot honour.
 */
async function withFakeRunner(source: string, extra: Partial<FlowScriptRequest> = {}) {
  const ws = workspace();
  const runnerDir = ws.resolve("runner");
  fs.mkdirSync(runnerDir, { recursive: true });
  fs.writeFileSync(
    path.join(runnerDir, "flow-script-runner.mjs"),
    `${source}\nawait new Promise(() => {});\n`
  );
  const script = ws.write("script.mjs", `output.ok = true;`);
  return executor().execute({
    scriptPath: script,
    projectRoot: ws.dir,
    runnerDir,
    timeoutMs: 5_000,
    ...extra,
  });
}

describe("script response parsing", () => {
  it("accepts the three valid shapes", () => {
    const started: ScriptResponse | null = parseScriptResponse({ type: "started" });
    expect(started).toEqual({ type: "started" });
    expect(parseScriptResponse({ type: "result", outputJson: "{}" })).toEqual({
      type: "result",
      outputJson: "{}",
    });
    const runtime: ScriptFailureType = "runtime";
    expect(parseScriptResponse({ type: "failure", failureType: runtime, message: "x" })).toEqual({
      type: "failure",
      failureType: runtime,
      message: "x",
    });
  });

  it("carries a stack when there is one, and drops one that is not a string", () => {
    expect(
      parseScriptResponse({ type: "failure", failureType: "runtime", message: "x", stack: "at y" })
    ).toEqual({ type: "failure", failureType: "runtime", message: "x", stack: "at y" });
    expect(
      parseScriptResponse({ type: "failure", failureType: "runtime", message: "x", stack: 7 })
    ).toEqual({ type: "failure", failureType: "runtime", message: "x" });
  });

  it.each([
    ["a non-object", "started"],
    ["null", null],
    ["an unknown type", { type: "progress" }],
    ["a result with no output", { type: "result" }],
    ["a result whose output is not a string", { type: "result", outputJson: {} }],
    ["a failure with no message", { type: "failure", failureType: "runtime" }],
    [
      "a failure with an unknown failure type",
      { type: "failure", failureType: "weird", message: "x" },
    ],
  ])("rejects %s", (_label, raw) => {
    expect(parseScriptResponse(raw)).toBeNull();
  });
});

describe("flow script executor — a runner that misbehaves", () => {
  it("reports an unrecognized message as a protocol failure", async () => {
    const result = await withFakeRunner(
      `process.on("message", () => { process.send({ type: "progress", at: 1 }); });`
    );
    expect(result.failure?.kind).toBe("protocol");
    expect(result.failure?.message).toContain("does not recognise");
  });

  it("reports a runner that exits before starting the script", async () => {
    const result = await withFakeRunner(`process.on("message", () => process.exit(9));`);
    expect(result.failure?.kind).toBe("protocol");
    expect(result.failure?.message).toContain("exited before it started the script");
    expect(result.failure?.message).toContain("exit code 9");
  });

  it("reports a runner that starts the script then exits without a verdict", async () => {
    const result = await withFakeRunner(
      `process.on("message", () => { process.send({ type: "started" }); process.exit(0); });`
    );
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("exit code 0");
  });

  it("rejects a result that is not an object", async () => {
    const result = await withFakeRunner(
      `process.on("message", () => {
         process.send({ type: "started" });
         process.send({ type: "result", outputJson: "[1,2,3]" }, () => process.exit(0));
       });`
    );
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("not an object");
  });

  it("rejects a result whose output does not parse", async () => {
    const result = await withFakeRunner(
      `process.on("message", () => {
         process.send({ type: "started" });
         process.send({ type: "result", outputJson: "{not json" }, () => process.exit(0));
       });`
    );
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("did not parse");
  });

  it("keeps the first terminal response and ignores a second", async () => {
    const result = await withFakeRunner(
      `process.on("message", () => {
         process.send({ type: "started" });
         process.send({ type: "result", outputJson: JSON.stringify({ first: true }) });
         process.send({ type: "failure", failureType: "runtime", message: "second" }, () =>
           process.exit(0)
         );
       });`
    );
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({ first: true });
  });

  it("re-checks the output size even though a compliant child already did", async () => {
    // The parent must not depend on a child staying compliant after arbitrary
    // script code has run inside it.
    const result = await withFakeRunner(
      `process.on("message", () => {
         process.send({ type: "started" });
         const big = JSON.stringify({ blob: "x".repeat(1024 * 1024 + 32) });
         process.send({ type: "result", outputJson: big }, () => process.exit(0));
       });`
    );
    expect(result.failure?.kind).toBe("output");
    expect(result.failure?.message).toContain("the limit is 1.0 MiB");
  });

  it("re-checks the failure text bounds even though a compliant child already did", async () => {
    // The same second line the output size gets, for the same reason: a child
    // that stopped being compliant after arbitrary script code ran in it.
    const result = await withFakeRunner(
      `process.on("message", () => {
         process.send({ type: "started" });
         process.send(
           { type: "failure", failureType: "runtime", message: "m".repeat(20000), stack: "s".repeat(40000) },
           () => process.exit(0)
         );
       });`
    );
    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message.length).toBeLessThan(20000);
    expect(result.failure?.message).toMatch(/… \[\d+ more characters omitted]$/);
    expect(result.failure?.stack?.length).toBeLessThan(40000);
    expect(result.failure?.stack).toMatch(/… \[\d+ more characters omitted]$/);
  });

  it("bounds the unrecognized message it quotes back", async () => {
    // A misbehaving runner controls this string, so it must not be able to make
    // the failure message arbitrarily long.
    const result = await withFakeRunner(
      `process.on("message", () => {
         process.send({ type: "progress", blob: "b".repeat(50000) });
       });`
    );
    expect(result.failure?.kind).toBe("protocol");
    expect(result.failure?.message).toContain("does not recognise");
    expect(result.failure?.message.length).toBeLessThan(500);
    expect(result.failure?.message.endsWith("…")).toBe(true);
  });

  it("reports a missing runner rather than spawning nothing", async () => {
    const ws = workspace();
    const script = ws.write("script.mjs", `output.ok = true;`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      runnerDir: ws.resolve("no-such-dir"),
    });
    const failure = result.failure as FlowScriptFailure;
    expect(failure.kind).toBe("spawn");
    expect(failure.message).toContain("missing from this installation");
  });
});

describe("flow script executor — the protocol channel is the runner's alone", () => {
  it("ignores a readiness ping from the script instead of failing the run", async () => {
    const ws = workspace();
    // What a file written to double as a forked worker does on startup, itself
    // or through a dependency. `typeof process.send === "function"` steers it
    // straight into this, and under plain `node` the same check is a no-op.
    const script = ws.write(
      "pings.mjs",
      `if (process.send) process.send("ready");
       console.log("did the real work");
       output.ok = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ok: true });
    expect(result.log).toContain("did the real work");
  });

  it("ignores a verdict the script sends for itself", async () => {
    const ws = workspace();
    const script = ws.write(
      "forges.mjs",
      `process.send({ type: "result", outputJson: '{"forged":true}' });
       process._send?.({ type: "result", outputJson: '{"forgedLowLevel":true}' });
       output.real = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.output).toEqual({ real: true });
  });

  it("ignores a script disconnecting the channel", async () => {
    const ws = workspace();
    // Closing the channel would leave the run with no way to report at all,
    // and the runner's own disconnect handler made it look like the script had
    // stopped its own process.
    const script = ws.write("disconnects.mjs", `process.disconnect(); output.ok = true;`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ ok: true });
  });

  it("answers a send the script awaits instead of leaving it parked", async () => {
    const ws = workspace();
    // The guard swallowed the callback Node always calls, so the promise never
    // settled, the event loop emptied, and the step passed with the document
    // the script had reached before its second line.
    const script = ws.write(
      "awaits-send.mjs",
      `async function main() {
         await new Promise((resolve) => process.send({ hello: 1 }, resolve));
         console.log("past the send");
         output.done = true;
       }
       main();
       output.started = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ started: true, done: true });
    expect(result.log).toContain("past the send");
  });

  it("delivers the disconnect event to the script that asked for it", async () => {
    const ws = workspace();
    // Node emits `disconnect` after closing the channel; a stub that closed
    // nothing and emitted nothing left the same script parked forever.
    const script = ws.write(
      "awaits-disconnect.mjs",
      `async function main() {
         await new Promise((resolve) => {
           process.on("disconnect", resolve);
           process.disconnect();
         });
         console.log("past the disconnect");
         output.done = true;
       }
       main();
       output.started = true;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ started: true, done: true });
    expect(result.log).toContain("past the disconnect");
  });
});

describe("flow script executor — the runner's reporting path survives the script", () => {
  // Each of these is a script that otherwise finishes normally and that plain
  // `node` exits 0 with the right output. Each one took the runner's verdict
  // with it, and the step was reported as `exit` — "the script stopped its own
  // process ... no output was captured" — for a script that had done its work.
  const shapes: Array<[string, string]> = [
    ["replaced process.send", `process.send = () => true;`],
    ["deleted process.send", `delete process.send;`],
    ["removed every process listener", `process.removeAllListeners();`],
    ["removed the beforeExit listeners", `process.removeAllListeners("beforeExit");`],
  ];

  for (const [what, prelude] of shapes) {
    it(`still reports a script that ${what}`, async () => {
      const ws = workspace();
      const script = ws.write(
        "disturbs.mjs",
        `${prelude}\nconsole.log("did the work");\noutput.ok = true;`
      );
      const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

      expect(result.failure).toBeUndefined();
      expect(result.output).toEqual({ ok: true });
      expect(result.log).toContain("did the work");
    });
  }

  it("puts its listeners back in front of the ones a script registers after", async () => {
    const ws = workspace();
    // Order, not just presence. The runner re-registers inside
    // `removeAllListeners`, so its `uncaughtException` handler is first again —
    // and that handler decides whether the script has one of its own by asking
    // whether there is more than one. Put back *after* the script's, it would
    // see itself alone, claim the exception, and fail a step the script
    // recovered from; plain `node` runs the script's handler and exits 0.
    const script = ws.write(
      "reclaims.mjs",
      `process.removeAllListeners();
       process.on("uncaughtException", (err) => {
         console.log("script handled", err.message);
         output.recovered = true;
       });
       setTimeout(() => { throw new Error("late boom"); }, 10);`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ recovered: true });
    expect(result.log).toContain("script handled late boom");
  });
});

describe("flow script executor — redacting a document from a runner", () => {
  it("scrubs a document too deep for a recursive walk", async () => {
    // The output document came from a child that ran arbitrary code, so its
    // shape is not the parent's to assume: a nest of twenty thousand objects is
    // a legal document that `JSON.parse` reads without complaint and a
    // recursive scrub cannot walk — measured, a recursive walk gives up around
    // five thousand. `execute` owes its caller a verdict, not a stack overflow,
    // and the scrub is what stands between the secret and a document later
    // steps read.
    const depth = 20_000;
    let json = JSON.stringify("token sk-live-9d3f0a1b2c3d4e5f");
    for (let i = 0; i < depth; i++) json = `{"nested":${json}}`;
    const result = await withFakeRunner(
      `process.on("message", () => {
         process.send({ type: "started" });
         process.send({ type: "result", outputJson: ${JSON.stringify(json)} }, () => process.exit(0));
       });`,
      { secrets: [{ name: "TOKEN", value: "sk-live-9d3f0a1b2c3d4e5f" }] }
    );

    expect(result.failure).toBeUndefined();
    let node: unknown = result.output;
    for (let i = 0; i < depth; i++) node = (node as Record<string, unknown>).nested;
    expect(node).toBe("token {{secret:TOKEN}}");
  }, 30_000);
});

describe("flow script executor — the published layout", () => {
  it("runs from a directory holding only the three .mjs files", async () => {
    // In the published bundle the runner sits flat in dist/ beside
    // tool-server.cjs, with no package.json and no node_modules of its own. It
    // resolves both watchdogs against its own module URL, so nothing else has
    // to be there.
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "argent-script-dist-"));
    cleanups.push(() => fs.rmSync(dist, { recursive: true, force: true }));
    for (const name of fs.readdirSync(SOURCE_RUNNER_DIR).filter((f) => f.endsWith(".mjs"))) {
      fs.copyFileSync(path.join(SOURCE_RUNNER_DIR, name), path.join(dist, name));
    }
    expect(fs.readdirSync(dist).sort()).toEqual([
      "flow-script-runner.mjs",
      "flow-script-watchdog-deadline.mjs",
      "flow-script-watchdog-lifeline.mjs",
    ]);

    const ws = workspace();
    const script = ws.write("seed.mjs", `console.log("bundled"); output.ok = true;`);
    const shared = executor();
    await shared.execute({ scriptPath: script, projectRoot: ws.dir, runnerDir: dist });

    const started = Date.now();
    const result = await shared.execute({
      scriptPath: script,
      projectRoot: ws.dir,
      runnerDir: dist,
    });
    const roundTripMs = Date.now() - started;

    expect(result.ok).toBe(true);
    expect(result.log).toContain("bundled");
    // Process start cost, measured from the published layout: this is what
    // decides whether a process pool is ever worth adding. Measured at 31-45ms
    // over ten runs on an M-series laptop, both watchdog threads included, so
    // the bound below is two orders of magnitude of headroom for a loaded CI
    // box rather than a real expectation.
    expect(roundTripMs, `process start cost: ${roundTripMs}ms`).toBeLessThan(3_000);
  }, 30_000);
});

describe("flow script runner — the watchdogs, driven directly", () => {
  /**
   * Fork the real runner the way the executor does, without its time limit.
   * `request` overrides the well-formed message, for the child-side validation
   * cases.
   */
  function forkRunner(scriptPath: string, deadlineMs: number, request?: unknown) {
    const child = fork(scriptPath, [], {
      cwd: path.dirname(scriptPath),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ARGENT_FLOW_SCRIPT_RUNNER: "1",
      },
      execArgv: [
        "--max-old-space-size=512",
        "--import",
        pathToFileURL(path.join(SOURCE_RUNNER_DIR, "flow-script-runner.mjs")).href,
      ],
      stdio: ["ignore", "pipe", "pipe", "ipc", "pipe"],
      detached: process.platform !== "win32",
    });
    cleanups.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    child.send(
      request ?? {
        type: "execute",
        scriptUrl: pathToFileURL(fs.realpathSync(scriptPath)).href,
        outputJson: "{}",
        deadlineMs,
        maxOutputBytes: 1024 * 1024,
      }
    );
    return child;
  }

  function exitOf(child: ReturnType<typeof forkRunner>) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(
      (resolve) => {
        const started = Date.now();
        child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() - started }));
      }
    );
  }

  it.each([
    ["a request that is not an execute", { type: "run", scriptUrl: "file:///x", outputJson: "{}" }],
    [
      "a request with no script",
      { type: "execute", outputJson: "{}", deadlineMs: 1, maxOutputBytes: 1 },
    ],
    [
      "a request with a deadline that is not a number",
      {
        type: "execute",
        scriptUrl: "file:///x",
        outputJson: "{}",
        deadlineMs: "soon",
        maxOutputBytes: 1,
      },
    ],
  ])(
    "refuses %s, from the child's side of the protocol",
    async (_label, message) => {
      // Both sides validate every message; only the parent's half was covered.
      const ws = workspace();
      const script = ws.write("never.mjs", `output.ran = true;`);
      const child = forkRunner(script, 20_000, message);
      const failure = await new Promise<{ failureType?: string; message?: string } | null>(
        (resolve) => {
          child.on("message", (raw) => {
            const m = raw as { type?: string; failureType?: string; message?: string };
            if (m.type === "failure") resolve(m);
          });
          child.once("exit", () => resolve(null));
        }
      );

      expect(failure?.failureType).toBe("protocol");
      expect(failure?.message).toContain("malformed request");
    },
    30_000
  );

  it("obeys the first request and ignores a second", async () => {
    const ws = workspace();
    const script = ws.write("once.mjs", `output.runs = (output.runs ?? 0) + 1;`);
    const child = forkRunner(script, 20_000);
    child.send({
      type: "execute",
      scriptUrl: pathToFileURL(fs.realpathSync(script)).href,
      outputJson: JSON.stringify({ runs: 40 }),
      deadlineMs: 20_000,
      maxOutputBytes: 1024 * 1024,
    });
    const results: string[] = [];
    await new Promise<void>((resolve) => {
      child.on("message", (raw) => {
        const m = raw as { type?: string; outputJson?: string };
        if (m.type === "result") results.push(m.outputJson!);
      });
      child.once("exit", () => resolve());
    });

    // One run, from the first request: the second document never reached it.
    expect(results).toEqual([JSON.stringify({ runs: 1 })]);
  }, 30_000);

  it("does not run the script after refusing a malformed request", async () => {
    const ws = workspace();
    const marker = ws.resolve("ran.txt");
    // `finish` exits from inside a stream callback, so a runner that simply
    // returned here would let Node load the entry module in the meantime — and
    // the executor has already been told the run failed.
    const script = ws.write(
      "never.mjs",
      `import fs from "node:fs";
       fs.writeFileSync(${JSON.stringify(marker)}, "ran");`
    );
    const child = forkRunner(script, 20_000, { type: "run" });
    await exitOf(child);

    expect(fs.existsSync(marker)).toBe(false);
  }, 30_000);

  it("leaves when the parent closes the protocol channel", async () => {
    const ws = workspace();
    // The convenience path for a runner whose loop is still turning: the tool
    // server is gone, so nothing is waiting for a verdict.
    const script = ws.write("waits.mjs", `await new Promise(() => {});`);
    const child = forkRunner(script, 120_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.disconnect();
    const exit = await exitOf(child);

    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
    expect(exit.at).toBeLessThan(5_000);
  }, 30_000);

  it("stops a spinning script on its own deadline, with no help from the parent", async () => {
    // The child's copy of the time limit is the platform-neutral backstop: it
    // applies even when the parent is gone, and `Atomics.wait` behaves the same
    // everywhere.
    const ws = workspace();
    const script = ws.write("spin.mjs", `for (;;) {}`);
    const child = forkRunner(script, 1_200);
    const exit = await exitOf(child);

    expect(exit.signal).toBe("SIGKILL");
    expect(exit.at).toBeGreaterThan(1_000);
    expect(exit.at).toBeLessThan(6_000);
  }, 30_000);

  it("stops a spinning script when the parent's lifeline end closes", async () => {
    const ws = workspace();
    const script = ws.write("spin.mjs", `for (;;) {}`);
    // A deadline far past the assertion window, so only the lifeline can be
    // what stops it.
    const child = forkRunner(script, 120_000);
    const exit = exitOf(child);
    await new Promise((resolve) => setTimeout(resolve, 400));
    (child.stdio[4] as net.Socket | null)?.destroy();

    expect((await exit).signal).toBe("SIGKILL");
  }, 30_000);
});

describe("flow script executor — the lifeline end in the parent", () => {
  it("unrefs it so one script step cannot hold the tool server past idle shutdown", async () => {
    const original = net.Socket.prototype.unref;
    const unreffed: net.Socket[] = [];
    net.Socket.prototype.unref = function (this: net.Socket) {
      unreffed.push(this);
      return original.call(this);
    };
    cleanups.push(() => {
      net.Socket.prototype.unref = original;
    });

    const ws = workspace();
    const script = ws.write("quick.mjs", `output.ok = true;`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(true);
    // Node exposes stdio index 4 as a duplex Socket that holds a reference on
    // the tool server's event loop until it is unref'd.
    expect(unreffed.length).toBeGreaterThanOrEqual(1);
  });
});
