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
