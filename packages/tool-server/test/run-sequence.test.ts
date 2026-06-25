import { describe, it, expect, vi } from "vitest";
import type { Registry, ToolContext } from "@argent/registry";
import { createRunSequenceTool } from "../src/tools/run-sequence";

// iOS-shaped udid so `resolveDevice` classifies it as an iOS simulator without
// touching a real device (classification is purely shape-based).
const IOS = "11111111-1111-1111-1111-111111111111";

function mockRegistry(invokeImpl?: (id: string, args: unknown) => unknown): Registry {
  return {
    // No capability declared → run-sequence skips the per-step assertSupported.
    getTool: vi.fn(() => undefined),
    invokeTool: vi.fn(async (id: string, args: unknown) => invokeImpl?.(id, args) ?? { ok: true }),
  } as unknown as Registry;
}

describe("run-sequence", () => {
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
});
