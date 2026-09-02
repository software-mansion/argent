import { afterEach, describe, expect, it } from "vitest";
import {
  FlowScriptExecutor,
  type FlowScriptRequest,
} from "../../../src/tools/flows/script/flow-script-executor";
import { createScriptWorkspace, type ScriptWorkspace } from "../../helpers/flow-script-workspace";

const workspaces: ScriptWorkspace[] = [];

function workspace(): ScriptWorkspace {
  const ws = createScriptWorkspace("queue");
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stepFor(ws: ScriptWorkspace, scriptPath: string): FlowScriptRequest {
  return { scriptPath, projectRoot: ws.dir };
}

function timedScript(ws: ScriptWorkspace, sleepMs: number): string {
  return ws.write(
    "timed.mjs",
    `output.startedAt = Date.now();
     await new Promise((r) => setTimeout(r, ${sleepMs}));
     output.endedAt = Date.now();`
  );
}

describe("flow script executor — concurrency", () => {
  it("runs no more scripts at once than the limit allows", async () => {
    const ws = workspace();
    const script = timedScript(ws, 400);
    const executor = new FlowScriptExecutor({ concurrency: 2, maxTimeoutMs: 60_000 });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => executor.execute(stepFor(ws, script)))
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const spans = results.map((r) => ({
      from: r.output!.startedAt as number,
      to: r.output!.endedAt as number,
    }));
    for (const span of spans) {
      const overlapping = spans.filter((other) => other.from < span.to && other.to > span.from);
      expect(overlapping.length).toBeLessThanOrEqual(2);
    }
    expect(results.filter((r) => r.queuedMs > 100).length).toBe(2);
    expect(executor.activeCount).toBe(0);
  }, 30_000);

  it("does not count the queue wait against the script's own time limit", async () => {
    const ws = workspace();
    const script = timedScript(ws, 500);
    const executor = new FlowScriptExecutor({ concurrency: 1, maxTimeoutMs: 60_000 });
    const [first, second] = await Promise.all([
      executor.execute({ scriptPath: script, projectRoot: ws.dir, timeoutMs: 2_000 }),
      executor.execute({ scriptPath: script, projectRoot: ws.dir, timeoutMs: 2_000 }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.queuedMs).toBeGreaterThan(300);
    expect(second.durationMs).toBeLessThan(2_000);
  }, 30_000);

  it("refuses a step once the queue is full", async () => {
    const ws = workspace();
    const script = timedScript(ws, 1_500);
    const executor = new FlowScriptExecutor({ concurrency: 1, maxTimeoutMs: 60_000 });
    const occupier = executor.execute({ scriptPath: script, projectRoot: ws.dir });
    const controllers = Array.from({ length: 32 }, () => new AbortController());
    const queued = controllers.map((controller) =>
      executor.execute({ scriptPath: script, projectRoot: ws.dir, signal: controller.signal })
    );
    const refused = await executor.execute({ scriptPath: script, projectRoot: ws.dir });

    expect(refused.failure?.kind).toBe("queue");
    expect(refused.failure?.message).toContain("queue is full");
    for (const controller of controllers) controller.abort();
    expect((await Promise.all(queued)).every((r) => r.failure?.kind === "cancelled")).toBe(true);
    expect((await occupier).ok).toBe(true);
  }, 30_000);

  it("refuses a step that waits past the wait bound", async () => {
    const ws = workspace();
    const script = timedScript(ws, 1_200);
    const executor = new FlowScriptExecutor({
      concurrency: 1,
      maxTimeoutMs: 60_000,
      queueWaitMs: 400,
    });
    const occupier = executor.execute({ scriptPath: script, projectRoot: ws.dir });
    await delay(200);
    const refused = await executor.execute({ scriptPath: script, projectRoot: ws.dir });

    expect(refused.failure?.kind).toBe("queue");
    expect(refused.failure?.message).toContain("Timed out after 400ms");
    expect((await occupier).ok).toBe(true);
  }, 30_000);

  it("releases a queue position the moment its run is cancelled", async () => {
    const ws = workspace();
    const script = timedScript(ws, 800);
    const executor = new FlowScriptExecutor({ concurrency: 1, maxTimeoutMs: 60_000 });
    const occupier = executor.execute({ scriptPath: script, projectRoot: ws.dir });
    await delay(100);
    const controller = new AbortController();
    const queued = executor.execute({
      scriptPath: script,
      projectRoot: ws.dir,
      signal: controller.signal,
    });
    const behind = executor.execute({ scriptPath: script, projectRoot: ws.dir });
    const abortedAt = Date.now();
    controller.abort();

    const cancelled = await queued;
    const answeredAfterMs = Date.now() - abortedAt;
    expect(cancelled.failure?.kind).toBe("cancelled");
    // The occupier keeps the only slot for another ~700ms. Without the queue's
    // own abort listener the waiter would take a slot later and `runOne`'s
    // guard would answer with the same kind, so the kind alone proves nothing.
    expect(answeredAfterMs).toBeLessThan(300);
    expect((await occupier).ok).toBe(true);
    expect((await behind).ok).toBe(true);
  }, 30_000);

  it("reports a queue wait longer than five seconds", async () => {
    const ws = workspace();
    const occupying = timedScript(ws, 5_200);
    const quick = ws.write("quick.mjs", `output.ok = true;`);
    const executor = new FlowScriptExecutor({ concurrency: 1, maxTimeoutMs: 60_000 });
    const [, waited] = await Promise.all([
      executor.execute({ scriptPath: occupying, projectRoot: ws.dir, timeoutMs: 20_000 }),
      executor.execute({ scriptPath: quick, projectRoot: ws.dir, timeoutMs: 20_000 }),
    ]);

    expect(waited.ok).toBe(true);
    expect(waited.notes.join(" ")).toMatch(/Waited \d+\.\ds for a free script slot/);
  }, 30_000);
});

describe("flow script executor — the default concurrency", () => {
  it("runs at least two scripts at once on any host", async () => {
    const ws = createScriptWorkspace("queue");
    try {
      // Two intervals that overlap ran at the same time. Elapsed wall clock
      // cannot say that: its bound would have to sit between the concurrent
      // time and the serialized one, which a loaded runner crosses while
      // running both scripts at once.
      const script = ws.write(
        "slow.mjs",
        `output.startedAt = Date.now();
         await new Promise((r) => setTimeout(r, 700));
         output.finishedAt = Date.now();`
      );
      const shared = new FlowScriptExecutor({ maxTimeoutMs: 60_000 });
      const results = await Promise.all([
        shared.execute({ scriptPath: script, projectRoot: ws.dir }),
        shared.execute({ scriptPath: script, projectRoot: ws.dir }),
      ]);
      const spans = results.map((result) => ({
        from: result.output?.startedAt as number,
        to: result.output?.finishedAt as number,
      }));

      expect(results.every((r) => r.ok)).toBe(true);
      expect(Math.min(spans[0]!.to, spans[1]!.to)).toBeGreaterThan(
        Math.max(spans[0]!.from, spans[1]!.from)
      );
      expect(results.every((r) => r.queuedMs < 200)).toBe(true);
    } finally {
      ws.cleanup();
    }
  }, 30_000);
});

describe("flow script executor — bounds that would break every step", () => {
  it("treats concurrency 0 as unset rather than a queue that never drains", async () => {
    const ws = createScriptWorkspace("queue");
    try {
      const script = ws.write("quick.mjs", `output.ok = true;`);
      const result = await new FlowScriptExecutor({ concurrency: 0, maxTimeoutMs: 60_000 }).execute(
        { scriptPath: script, projectRoot: ws.dir }
      );

      expect(result.ok).toBe(true);
    } finally {
      ws.cleanup();
    }
  }, 30_000);

  it("keeps a huge maximum inside what a timer can hold", async () => {
    const ws = createScriptWorkspace("queue");
    try {
      const script = ws.write(
        "slow.mjs",
        `await new Promise((r) => setTimeout(r, 300)); output.ok = true;`
      );
      // Past ~24.9 days the clamped step limit exceeds setTimeout's range, Node
      // clamps the timer to 1ms, and every script "times out" at once.
      const result = await new FlowScriptExecutor({
        concurrency: 2,
        maxTimeoutMs: 3_000_000_000,
      }).execute({ scriptPath: script, projectRoot: ws.dir, timeoutMs: 3_000_000_000 });

      expect(result.failure).toBeUndefined();
      expect(result.ok).toBe(true);
    } finally {
      ws.cleanup();
    }
  }, 30_000);

  it("does not note a clamp for a step that asked for nothing", async () => {
    const ws = createScriptWorkspace("queue");
    try {
      const script = ws.write("quick.mjs", `output.ok = true;`);
      const result = await new FlowScriptExecutor({ concurrency: 2, maxTimeoutMs: 5_000 }).execute({
        scriptPath: script,
        projectRoot: ws.dir,
      });

      expect(result.ok).toBe(true);
      expect(result.notes).toEqual([]);
    } finally {
      ws.cleanup();
    }
  }, 30_000);
});
