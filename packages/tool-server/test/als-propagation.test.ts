/**
 * Behavioural reference for `runWithContext` / `requireProjectRoot`
 * (packages/tool-server/src/request-context.ts) under every async boundary
 * that matters for the tool-server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT NODE'S AsyncLocalStorage ACTUALLY DOES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The store you see inside a callback is the one that was **active when the
 * callback ran**, not the one that was active when the callback was attached.
 * `.on()` does NOT close over the enclosing ALS frame. This is the single
 * fact that explains every test below.
 *
 *   SAFE — ALS propagates correctly:
 *     - native Promise chains and `await`
 *     - microtasks, queueMicrotask, process.nextTick
 *     - setImmediate, setTimeout, setInterval
 *     - fs.createReadStream / Writable / Duplex stream events
 *     - EventEmitter listeners when the `.emit()` call happens INSIDE a
 *       runWithContext frame — the listener runs inside that frame even if
 *       it was attached outside
 *     - concurrent runWithContext calls — each frame is perfectly isolated
 *
 *   LATENT TRAPS — requireProjectRoot() WILL throw if reached via:
 *
 *     1. Any listener whose `.emit()` fires **outside** an active request frame.
 *        Concrete realisation: `res.on('close', ...)` in http.ts fires after
 *        the handler has returned; the callback sees no frame. Today that
 *        handler only calls `controller.abort()` so there is no bug, but any
 *        future change that reaches requireProjectRoot() from there throws.
 *
 *     2. worker_threads.Worker — the worker has its own async universe.
 *        tool-server/src does NOT currently spawn Workers, so no bug today,
 *        but any future tool that offloads CPU work (tree-sitter parse pool,
 *        source-map resolution pool) must forward projectRoot explicitly via
 *        workerData or postMessage. Silent regression risk.
 *
 *     3. child_process.spawn / .fork — subprocess has no parent ALS.
 *        tool-server already passes config via argv/env everywhere, but a
 *        future author reaching for requireProjectRoot() inside a child
 *        process will get an empty store.
 *
 *     4. Blueprints that attach listeners to long-lived IPC at
 *        service-factory time and fire them OUTSIDE any request. Concrete
 *        risk sites (none call requireProjectRoot today):
 *          - blueprints/react-profiler-session.ts L97-104
 *          - blueprints/js-runtime-debugger.ts L121, L145
 *          - blueprints/simulator-server.ts L107-112
 *          - blueprints/ax-service.ts L58-70, L141-172
 *          - blueprints/native-devtools.ts L331, L342
 *        If a future change reads projectRoot from one of these, it throws
 *        under real traffic. Trap is silent until it fires.
 *
 *   ADJACENT (not ALS, but flagged for the audit) — cross-project leak via
 *   module-level singletons that are not keyed by projectRoot:
 *     - tools/flows/flow-utils.ts `activeFlowName` is a process-wide global.
 *       Covered in its own test file (als-state-contamination.test.ts).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The tests below are grouped into two describe blocks: SAFE baselines prove
 * ALS does what the handler code assumes, and LATENT TRAPS prove the
 * boundaries the reader must NOT cross. Every assertion matches actual Node
 * behaviour — none of these are expected to "fail to prove a bug".
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Worker, isMainThread } from "node:worker_threads";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runWithContext, requireProjectRoot } from "../src/request-context";

// ─────────────────────────────────────────────────────────────────────────────
// SAFE — ALS propagates correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("ALS propagation — SAFE baselines", () => {
  it("propagates through a simple await [SAFE]", async () => {
    const root = await runWithContext({ projectRoot: "/proj/a" }, async () => {
      await Promise.resolve();
      return requireProjectRoot();
    });
    expect(root).toBe("/proj/a");
  });

  it("propagates through deeply nested awaits [SAFE]", async () => {
    const root = await runWithContext({ projectRoot: "/proj/nested" }, async () => {
      await Promise.resolve();
      await Promise.resolve();
      await (async () => {
        await (async () => {
          await Promise.resolve();
        })();
      })();
      return requireProjectRoot();
    });
    expect(root).toBe("/proj/nested");
  });

  it("propagates through setImmediate [SAFE]", async () => {
    const root = await runWithContext({ projectRoot: "/proj/immediate" }, async () => {
      return new Promise<string>((resolve) => {
        setImmediate(() => resolve(requireProjectRoot()));
      });
    });
    expect(root).toBe("/proj/immediate");
  });

  it("propagates through setTimeout [SAFE]", async () => {
    const root = await runWithContext({ projectRoot: "/proj/timeout" }, async () => {
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve(requireProjectRoot()), 5);
      });
    });
    expect(root).toBe("/proj/timeout");
  });

  it("propagates through process.nextTick [SAFE]", async () => {
    const root = await runWithContext({ projectRoot: "/proj/nextTick" }, async () => {
      return new Promise<string>((resolve) => {
        process.nextTick(() => resolve(requireProjectRoot()));
      });
    });
    expect(root).toBe("/proj/nextTick");
  });

  it("propagates through queueMicrotask [SAFE]", async () => {
    const root = await runWithContext({ projectRoot: "/proj/micro" }, async () => {
      return new Promise<string>((resolve) => {
        queueMicrotask(() => resolve(requireProjectRoot()));
      });
    });
    expect(root).toBe("/proj/micro");
  });

  it("propagates through fs.createReadStream 'data' events [SAFE]", async () => {
    const tmp = path.join(os.tmpdir(), `als-stream-${Date.now()}.txt`);
    fs.writeFileSync(tmp, "hello-stream");
    try {
      const root = await runWithContext({ projectRoot: "/proj/stream" }, async () => {
        return new Promise<string>((resolve, reject) => {
          const rs = fs.createReadStream(tmp);
          let seen: string | undefined;
          rs.on("data", () => {
            try {
              seen = requireProjectRoot();
            } catch (err) {
              reject(err);
            }
          });
          rs.on("end", () => resolve(seen ?? "MISSING"));
          rs.on("error", reject);
        });
      });
      expect(root).toBe("/proj/stream");
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  it("isolates concurrent frames with different roots [SAFE]", async () => {
    const roots = ["/proj/p1", "/proj/p2", "/proj/p3", "/proj/p4"];
    const observed = await Promise.all(
      roots.map((r) =>
        runWithContext({ projectRoot: r }, async () => {
          // Yield through a few async hops to interleave the frames.
          await Promise.resolve();
          await new Promise<void>((res) => setImmediate(res));
          await new Promise<void>((res) => setTimeout(res, 1));
          return requireProjectRoot();
        })
      )
    );
    expect(observed).toEqual(roots);
  });

  it("listener attached OUTSIDE any frame sees the emit-time frame when fired synchronously from inside one [SAFE]", async () => {
    // This is the exact shape of blueprints/react-profiler-session.ts
    // `cdp.events.on('scriptParsed', ...)` — a listener attached at service-
    // factory time (with NO active ALS frame) that later gets triggered
    // synchronously from inside a tool handler.
    //
    // Node's ALS semantics are emit-time, not attach-time: the listener runs
    // inside whatever frame is active when emit() is called. Attaching
    // outside a frame is NOT an automatic "empty store forever" — it just
    // means the store depends on where the .emit() happens.
    //
    // Upshot for the codebase: factory-time listeners fired synchronously
    // from inside a tool handler DO see the handler's projectRoot. Good.
    const emitter = new EventEmitter();
    let capturedRoot: string | undefined;

    // Attach at "blueprint factory" time — no ALS frame active.
    emitter.on("scriptParsed", () => {
      capturedRoot = requireProjectRoot();
    });

    // Inside a real request frame, synchronously cause the listener to fire.
    await runWithContext({ projectRoot: "/proj/request-A" }, async () => {
      emitter.emit("scriptParsed");
    });

    expect(capturedRoot).toBe("/proj/request-A");
  });

  it("shared emitter: concurrent requests get perfect isolation because the listener runs in the emit-time frame [SAFE]", async () => {
    // Two frames attach their own listeners to the same long-lived emitter,
    // then each request fires the event from inside its own frame. Neither
    // listener leaks across frames: whoever .emit()s is the frame the
    // listener runs in.
    const emitter = new EventEmitter();
    const seen: Array<{ which: string; root: string }> = [];

    // Both listeners were attached without any surrounding frame.
    emitter.on("hotCommit", () => {
      seen.push({ which: "listener-1", root: requireProjectRoot() });
    });
    emitter.on("hotCommit", () => {
      seen.push({ which: "listener-2", root: requireProjectRoot() });
    });

    // Request A synchronously fires the event from inside its own frame.
    await runWithContext({ projectRoot: "/proj/A" }, async () => {
      emitter.emit("hotCommit");
    });

    // Request B does the same with a different root.
    await runWithContext({ projectRoot: "/proj/B" }, async () => {
      emitter.emit("hotCommit");
    });

    expect(seen).toEqual([
      { which: "listener-1", root: "/proj/A" },
      { which: "listener-2", root: "/proj/A" },
      { which: "listener-1", root: "/proj/B" },
      { which: "listener-2", root: "/proj/B" },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LATENT TRAPS — behaviours a future author MUST know about before reaching
// for requireProjectRoot() in a new context. Each test proves the limit
// rather than a bug in the current code; nothing in the tree today falls
// into any of these holes.
// ─────────────────────────────────────────────────────────────────────────────

describe("ALS propagation — LATENT TRAPS", () => {
  it("listener fired AFTER runWithContext returns sees no frame [TRAP]", async () => {
    // Concrete shape: http.ts L116 attaches `res.on('close', ...)` inside the
    // request handler. If the client aborts, the close handler fires after
    // the awaited handler body has already returned — fully outside the
    // runWithContext frame. The handler currently only calls
    // controller.abort() so there is no bug, but the trap is primed: any
    // future change that reads projectRoot from inside this listener will
    // throw.
    const emitter = new EventEmitter();
    let seenError: unknown;

    await runWithContext({ projectRoot: "/proj/res-close" }, async () => {
      emitter.on("close", () => {
        try {
          requireProjectRoot();
        } catch (err) {
          seenError = err;
        }
      });
    });

    // Fire the event AFTER runWithContext has returned — no frame is active.
    await new Promise<void>((resolve) => setImmediate(resolve));
    emitter.emit("close");

    expect(seenError).toBeInstanceOf(Error);
    expect((seenError as Error).message).toContain("No project root in request context");
  });

  it("listener attached inside a frame, fired via setImmediate from outside, sees no frame [TRAP]", async () => {
    // Same class as above but with the timer path: attach the listener while
    // a frame is active, schedule its fire via setImmediate from outside the
    // frame. The listener runs with an empty store.
    const emitter = new EventEmitter();
    let capturedRoot: string | undefined;
    let capturedError: unknown;

    await runWithContext({ projectRoot: "/proj/late-fire" }, async () => {
      emitter.on("ping", () => {
        try {
          capturedRoot = requireProjectRoot();
        } catch (err) {
          capturedError = err;
        }
      });
    });

    // Fire from outside the frame.
    await new Promise<void>((resolve) => setImmediate(resolve));
    emitter.emit("ping");

    expect(capturedRoot).toBeUndefined();
    expect(capturedError).toBeInstanceOf(Error);
  });

  it("listeners re-attached per-request do not capture attach-time frames [TRAP]", async () => {
    // Three frames each attach a listener to the same long-lived emitter.
    // A single emit from OUTSIDE any frame fires all three. None of them
    // see the frame that was active when they were attached — ALS is
    // strictly emit-time. Good news: no old projectRoots linger in memory.
    // Bad news: a blueprint that needs the original project context has
    // nowhere to read it from inside a fire-and-forget listener.
    const emitter = new EventEmitter();
    const observed: string[] = [];

    const attachListener = () => {
      emitter.on("event", () => {
        try {
          observed.push(requireProjectRoot());
        } catch {
          observed.push("<no ctx>");
        }
      });
    };

    await runWithContext({ projectRoot: "/proj/reattach-1" }, async () => {
      attachListener();
    });
    await runWithContext({ projectRoot: "/proj/reattach-2" }, async () => {
      attachListener();
    });
    await runWithContext({ projectRoot: "/proj/reattach-3" }, async () => {
      attachListener();
    });

    // Single fire from completely outside any frame.
    emitter.emit("event");

    expect(observed).toEqual(["<no ctx>", "<no ctx>", "<no ctx>"]);
  });

  it("worker_threads.Worker does NOT inherit the parent's ALS frame [TRAP]", async () => {
    // If any future tool-server code moves CPU-bound work (tree-sitter
    // parsing, source-map resolution, pipeline transforms) into a Worker,
    // requireProjectRoot() inside the Worker will throw unless projectRoot
    // is explicitly forwarded via workerData. This test proves a fresh
    // Worker sees an empty ALS store.
    if (!isMainThread) return; // defensive; vitest always runs as main thread

    const workerSrc = `
      const { parentPort } = require('node:worker_threads');
      const { AsyncLocalStorage } = require('node:async_hooks');
      // Brand-new ALS instance — can't share the parent's singleton anyway,
      // but even a shared one wouldn't have an active frame here.
      const als = new AsyncLocalStorage();
      parentPort.postMessage({
        inWorkerStore: als.getStore() ?? null,
        threadType: 'worker',
      });
    `;

    const workerFile = path.join(os.tmpdir(), `als-worker-${Date.now()}.cjs`);
    fs.writeFileSync(workerFile, workerSrc);

    try {
      const { storeInWorker, threadType } = await runWithContext(
        { projectRoot: "/proj/worker-parent" },
        () =>
          new Promise<{ storeInWorker: unknown; threadType: string }>((resolve, reject) => {
            const w = new Worker(workerFile);
            w.once("message", (msg: { inWorkerStore: unknown; threadType: string }) => {
              resolve({ storeInWorker: msg.inWorkerStore, threadType: msg.threadType });
              w.terminate();
            });
            w.once("error", reject);
          })
      );

      expect(threadType).toBe("worker");
      // The worker cannot see /proj/worker-parent even though we created
      // the Worker from inside that ALS frame. ALS does not cross thread
      // boundaries.
      expect(storeInWorker).toBeNull();
    } finally {
      fs.unlinkSync(workerFile);
    }
  });

  it("child_process spawn subprocess cannot see parent ALS [TRAP]", async () => {
    // Same conceptual hole as Workers but for subprocesses. Proving the
    // obvious: a spawned Node child sees no ALS. tool-server/src already
    // avoids this by passing config via argv, but the trap is real.
    const childSrc = `
      // New process, no parent ALS. No way to reach requireProjectRoot here.
      const { AsyncLocalStorage } = require('node:async_hooks');
      const als = new AsyncLocalStorage();
      process.stdout.write(JSON.stringify({ store: als.getStore() ?? null }));
    `;
    const childFile = path.join(os.tmpdir(), `als-child-${Date.now()}.cjs`);
    fs.writeFileSync(childFile, childSrc);

    try {
      const output = await runWithContext({ projectRoot: "/proj/parent-spawn" }, () =>
        new Promise<string>((resolve, reject) => {
          const { spawn } = require("node:child_process") as typeof import("node:child_process");
          const child = spawn(process.execPath, [childFile], { stdio: "pipe" });
          let buf = "";
          child.stdout.on("data", (d: Buffer) => {
            buf += d.toString();
          });
          child.on("exit", () => resolve(buf));
          child.on("error", reject);
        })
      );
      const parsed = JSON.parse(output) as { store: unknown };
      expect(parsed.store).toBeNull();
    } finally {
      fs.unlinkSync(childFile);
    }
  });
});
