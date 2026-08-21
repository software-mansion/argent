import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptExecutorOptions,
  type FlowScriptFailureKind,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("life");
  workspaces.push(ws);
  return ws;
}

/** Pids a test started outside the executor's reach; killed however it ends. */
const strays: number[] = [];

afterEach(() => {
  // A descendant is only stopped by the behaviour under test, so a failing
  // assertion would otherwise leave a spinning process behind — observed for
  // real: a `node -e setInterval(...)` still alive 32s after vitest exited.
  while (strays.length) {
    try {
      process.kill(strays.pop()!, "SIGKILL");
    } catch {
      // Already gone, which is the outcome the test wanted.
    }
  }
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function executor(options: FlowScriptExecutorOptions = {}): FlowScriptExecutor {
  return new FlowScriptExecutor({ concurrency: 4, maxTimeoutMs: 60_000, ...options });
}

const TIMEOUT: FlowScriptFailureKind = "timeout";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `file` exists and holds a pid, or give up. */
async function readPidFile(
  file: string,
  timeoutMs = 10_000,
  diagnostics?: () => string
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw) return Number(raw);
    } catch {
      // Not written yet.
    }
    await delay(50);
  }
  const detail = diagnostics?.().trim();
  throw new Error(`No pid appeared in ${file}${detail ? `\n${detail}` : ""}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(50);
  }
  return false;
}

describe("flow script executor — time limits and cancellation", () => {
  it("stops a synchronous infinite loop at the time limit", async () => {
    const ws = workspace();
    const script = ws.write("spin.mjs", `for (;;) {}`);
    const started = Date.now();
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 800,
    });

    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.failure?.message).toContain("800ms time limit");
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("stops a script holding the event loop open at the time limit", async () => {
    const ws = workspace();
    const script = ws.write("hang.mjs", `setInterval(() => {}, 1000);`);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 700,
    });

    expect(result.failure?.kind).toBe("timeout");
  });

  it("still reports a timeout when the tool server's own loop stalls across the limit", async () => {
    const ws = workspace();
    // The child keeps its own copy of the limit as the backstop for a parent
    // that cannot act. Given the same number as the parent's timer, its only
    // margin was the child's boot time — so one synchronous child-process call
    // on the server's loop across the moment the limit expired let the child
    // SIGKILL its own group first, and the step was reported as an unexplained
    // signal instead of the timeout it was.
    const script = ws.write("hang.mjs", `setInterval(() => {}, 1000);`);
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 1_000,
    });
    const stall = setTimeout(() => {
      const until = Date.now() + 500;
      // Exactly what `execFileSync("lsof")` does to this loop.
      while (Date.now() < until) {
        /* block */
      }
    }, 800);
    const result = await pending;
    clearTimeout(stall);

    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.failure?.message).toContain("time limit");
  }, 30_000);

  it("names a top-level await that never settles instead of waiting out the limit", async () => {
    const ws = workspace();
    // Nothing is left to run, so the step does not have to occupy its slot
    // until the time limit to know the script will never produce output.
    const script = ws.write("unsettled.mjs", `await new Promise(() => {});`);
    const started = Date.now();
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 20_000,
    });

    expect(result.failure?.kind).toBe("runtime");
    expect(result.failure?.message).toContain("never settled");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("keeps the logs a timed-out script already wrote", async () => {
    const ws = workspace();
    const script = ws.write(
      "noisy-hang.mjs",
      `console.log("started the seed"); setInterval(() => {}, 1000);`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 700,
    });

    expect(result.failure?.kind).toBe("timeout");
    expect(result.log).toContain("started the seed");
  });

  it("cancels a running script when the signal aborts", async () => {
    const ws = workspace();
    const script = ws.write("slow.mjs", `await new Promise((r) => setTimeout(r, 30000));`);
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await delay(300);
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it("honours an abort raised in the same tick as the call", async () => {
    const ws = workspace();
    const script = ws.write(
      "slow.mjs",
      `await new Promise((r) => setTimeout(r, 2000));
       console.log("finished work");
       output.done = true;`
    );
    const controller = new AbortController();
    // The queue reads the signal, then hands back a promise; the run's own
    // listener is attached a microtask later. An abort landing in between fires
    // no listener, and nothing else re-read the flag — so the cancellation was
    // lost for the whole life of the step.
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
    expect(result.log).not.toContain("finished work");
    expect(result.durationMs).toBeLessThan(1_000);
  });

  it("does not relabel a cancellation as a timeout when the deadline passes mid-stop", async () => {
    const ws = workspace();
    // A script that ignores SIGTERM outlives the polite stop, so its deadline
    // can pass during the stop grace. The first interruption is the true one.
    const script = ws.write(
      "stubborn.mjs",
      `process.on("SIGTERM", () => {});
       setInterval(() => {}, 1000);`
    );
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 800,
      signal: controller.signal,
    });
    await delay(300);
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
  }, 30_000);

  // The ordinary graceful-shutdown shape, and the one that turned a stop into a
  // pass: the SIGTERM handler releases what was holding the event loop, the
  // loop empties, and the runner reports the half-written document as a result
  // — *because* of the stop. `work aborted` in the log is the proof that this
  // is the shape under test and not a script that simply ignored the signal.
  const GRACEFUL_SIGTERM = `import { setTimeout as delay } from "node:timers/promises";
     output.phase = "seeding";
     const ac = new AbortController();
     process.on("SIGTERM", () => ac.abort());
     async function main() {
       try { await delay(60000, undefined, { signal: ac.signal }); }
       catch { console.log("work aborted"); return; }
       output.phase = "done";
     }
     main();`;

  it("fails a timed-out script that shuts down gracefully on SIGTERM", async () => {
    const ws = workspace();
    const script = ws.write("graceful.mjs", GRACEFUL_SIGTERM);
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 700,
    });

    expect(result.log).toContain("work aborted");
    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.ok).toBe(false);
    expect(result.output).toBeUndefined();
  }, 30_000);

  it("keeps a cancellation a cancellation when the script shuts down gracefully", async () => {
    const ws = workspace();
    const script = ws.write("graceful.mjs", GRACEFUL_SIGTERM);
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    await delay(300);
    controller.abort();
    const result = await pending;

    expect(result.log).toContain("work aborted");
    expect(result.failure?.kind).toBe("cancelled");
    expect(result.ok).toBe(false);
    expect(result.output).toBeUndefined();
  }, 30_000);

  /**
   * Block the vitest loop across the moment the stop is sent, the way one
   * `execFileSync` on the tool server's loop does. A run of overlapping timers
   * is what makes the stall straddle the limit however the two clocks line up.
   */
  function stallAcross(fromMs: number, toMs: number): () => void {
    const timers: NodeJS.Timeout[] = [];
    for (let at = fromMs; at <= toMs; at++) {
      timers.push(
        setTimeout(() => {
          const until = Date.now() + 6;
          while (Date.now() < until) {
            /* block */
          }
        }, at)
      );
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }

  // Both halves of the shape together: a script that answers SIGTERM *and* a
  // parent whose loop is blocked across the stop. Sealing the interruption one
  // turn after the kill was sent left exactly a stall's worth of room for the
  // stop's own verdict to arrive unsealed, and the step was reported as a pass
  // carrying the document the SIGTERM handler wrote.
  const EXITS_ON_SIGTERM = `output.phase = "half-written";
     const held = setInterval(() => {}, 1000);
     process.on("SIGTERM", () => {
       clearInterval(held);
       output.phase = "cleaned-up";
       console.log("work aborted");
       process.exit(0);
     });`;

  it("fails a timed-out script that exits zero from its SIGTERM handler while the server stalls", async () => {
    const ws = workspace();
    const script = ws.write("graceful-exit.mjs", EXITS_ON_SIGTERM);
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 400,
    });
    const endStall = stallAcross(385, 445);
    const result = await pending;
    endStall();

    expect(result.log).toContain("work aborted");
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.output).toBeUndefined();
  }, 30_000);

  it("keeps a cancellation a cancellation when the server stalls across the stop", async () => {
    const ws = workspace();
    const script = ws.write("graceful-exit.mjs", EXITS_ON_SIGTERM);
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    const abort = setTimeout(() => controller.abort(), 400);
    const endStall = stallAcross(385, 445);
    const result = await pending;
    clearTimeout(abort);
    endStall();

    expect(result.log).toContain("work aborted");
    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("cancelled");
    expect(result.output).toBeUndefined();
  }, 30_000);

  it("refuses a step whose signal is already aborted, without spawning", async () => {
    const ws = workspace();
    const marker = ws.resolve("ran.txt");
    // The claim is "without spawning", and the marker is what proves it: a
    // process that started would have written the file before it could be
    // stopped. `durationMs` cannot prove it — `emptyResult` hardcodes zero.
    const script = ws.write(
      "never.mjs",
      `import fs from "node:fs";
       fs.writeFileSync(${JSON.stringify(marker)}, "ran");
       output.ran = true;`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      signal: AbortSignal.abort(),
    });

    expect(result.failure?.kind).toBe("cancelled");
    expect(result.output).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("bounds a step that asked for nothing by the host maximum, not by the default", async () => {
    const ws = workspace();
    // A host that deliberately tightened its ceiling below the 30s default was
    // getting the default on every step that named no limit of its own.
    const script = ws.write("hang.mjs", `setInterval(() => {}, 1000);`);
    const started = Date.now();
    const result = await executor({ maxTimeoutMs: 700 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
    });

    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.failure?.message).toContain("700ms time limit");
    expect(Date.now() - started).toBeLessThan(10_000);
    // Silently bounded: the note is for a caller that asked for more.
    expect(result.notes).toEqual([]);
  }, 30_000);

  it("clamps a time limit above the host maximum and says so", async () => {
    const ws = workspace();
    const script = ws.write("quick.mjs", `output.ok = true;`);
    const result = await executor({ maxTimeoutMs: 5_000 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 600_000,
    });

    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("above this host's maximum of 5s");
  });
});

describe("flow script executor — exit classification", () => {
  it("keeps the output of a script that finished and then exited zero", async () => {
    const ws = workspace();
    // A very common idiom, and it was a hard failure: `beforeExit` does not
    // fire after an explicit exit, so the runner never reported and the parent
    // said "no output was captured" about a script whose log proves the work
    // was done. Exiting with zero is the script declaring success.
    const script = ws.write(
      "exits.mjs",
      `async function main() { output.orderId = "ord_1"; console.log("seeded"); }
       main().then(() => process.exit(0));`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect(result.output).toEqual({ orderId: "ord_1" });
    expect(result.log).toContain("seeded");
  });

  it("still fails a script that set process.exitCode and then exited", async () => {
    const ws = workspace();
    // `process.exit()` with no argument leaves the code the script set. The
    // guard above must forward that call by arity: `exit(undefined)` is a
    // different call from `exit()`, and it loses the code.
    const script = ws.write("bad.cjs", `output.a = 1; process.exitCode = 3; process.exit();`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("exit code 3");
    expect(result.output).toBeUndefined();
  });

  it("names the exit code when the script stops its own process", async () => {
    const ws = workspace();
    const script = ws.write("bye.mjs", `console.log("leaving"); process.exit(3);`);
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("exit code 3");
    expect(result.log).toContain("leaving");
  });

  it("fails a step whose script set a non-zero process.exitCode", async () => {
    const ws = workspace();
    // `try { await main() } catch (e) { console.error(e); process.exitCode = 1 }`
    // is the recommended way to fail a script, preferred over `process.exit(1)`
    // because it does not truncate stdout. Both have to reach the same verdict.
    const script = ws.write(
      "soft-fail.mjs",
      `console.log("validation failed: 3 of 10 checks");
       output.failures = 3;
       process.exitCode = 1;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("exit");
    // The code itself, not a substring of it: `toContain("1")` also matches 11.
    expect(result.failure?.message).toBe(
      "The script set process.exitCode to 1, which means it failed."
    );
    expect(result.log).toContain("validation failed");
  });

  it("reports a signal death as a runner error naming the signal", async () => {
    const ws = workspace();
    // A process killed by a signal did not choose to stop; calling that
    // self-termination would send the author to the wrong line of code.
    const script = ws.write(
      "signal.mjs",
      `process.kill(process.pid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 5000));`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure?.kind).toBe("signal");
    expect(result.failure?.message).toContain("SIGTERM");
    expect(result.failure?.message).toContain("did not stop itself");
  });

  it("reports heap exhaustion as a heap limit, collapses the frame dump and keeps the script's own logs", async () => {
    const ws = workspace();
    const script = ws.write(
      "hungry.mjs",
      `console.log("allocating");
       const held = [];
       for (;;) held.push("x".repeat(1024 * 1024));`
    );
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.failure?.kind).toBe("heap");
    expect(result.failure?.message).toBe("The script exceeded its 64 MiB heap limit.");
    expect(result.log).toContain("allocating");
    expect(result.log).toMatch(/\[\d+ V8 stack frames omitted]/);
    // The numbered frame list is gone; the summary that names the cause is not.
    expect(result.log).not.toMatch(/^\s*\d+: 0x[0-9a-f]{6}/m);
  }, 60_000);

  it("still reports a heap limit when the script logged past its log budget first", async () => {
    const ws = workspace();
    // V8 prints its banner last, so a script chatty enough to fill the step's
    // log budget loses the one line that names the cause — and "a progress line
    // per item, then out of heap" is the ordinary shape of a script that hits
    // this limit. The verdict cannot be read off the truncated log.
    const script = ws.write(
      "chatty-hungry.mjs",
      `for (let i = 0; i < 2000; i++) console.log("progress line " + i + " ".repeat(120));
       const held = [];
       for (;;) held.push("x".repeat(1024 * 1024));`
    );
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.logTruncated).toBe(true);
    expect(result.failure?.kind).toBe("heap");
    expect(result.failure?.message).toBe("The script exceeded its 64 MiB heap limit.");
  }, 60_000);

  it("does not call an abort with no heap banner a heap limit", async () => {
    const ws = workspace();
    // `process.abort()` and a native addon's `abort()` both raise SIGABRT
    // without allocating anything. The signal alone is not the evidence — the
    // banner beside it is — and naming a limit this process never approached
    // sends the author to the wrong place.
    const script = ws.write("aborts.mjs", `console.log("about to abort"); process.abort();`);
    const result = await executor({ heapLimitMb: 64 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.failure?.kind).toBe("signal");
    expect(result.failure?.message).toContain("SIGABRT");
    expect(result.log).toContain("about to abort");
  }, 30_000);

  it("does not call a forwarded 134 exit status a heap limit", async () => {
    const ws = workspace();
    // A wrapper that runs a build through a shell and forwards its status: the
    // shell reports the aborted build as 128+SIGABRT, and the build's own
    // banner lands in the stream this script inherited. Neither is this
    // process running out of heap.
    ws.write("build.mjs", `const held = []; for (;;) held.push("x".repeat(1024 * 1024));`);
    const script = ws.write(
      "wrapper.mjs",
      `import { spawnSync } from "node:child_process";
       const r = spawnSync(
         "/bin/sh",
         ["-c", process.execPath + " --max-old-space-size=40 build.mjs 2>&1"],
         { encoding: "utf8" }
       );
       console.log(r.stdout);
       process.exit(r.status ?? 0);`
    );
    const result = await executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 30_000,
    });

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("exit code 134");
  }, 60_000);
});

describe("flow script executor — process cleanup", () => {
  it("stops a descendant the script started when the step times out", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("descendant.pid");
    const script = ws.write(
      "spawner.mjs",
      `import { spawn } from "node:child_process";
       import fs from "node:fs";
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       await new Promise(() => {});`
    );
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 1_500,
    });
    const descendant = await readPidFile(pidFile);
    strays.push(descendant);
    expect(isAlive(descendant)).toBe(true);

    const result = await pending;
    expect(result.failure?.kind).toBe("timeout");
    expect(await waitForExit(descendant, 8_000)).toBe(true);
  }, 30_000);

  it("stops a descendant that ignores SIGTERM when the step is cancelled", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("stubborn.pid");
    // A descendant with its own SIGTERM handler outlives the polite stop. The
    // runner does not — it has no handler and dies in milliseconds — so a
    // forced stop conditioned on the runner alone never happened.
    //
    // The descendant writes its own pid, and only after its handler is
    // installed. Written by the parent at spawn time, the pid appeared within a
    // few milliseconds — usually before the handler existed — so an abort that
    // followed it was answered by a plain SIGTERM, and the test passed with the
    // escalation under it removed about four times in five.
    const descendantSource =
      'process.on("SIGTERM", () => {});' +
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
      "setInterval(() => {}, 1000)";
    const script = ws.write(
      "stubborn.mjs",
      `import { spawn } from "node:child_process";
       spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
       setInterval(() => {}, 1000);`
    );
    const controller = new AbortController();
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 20_000,
      signal: controller.signal,
    });
    const descendant = await readPidFile(pidFile);
    strays.push(descendant);
    controller.abort();
    const result = await pending;

    expect(result.failure?.kind).toBe("cancelled");
    // The step says the process tree was stopped, so it has to be stopped by
    // the time the step returns — not merely asked to stop.
    expect(isAlive(descendant)).toBe(false);
  }, 30_000);

  it("stops a descendant of a step that returned normally", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("left-behind.pid");
    // Nothing interrupted this step: the script started a subprocess, returned
    // its output and exited, and the subprocess was reparented to init.
    const script = ws.write(
      "leaver.mjs",
      `import { spawn } from "node:child_process";
       import fs from "node:fs";
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
         stdio: "ignore",
       });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       child.unref();
       output.started = child.pid;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });
    strays.push(result.output?.started as number);

    expect(result.ok).toBe(true);
    expect(isAlive(result.output?.started as number)).toBe(false);
  }, 30_000);

  it("reaps a spinning orphan when its parent is SIGKILLed", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("runner.pid");
    const script = ws.write(
      "orphan.mjs",
      `import fs from "node:fs";
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
       for (;;) {}`
    );
    const driver = path.resolve(__dirname, "../../fixtures/flow-script-orphan-driver.ts");
    const parent = spawn(
      process.execPath,
      [
        require.resolve("ts-node/dist/bin.js"),
        "-T",
        "-P",
        path.resolve(__dirname, "../../../tsconfig.json"),
        driver,
        script,
        ws.dir,
      ],
      { cwd: path.resolve(__dirname, "../../.."), stdio: ["ignore", "ignore", "pipe"] }
    );
    // Captured, because everything this test can go wrong about happens inside
    // that process: without it a driver that failed to start showed up as an
    // opaque "No pid appeared in …" thirty seconds later.
    let driverStderr = "";
    parent.stderr?.on("data", (chunk: Buffer) => {
      driverStderr += chunk.toString();
    });
    try {
      const runnerPid = await readPidFile(pidFile, 30_000, () => driverStderr);
      strays.push(runnerPid);
      expect(isAlive(runnerPid)).toBe(true);

      // The tool server dies without a chance to clean up. A group stop would
      // not reach the detached runner and its `disconnect` handler can never run
      // while the main thread spins, so only the lifeline thread can stop it.
      parent.kill("SIGKILL");
      expect(await waitForExit(runnerPid, 15_000)).toBe(true);
    } finally {
      parent.kill("SIGKILL");
      // Also when the poll above timed out: the runner is detached and spins,
      // so without this it outlives the suite until its own deadline reaps it.
      try {
        const written = Number(fs.readFileSync(pidFile, "utf8").trim());
        if (Number.isInteger(written)) strays.push(written);
      } catch {
        // Never written, so there is nothing to reap.
      }
    }
  }, 60_000);

  // Windows has no process group, so `taskkill /t` is the whole stop path
  // there, on every timed-out or cancelled step. `spawn` reports a failure to
  // launch through an `error` event rather than a throw, and an unhandled
  // `error` event ends the process it fires in — the tool server. Faking the
  // platform is what makes the branch reachable from here, and `taskkill` is
  // genuinely absent on a POSIX host, so the launch failure is a real one.
  it("survives a Windows stop whose taskkill cannot be launched", async () => {
    const ws = workspace();
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const script = ws.write("hang.mjs", `setInterval(() => {}, 1000);`);
      const result = await executor().execute({
        scriptPath: script,
        projectRoot: ws.dir,
        timeoutMs: 400,
      });

      expect(result.failure?.kind).toBe(TIMEOUT);
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    }
  }, 30_000);
});

describe("flow script watchdogs", () => {
  it("never hold a finished script open, and cost it very little", async () => {
    const ws = workspace();
    const script = ws.write("empty.mjs", `output.ok = true;`);
    // Warm the module cache so the number reflects process start, not the
    // first-import cost of this test file.
    const shared = executor();
    await shared.execute({ scriptPath: script, projectRoot: ws.dir, timeoutMs: 40_000 });
    const result = await shared.execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 40_000,
    });

    expect(result.ok).toBe(true);
    // The deadline watchdog is parked in `Atomics.wait` for that whole 40s and
    // the lifeline is waiting on a socket that will not close: an un-unref'd
    // worker would hold the process to the deadline, and the step would return
    // a timeout 40 seconds from now instead of an output in tens of
    // milliseconds. Both threads run for this whole window, and it is still
    // well under a second on a loaded CI box.
    expect(result.durationMs).toBeLessThan(3_000);
  }, 60_000);
});

describe("flow script executor — the configured maximum", () => {
  it("names a multi-minute maximum in minutes", async () => {
    const ws = workspace();
    const script = ws.write("quick.mjs", `output.ok = true;`);
    const result = await executor({ maxTimeoutMs: 5 * 60_000 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 10 * 60_000,
    });

    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("above this host's maximum of 5m");
  });
});
