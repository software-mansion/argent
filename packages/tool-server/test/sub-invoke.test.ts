import { describe, it, expect, vi } from "vitest";
import type { Registry, ToolContext } from "@argent/registry";
import { invokeSubTool } from "../src/utils/sub-invoke";

function mockRegistry(impl?: (id: string, args: unknown) => unknown): Registry {
  return {
    invokeTool: vi.fn(async (id: string, args: unknown) => impl?.(id, args)),
  } as unknown as Registry;
}

describe("invokeSubTool", () => {
  it("invokes directly (no third arg) when there is no telemetry context", async () => {
    const registry = mockRegistry(() => ({ ok: true }));

    const result = await invokeSubTool(registry, undefined, "gesture-tap", { x: 0.5, y: 0.3 });

    expect(result).toEqual({ ok: true });
    // No options object — preserves the pre-fix call shape for direct invokes.
    expect(registry.invokeTool).toHaveBeenCalledWith("gesture-tap", { x: 0.5, y: 0.3 });
  });

  it("invokes directly when the context carries no recorder", async () => {
    const registry = mockRegistry();
    const ctx = { artifacts: {} } as unknown as ToolContext;

    await invokeSubTool(registry, ctx, "gesture-tap", { x: 0.1 });

    expect(registry.invokeTool).toHaveBeenCalledWith("gesture-tap", { x: 0.1 });
  });

  it("records a child invocation and forwards the id + recorder when attribution is present", async () => {
    const registry = mockRegistry(() => ({ done: true }));
    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await invokeSubTool(registry, ctx, "gesture-swipe", { fromX: 0.5 });

    expect(recordChildInvocation).toHaveBeenCalledOnce();
    const childId = recordChildInvocation.mock.calls[0]![0];
    expect(childId).toEqual(expect.any(String));

    // The child's own args are handed to the recorder so it can re-derive this
    // sub-tool's platform instead of inheriting the orchestrator's.
    expect(recordChildInvocation).toHaveBeenCalledWith(childId, { fromX: 0.5 });

    // The sub-tool is invoked under the freshly-minted id, and the recorder is
    // forwarded so propagation survives further nesting.
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "gesture-swipe",
      { fromX: 0.5 },
      {
        toolInvocationId: childId,
        recordChildInvocation,
      }
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("forwards inRepeatFlowScope on the attributed path when set via overrides", async () => {
    const registry = mockRegistry();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => vi.fn());
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await invokeSubTool(
      registry,
      ctx,
      "flow-execute",
      { name: "frag" },
      { inRepeatFlowScope: true }
    );

    expect(registry.invokeTool).toHaveBeenCalledWith(
      "flow-execute",
      { name: "frag" },
      expect.objectContaining({ inRepeatFlowScope: true, recordChildInvocation })
    );
  });

  it("inherits inRepeatFlowScope from ctx on the attributed path, so an orchestrator in the middle propagates it", async () => {
    const registry = mockRegistry();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => vi.fn());
    const ctx = {
      artifacts: {},
      recordChildInvocation,
      inRepeatFlowScope: true,
    } as unknown as ToolContext;

    await invokeSubTool(registry, ctx, "flow-execute", { name: "frag" });

    expect(registry.invokeTool).toHaveBeenCalledWith(
      "flow-execute",
      { name: "frag" },
      expect.objectContaining({ inRepeatFlowScope: true })
    );
  });

  it("forwards inRepeatFlowScope on the unattributed path when set via overrides", async () => {
    const registry = mockRegistry();
    const ctx = { artifacts: {} } as unknown as ToolContext;

    await invokeSubTool(
      registry,
      ctx,
      "flow-execute",
      { name: "frag" },
      { inRepeatFlowScope: true }
    );

    // Exact third arg: with no recorder and no signal the scope is the only option.
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "flow-execute",
      { name: "frag" },
      { inRepeatFlowScope: true }
    );
  });

  it("inherits inRepeatFlowScope from ctx on the unattributed path", async () => {
    const registry = mockRegistry();
    const ctx = { artifacts: {}, inRepeatFlowScope: true } as unknown as ToolContext;

    await invokeSubTool(registry, ctx, "flow-execute", { name: "frag" });

    expect(registry.invokeTool).toHaveBeenCalledWith(
      "flow-execute",
      { name: "frag" },
      { inRepeatFlowScope: true }
    );
  });

  it("mints a distinct id per call", async () => {
    const registry = mockRegistry();
    const recordChildInvocation = vi.fn((_id: string) => vi.fn());
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await invokeSubTool(registry, ctx, "gesture-tap", {});
    await invokeSubTool(registry, ctx, "gesture-tap", {});

    const idA = recordChildInvocation.mock.calls[0]![0];
    const idB = recordChildInvocation.mock.calls[1]![0];
    expect(idA).not.toEqual(idB);
  });

  it("releases the recorded metadata even when the sub-tool throws", async () => {
    const registry = {
      invokeTool: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as Registry;
    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await expect(invokeSubTool(registry, ctx, "gesture-tap", {})).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledOnce();
  });
});
