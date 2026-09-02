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

const strays: number[] = [];

afterEach(() => {
  while (strays.length) {
    try {
      process.kill(strays.pop()!, "SIGKILL");
    } catch {
      // Already gone.
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

/**
 * Windows reports an aborted child as an exit code, never as a signal, so the
 * heap row there cannot be reached from a POSIX host without saying which
 * platform the executor believes it is on.
 */
async function onWindows<T>(run: () => Promise<T>): Promise<T> {
  const real = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true });
  }
}

function stallFor(startMs: number, lengthMs: number): () => void {
  const timer = setTimeout(() => {
    const until = Date.now() + lengthMs;
    while (Date.now() < until) {
      /* block */
    }
  }, startMs);
  return () => clearTimeout(timer);
}

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
    const script = ws.write("hang.mjs", `setInterval(() => {}, 1000);`);
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 1_000,
    });
    const stall = setTimeout(() => {
      const until = Date.now() + 500;
      while (Date.now() < until) {
        /* block */
      }
    }, 800);
    const result = await pending;
    clearTimeout(stall);

    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.failure?.message).toContain("time limit");
  }, 30_000);

  it("still reports a timeout when the stall outlasts the child's own deadline", async () => {
    const ws = workspace();
    const script = ws.write("spin.mjs", `while (true) {}`);
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 400,
    });
    const until = Date.now() + 3_000;
    const stall = setTimeout(() => {
      while (Date.now() < until) {
        /* block */
      }
    }, 150);
    const result = await pending;
    clearTimeout(stall);

    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.failure?.message).toContain("time limit");
  }, 30_000);

  it("names a top-level await that never settles instead of waiting out the limit", async () => {
    const ws = workspace();
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
    const script = ws.write("hang.mjs", `setInterval(() => {}, 1000);`);
    const started = Date.now();
    const result = await executor({ maxTimeoutMs: 700 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
    });

    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.failure?.message).toContain("700ms time limit");
    expect(Date.now() - started).toBeLessThan(10_000);
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

  it("names a time limit with no number in it as unbounded rather than as a number", async () => {
    const ws = workspace();
    const script = ws.write("quick.mjs", `output.ok = true;`);
    const result = await executor({ maxTimeoutMs: 5_000 }).execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: Infinity,
    });

    expect(result.ok).toBe(true);
    expect(result.notes.join(" ")).toContain("The requested unbounded time limit is above");
    expect(result.notes.join(" ")).not.toContain("Infinity");
  });
});

describe("flow script executor — exit classification", () => {
  it("keeps the output of a script that finished and then exited zero", async () => {
    const ws = workspace();
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

  it("keeps an output too large for the pipe buffer when the script exits zero", async () => {
    const ws = workspace();
    // `process.send` only queues, and the exit that follows leaves before
    // libuv writes the rest: past about 64 KiB the verdict never arrived, and
    // the step was reported as self-termination with nothing captured.
    const script = ws.write(
      "big-exit.mjs",
      `output.blob = "x".repeat(900 * 1024);
       process.exit(0);`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.failure).toBeUndefined();
    expect((result.output?.blob as string).length).toBe(900 * 1024);
  }, 30_000);

  const EXITS_WITH_A_FULL_PIPE = `output.blob = "x".repeat(900 * 1024);
     process.exit(0);`;

  it("keeps that output when the server's loop stalls for seconds", async () => {
    const ws = workspace();
    const script = ws.write("big-exit-stalled.mjs", EXITS_WITH_A_FULL_PIPE);
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 20_000,
    });
    const endStall = stallFor(25, 3_000);
    const result = await pending;
    endStall();

    expect(result.failure).toBeUndefined();
    expect((result.output?.blob as string).length).toBe(900 * 1024);
  }, 30_000);

  it("still reports a timeout when nothing ever empties the pipe", async () => {
    const ws = workspace();
    const script = ws.write("big-exit-lost.mjs", EXITS_WITH_A_FULL_PIPE);
    const pending = executor().execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 400,
    });
    const endStall = stallFor(25, 8_000);
    const result = await pending;
    endStall();

    expect(result.failure?.kind).toBe(TIMEOUT);
    expect(result.failure?.message).toContain("time limit");
  }, 30_000);

  it("still fails a script that set process.exitCode and then exited", async () => {
    const ws = workspace();
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
    const script = ws.write(
      "soft-fail.mjs",
      `console.log("validation failed: 3 of 10 checks");
       output.failures = 3;
       process.exitCode = 1;`
    );
    const result = await executor().execute({ scriptPath: script, projectRoot: ws.dir });

    expect(result.ok).toBe(false);
    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toBe(
      "The script set process.exitCode to 1, which means it failed."
    );
    expect(result.log).toContain("validation failed");
  });

  it("reports a signal death as a runner error naming the signal", async () => {
    const ws = workspace();
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
    expect(result.log).not.toMatch(/^\s*\d+: 0x[0-9a-f]{6}/m);
  }, 60_000);

  it("still reports a heap limit when the script logged past its log budget first", async () => {
    const ws = workspace();
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

  it("calls an abort carrying the heap banner a heap limit, as Windows delivers one", async () => {
    const ws = workspace();
    const script = ws.write(
      "windows-oom.mjs",
      `process.stderr.write(
         "\\n<--- Last few GCs --->\\n" +
         "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n"
       );
       process.exit(3);`
    );
    const result = await onWindows(() =>
      executor({ heapLimitMb: 64 }).execute({
        scriptPath: script,
        projectRoot: ws.dir,
        timeoutMs: 30_000,
      })
    );

    expect(result.failure?.kind).toBe("heap");
    expect(result.failure?.message).toBe("The script exceeded its 64 MiB heap limit.");
  }, 30_000);

  it("does not call a Windows abort code without the heap banner a heap limit", async () => {
    const ws = workspace();
    const script = ws.write("plain-exit.mjs", `console.log("done"); process.exit(3);`);
    const result = await onWindows(() =>
      executor({ heapLimitMb: 64 }).execute({
        scriptPath: script,
        projectRoot: ws.dir,
        timeoutMs: 30_000,
      })
    );

    expect(result.failure?.kind).toBe("exit");
    expect(result.failure?.message).toContain("exit code 3");
  }, 30_000);
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
    // The descendant writes its own pid, and only after its handler is
    // installed: a pid written by the parent at spawn time races ahead of the
    // handler, so the abort following it is answered by a plain SIGTERM and the
    // test passes without the escalation it exists to prove.
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
    expect(isAlive(descendant)).toBe(false);
  }, 30_000);

  it("stops a descendant of a step that returned normally", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("left-behind.pid");
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

  // Both ways in, because a script can take the lifeline's end of file away:
  // descriptor 4 is a number script code can name, and the kernel drops a
  // closed descriptor from the poller with no event to hear. The parent's own
  // pid is what the watchdog reads then.
  it.each([
    ["leaves its lifeline alone", ""],
    ["closes the lifeline descriptor", "fs.closeSync(4);"],
  ])(
    "reaps a spinning orphan and its descendants when its parent is SIGKILLed and the script %s",
    async (_label, closesLifeline) => {
      const ws = workspace();
      const pidFile = ws.resolve("runner.pid");
      const descendantFile = ws.resolve("orphan-descendant.pid");
      // A descendant is what a real script leaves behind — an emulator, a Metro
      // — and the tool server that would have reaped it is the process being
      // killed here, so the runner's own group kill is the only thing left.
      const script = ws.write(
        "orphan.mjs",
        `import { spawn } from "node:child_process";
       import fs from "node:fs";
       ${closesLifeline}
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
         stdio: "ignore",
       });
       fs.writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid));
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
      let driverStderr = "";
      parent.stderr?.on("data", (chunk: Buffer) => {
        driverStderr += chunk.toString();
      });
      try {
        const runnerPid = await readPidFile(pidFile, 30_000, () => driverStderr);
        const descendantPid = await readPidFile(descendantFile, 30_000, () => driverStderr);
        strays.push(runnerPid, descendantPid);
        expect(isAlive(runnerPid)).toBe(true);
        expect(isAlive(descendantPid)).toBe(true);

        parent.kill("SIGKILL");
        expect(await waitForExit(runnerPid, 15_000)).toBe(true);
        expect(await waitForExit(descendantPid, 15_000)).toBe(true);
      } finally {
        parent.kill("SIGKILL");
        // Also when the poll above timed out: the runner is detached and spins,
        // so without this it outlives the suite until its own deadline reaps it.
        for (const file of [pidFile, descendantFile]) {
          try {
            const written = Number(fs.readFileSync(file, "utf8").trim());
            if (Number.isInteger(written)) strays.push(written);
          } catch {
            // Never written, so there is nothing to reap.
          }
        }
      }
    },
    60_000
  );

  // `taskkill /t` is the whole Windows stop path, on every timed-out or
  // cancelled step, and `spawn` reports a launch failure through an `error`
  // event that ends the tool server if it goes unhandled. Faking the platform
  // makes that branch reachable, and `taskkill` really is absent here.
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
    const shared = executor();
    await shared.execute({ scriptPath: script, projectRoot: ws.dir, timeoutMs: 40_000 });
    const result = await shared.execute({
      scriptPath: script,
      projectRoot: ws.dir,
      timeoutMs: 40_000,
    });

    expect(result.ok).toBe(true);
    // The deadline watchdog is parked in `Atomics.wait` for the whole window
    // and the lifeline waits on a socket that will not close: an un-unref'd
    // worker would hold the child open to the deadline, turning this into a 40s
    // timeout instead of an output in tens of milliseconds.
    expect(result.durationMs).toBeLessThan(3_000);
  }, 60_000);

  it("hold the margin open for a stalled tool server, then take the whole group", async () => {
    const ws = workspace();
    const pidFile = ws.resolve("stalled-descendant.pid");
    const script = ws.write(
      "spawner.mjs",
      `import { spawn } from "node:child_process";
       import fs from "node:fs";
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
         stdio: "ignore",
       });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       for (;;) {}`
    );
    const timeoutMs = 2_000;
    const startedAt = Date.now();
    const pending = executor().execute({ scriptPath: script, projectRoot: ws.dir, timeoutMs });
    const descendant = await readPidFile(pidFile);
    strays.push(descendant);

    // Blocked from here on, so nothing this side would do — the time limit's
    // timer, the process-tree stop it schedules — can run. What reaches this
    // descendant reaches it from inside the child, through the group its
    // deadline watchdog kills.
    const probe = (afterDeadlineMs: number) => {
      while (Date.now() - startedAt < timeoutMs + afterDeadlineMs) {
        /* block */
      }
      return isAlive(descendant);
    };
    const withinMargin = probe(1_200);
    const pastMargin = probe(3_500);
    const result = await pending;

    // A stall of an ordinary width — `stop-metro` shells out to `lsof` and
    // `netstat` — still finds a live child to stop itself.
    expect(withinMargin).toBe(true);
    // Past the margin the child stops the whole group rather than only itself,
    // so a descendant the tool server can no longer reap goes with it.
    expect(pastMargin).toBe(false);
    expect(result.failure?.kind).toBe(TIMEOUT);
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
