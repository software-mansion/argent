import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";
import type { ToolContext } from "@argent/registry";
import { createRunSequenceTool } from "../src/tools/run-sequence";
import { DEVICE_QUEUE_MAX_WAIT_MS, serializedPerDevice } from "../src/utils/device-serial";

// A minimal registry stub: records every invokeTool call and returns a marker.
function makeMockRegistry() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const registry = {
    invokeTool: vi.fn(async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return { ok: true };
    }),
    // The execute body pre-flights each step's capability via getTool; these
    // tvOS/test tools aren't registered in the stub, so undefined (→ skip the
    // capability gate) is the right answer here.
    getTool: vi.fn(() => undefined),
  } as any;
  return { registry, calls };
}

function mockRegistry(invokeImpl?: (id: string, args: unknown) => unknown): Registry {
  return {
    // No capability declared → run-sequence skips the per-step assertSupported.
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(async (id: string, args: unknown) => invokeImpl?.(id, args) ?? { ok: true }),
  } as unknown as Registry;
}

const TVOS_UDID = "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD";
// iOS-shaped udid so `resolveDevice` classifies it as an iOS simulator without
// touching a real device (classification is purely shape-based).
const IOS = "11111111-1111-1111-1111-111111111111";

describe("run-sequence — the device keyboard queue", () => {
  // The queue holds `keyboard` and `paste` and nothing else, so a `gesture-tap`
  // never waits on it. A sequence that taps a field and then clears it therefore
  // landed its tap AT ONCE and queued the clear behind another session's call —
  // and anything that moved focus in between redirected the clear. Measured on
  // Chrome 152 against a second session holding the queue for 20s: the clear
  // emptied a textarea the sequence never addressed and reported
  // `completed: 2 of 2` with `clearVerified: true`.
  it("waits for the queue BEFORE its first step when a step uses the keyboard", async () => {
    const { registry, calls } = makeMockRegistry();
    const tool = createRunSequenceTool(registry);
    let release = () => {};
    const blocking = serializedPerDevice(
      IOS,
      () => new Promise<void>((resolve) => (release = resolve))
    );

    const sequence = tool.execute!(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 }, delayMs: 0 },
          { tool: "keyboard", args: { clear: true } },
        ],
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    // The tap is the step that has to be inside the critical section: it is what
    // decides where the clear lands.
    expect(calls).toEqual([]);

    release();
    await blocking;
    expect((await sequence).completed).toBe(2);
    expect(calls.map((c) => c.tool)).toEqual(["gesture-tap", "keyboard"]);
  });

  it("does not deadlock on the queue it is itself holding", async () => {
    // The steps go through the registry to the real `keyboard` / `paste`
    // execute, which take the same queue. Without the re-entrancy check a held
    // sequence would wait for itself forever.
    const { registry, calls } = makeMockRegistry();
    registry.invokeTool = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return serializedPerDevice(IOS, async () => ({ ok: true }));
    });
    const result = await createRunSequenceTool(registry).execute!(
      {},
      { udid: IOS, steps: [{ tool: "keyboard", args: { text: "hi" }, delayMs: 0 }] }
    );
    expect(result.completed).toBe(1);
  });

  it("leaves the queue alone when no step uses the keyboard", async () => {
    // A gesture-only batch must not wait behind another session's clear, nor
    // make one wait behind it: the hazard is the focused field, and a batch that
    // never touches it has none.
    const { registry, calls } = makeMockRegistry();
    let release = () => {};
    const blocking = serializedPerDevice(
      IOS,
      () => new Promise<void>((resolve) => (release = resolve))
    );

    const result = await createRunSequenceTool(registry).execute!(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 }, delayMs: 0 },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.6 }, delayMs: 0 },
        ],
      }
    );
    expect(result.completed).toBe(2);
    expect(calls.map((c) => c.tool)).toEqual(["gesture-tap", "gesture-tap"]);

    release();
    await blocking;
  });

  it("releases the queue after the LAST keyboard step, not at the end of the batch", async () => {
    // The hold exists to keep the focus tap and the write in one critical
    // section. Everything after the last write is another session's wait for
    // nothing, and nothing bounds it: `steps` has no maximum, `delayMs` has no
    // maximum, and an `await-ui-element` step can add 120s. Measured on
    // Chrome 152 with `[keyboard { clear } delayMs 5000, gesture-tap
    // delayMs 8000]`: a second session's `keyboard` waited 11.54s and typed
    // into THIS sequence's field, where the same call behind a gesture-only
    // sequence returned in 0.17s and typed into its own.
    const { registry, calls } = makeMockRegistry();
    let releaseTrailing = () => {};
    const trailing = new Promise<void>((resolve) => (releaseTrailing = resolve));
    registry.invokeTool = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      // The trailing gesture is still running when the queue is probed below.
      if (tool === "gesture-tap") await trailing;
      return { ok: true };
    });

    const sequence = createRunSequenceTool(registry).execute!(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "keyboard", args: { clear: true }, delayMs: 0 },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 }, delayMs: 0 },
        ],
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.map((c) => c.tool)).toEqual(["keyboard", "gesture-tap"]);

    // Another session's keyboard, sent while the sequence's trailing gesture is
    // still in flight. It must not wait for that gesture.
    let ranAt = 0;
    const other = serializedPerDevice(IOS, async () => (ranAt = Date.now()));
    await other;
    expect(ranAt).toBeGreaterThan(0);
    expect(calls.map((c) => c.tool)).toEqual(["keyboard", "gesture-tap"]);

    releaseTrailing();
    expect((await sequence).completed).toBe(2);
  });

  it("refuses to write after waiting past the queue budget, rather than writing blind", async () => {
    // A wait is not free: the caller chose its field before it sent the call,
    // and the session ahead of it may have moved focus since. Past the budget
    // the write is not attempted at all — the alternative measured on Chrome 152
    // was `{ typed: "BBB", keys: 3 }` returned as a success for text that landed
    // in another session's field.
    let release = () => {};
    const blocking = serializedPerDevice(
      IOS,
      () => new Promise<void>((resolve) => (release = resolve))
    );
    // The blocking task must already be running, so the clock below is read
    // only by the call that queues behind it.
    await new Promise((r) => setTimeout(r, 0));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValueOnce(now); // queued at
    clock.mockReturnValue(now + DEVICE_QUEUE_MAX_WAIT_MS + 1); // its turn comes
    const task = vi.fn(async () => "written");
    const late = serializedPerDevice(IOS, task).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    release();
    await blocking;
    const err = await late;
    clock.mockRestore();
    expect(task).not.toHaveBeenCalled();
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.KEYBOARD_DEVICE_BUSY);
    expect(err?.message).toContain("was NOT sent to the device");
  });
});

describe("run-sequence", () => {
  it("allows TV steps and dispatches them in order with the shared udid injected", async () => {
    const { registry, calls } = makeMockRegistry();
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute!(
      {},
      {
        udid: TVOS_UDID,
        steps: [
          { tool: "tv-remote", args: { button: "right" } },
          { tool: "keyboard", args: { text: "hello" } },
          { tool: "tv-remote", args: { button: "select" } },
        ],
      }
    );

    expect(result.completed).toBe(3);
    expect(result.total).toBe(3);
    // Every step ran through the registry with udid auto-injected.
    expect(calls.map((c) => c.tool)).toEqual(["tv-remote", "keyboard", "tv-remote"]);
    for (const c of calls) {
      expect(c.args.udid).toBe(TVOS_UDID);
    }
    expect(calls[0]!.args).toMatchObject({ button: "right", udid: TVOS_UDID });
  });

  it("rejects a tool that isn't in the allow-list and stops the sequence", async () => {
    const { registry, calls } = makeMockRegistry();
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute!(
      {},
      {
        udid: TVOS_UDID,
        steps: [
          { tool: "tv-remote", args: { button: "down" } },
          { tool: "screenshot", args: {} },
          { tool: "tv-remote", args: { button: "select" } },
        ],
      }
    );

    // First step ran; the disallowed second step halts execution before the third.
    expect(result.completed).toBe(1);
    expect(calls.map((c) => c.tool)).toEqual(["tv-remote"]);
    const failed = result.steps[1];
    expect(failed && "error" in failed && failed.error).toMatch(/not allowed/);
  });

  it("declares no eager service so a tvOS udid never spawns simulator-server", () => {
    const { registry } = makeMockRegistry();
    const tool = createRunSequenceTool(registry);
    // The registry resolves each step's services lazily; run-sequence itself
    // declares none — declaring simulator-server would hang for a tvOS udid.
    expect(tool.services({ udid: TVOS_UDID, steps: [] } as any)).toEqual({});
  });

  it("runs each step in order, injecting the shared udid", async () => {
    const registry = mockRegistry();
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
          { tool: "keyboard", args: { text: "hi" }, delayMs: 0 },
        ],
      }
    );

    expect(result).toMatchObject({ completed: 2, total: 2 });
    expect(registry.invokeTool).toHaveBeenNthCalledWith(1, "gesture-tap", {
      x: 0.5,
      y: 0.3,
      udid: IOS,
    });
    expect(registry.invokeTool).toHaveBeenNthCalledWith(2, "keyboard", { text: "hi", udid: IOS });
  });

  it("stops at an unrecognized tool without invoking it", async () => {
    const registry = mockRegistry();
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      { udid: IOS, steps: [{ tool: "not-a-tool", args: {}, delayMs: 0 }] }
    );

    expect(result.completed).toBe(0);
    expect(result.steps[0]).toMatchObject({
      tool: "not-a-tool",
      error: expect.stringContaining("not allowed"),
    });
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("stops the sequence when an await-ui-element step reports an unmet condition", async () => {
    const registry = mockRegistry((id: string) => {
      if (id === "await-ui-element") {
        return {
          success: false,
          elapsed: 5000,
          note: "no element matched the selector before timeout",
        };
      }
      return { tapped: true };
    });
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.9 } },
          {
            tool: "await-ui-element",
            args: { condition: "visible", selector: { text: "Continue" } },
          },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        ],
      }
    );

    // The trailing tap must NOT run.
    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(result.steps).toHaveLength(2);
    const last = result.steps[1] as { tool: string; error?: string };
    expect(last.tool).toBe("await-ui-element");
    expect(last.error).toMatch(/condition not met/i);
    expect(last.error).toMatch(/no element matched/i);
    expect(result.completed).toBe(1);
    expect(result.total).toBe(3);
  });

  it("continues past an await-ui-element step whose condition is met", async () => {
    const registry = mockRegistry((id: string) => {
      if (id === "await-ui-element") return { success: true, elapsed: 120 };
      return { tapped: true };
    });
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.9 } },
          {
            tool: "await-ui-element",
            args: { condition: "visible", selector: { text: "Continue" } },
          },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        ],
      }
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(3);
    expect(result.completed).toBe(3);
    expect(result.steps.every((s) => "result" in s)).toBe(true);
  });

  it("only the await-ui-element tool's success:false halts — other tools are unaffected", async () => {
    // A non-wait step returning a success:false-shaped object must NOT stop the run.
    const registry = mockRegistry(() => ({ success: false }));
    const tool = createRunSequenceTool(registry);

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.9 } },
          { tool: "gesture-tap", args: { x: 0.5, y: 0.5 } },
        ],
      }
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(result.completed).toBe(2);
  });

  it("forwards the request abort signal into each sub-tool invocation", async () => {
    const registry = mockRegistry(() => ({ tapped: true }));
    const tool = createRunSequenceTool(registry);
    const controller = new AbortController();

    await tool.execute(
      {},
      { udid: IOS, steps: [{ tool: "gesture-tap", args: { x: 0.5, y: 0.9 } }] },
      { signal: controller.signal } as unknown as ToolContext
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    const opts = (registry.invokeTool as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.signal).toBe(controller.signal);
  });

  it("does not run any step when the signal is already aborted", async () => {
    const registry = mockRegistry(() => ({ tapped: true }));
    const tool = createRunSequenceTool(registry);
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [{ tool: "gesture-tap", args: { x: 0.5, y: 0.9 } }],
      },
      { signal: controller.signal } as unknown as ToolContext
    );

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(result.completed).toBe(0);
  });

  it("propagates the request's telemetry attribution to every sub-tool", async () => {
    const registry = mockRegistry();
    const tool = createRunSequenceTool(registry);

    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "gesture-tap", args: { x: 0.5, y: 0.3 }, delayMs: 0 },
          { tool: "gesture-swipe", args: { fromX: 0.5 }, delayMs: 0 },
        ],
      },
      ctx
    );

    // One recorded child invocation per step, each with its own id.
    expect(recordChildInvocation).toHaveBeenCalledTimes(2);
    const ids = recordChildInvocation.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(2);

    // Each step's own args (with the injected udid) reach the recorder so it can
    // attribute the gesture to the right platform.
    expect(recordChildInvocation).toHaveBeenNthCalledWith(
      1,
      ids[0],
      expect.objectContaining({ x: 0.5, y: 0.3, udid: IOS })
    );
    expect(recordChildInvocation).toHaveBeenNthCalledWith(
      2,
      ids[1],
      expect.objectContaining({ fromX: 0.5, udid: IOS })
    );

    // Each sub-tool is dispatched under its minted id, with the recorder
    // forwarded so deeper nesting keeps the attribution.
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      1,
      "gesture-tap",
      expect.objectContaining({ x: 0.5, y: 0.3, udid: IOS }),
      expect.objectContaining({ toolInvocationId: ids[0], recordChildInvocation })
    );
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      2,
      "gesture-swipe",
      expect.objectContaining({ fromX: 0.5, udid: IOS }),
      expect.objectContaining({ toolInvocationId: ids[1], recordChildInvocation })
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("forwards the request's abort signal to each sub-tool so a long step is cancellable", async () => {
    const registry = mockRegistry();
    const tool = createRunSequenceTool(registry);

    const controller = new AbortController();
    const ctx = { artifacts: {}, signal: controller.signal } as unknown as ToolContext;

    await tool.execute(
      {},
      { udid: IOS, steps: [{ tool: "tv-remote", args: { button: "right" }, delayMs: 0 }] },
      ctx
    );

    // The sub-tool must receive `signal` via its options — otherwise its own
    // `throwIfAborted` is a no-op and a long step runs to completion after the
    // client disconnects. (No attribution context here, so this is the
    // pass-through branch.)
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "tv-remote",
      expect.objectContaining({ button: "right", udid: IOS }),
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("stops before the next step once the signal is aborted", async () => {
    const controller = new AbortController();
    // Abort as soon as the first step runs; the loop must not dispatch the second.
    const registry = mockRegistry(() => {
      controller.abort();
      return { ok: true };
    });
    const tool = createRunSequenceTool(registry);
    const ctx = { artifacts: {}, signal: controller.signal } as unknown as ToolContext;

    const result = await tool.execute(
      {},
      {
        udid: IOS,
        steps: [
          { tool: "tv-remote", args: { button: "up" }, delayMs: 0 },
          { tool: "tv-remote", args: { button: "down" }, delayMs: 0 },
        ],
      },
      ctx
    );

    expect(result.completed).toBe(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  describe("a step whose args the sub-tool rejects", () => {
    const liveRegistry = () => {
      const registry = new Registry();
      const executed: string[] = [];
      registry.registerTool({
        id: "gesture-tap",
        description: "test double for gesture-tap",
        zodSchema: z.object({ udid: z.string(), x: z.number(), y: z.number() }),
        services: () => ({}),
        execute: async () => {
          executed.push("gesture-tap");
          return { ok: true };
        },
      } as never);
      registry.registerTool({
        id: "keyboard",
        description: "test double for keyboard",
        zodSchema: z.object({ udid: z.string(), text: z.string().optional() }),
        services: () => ({}),
        execute: async () => {
          executed.push("keyboard");
          return { ok: true };
        },
      } as never);
      return { registry, executed };
    };

    it("names only the keys the AUTHOR wrote, not the injected udid", async () => {
      const { registry } = liveRegistry();
      const tool = createRunSequenceTool(registry);

      const result = await tool.execute(
        {},
        { udid: IOS, steps: [{ tool: "gesture-tap", args: { xx: 0.5, y: 0.3 } }] }
      );

      const error = (result.steps[0] as { error?: string }).error!;
      expect(error).toContain("`x` is required");
      expect(error).toContain("You sent: `xx`, `y`.");
      expect(error).not.toContain("`udid`");
    });

    it("STOPS the sequence, leaving the later steps un-run", async () => {
      const { registry, executed } = liveRegistry();
      const tool = createRunSequenceTool(registry);

      const result = await tool.execute(
        {},
        {
          udid: IOS,
          steps: [
            { tool: "gesture-tap", args: { xx: 0.5, y: 0.3 } },
            { tool: "keyboard", args: { text: "hello" } },
          ],
        }
      );

      expect(result.steps).toHaveLength(1);
      expect(result.completed).toBe(0);
      expect(result.total).toBe(2);
      expect(executed).toEqual([]);
    });

    it("still emits the step's own invoked/failed events", async () => {
      const { registry } = liveRegistry();
      const events: string[] = [];
      registry.events.on("toolInvoked", (id) => events.push(`invoked:${id}`));
      registry.events.on("toolFailed", (id) => events.push(`failed:${id}`));
      const tool = createRunSequenceTool(registry);

      await tool.execute(
        {},
        { udid: IOS, steps: [{ tool: "gesture-tap", args: { xx: 0.5, y: 0.3 } }] }
      );

      expect(events).toEqual(["invoked:gesture-tap", "failed:gesture-tap"]);
    });

    it("still accepts a step that omits udid, since it is injected", async () => {
      const { registry, executed } = liveRegistry();
      const tool = createRunSequenceTool(registry);

      const result = await tool.execute(
        {},
        { udid: IOS, steps: [{ tool: "gesture-tap", args: { x: 0.5, y: 0.3 } }] }
      );

      expect((result.steps[0] as { error?: string }).error).toBeUndefined();
      expect(executed).toEqual(["gesture-tap"]);
    });
  });
});
