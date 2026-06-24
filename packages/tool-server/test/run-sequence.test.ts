import { describe, it, expect, vi } from "vitest";
import type { Registry, ToolContext } from "@argent/registry";
import { createRunSequenceTool } from "../src/tools/run-sequence";

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
