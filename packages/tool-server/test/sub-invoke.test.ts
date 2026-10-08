import { describe, it, expect, vi } from "vitest";
import type { Registry, ResolvedFileInput, ToolContext } from "@argent/registry";
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

  it("forwards fileInputs to the registry on both paths", async () => {
    const fileInputs: Record<string, ResolvedFileInput> = {
      baselinePath: { clientPath: "/client/base.png", presentOnHost: false, viaUpload: true },
    };
    const args = { baselinePath: "/tmp/argent-file-input-x/base.png" };
    const signal = new AbortController().signal;

    // Without a recorder: the signal and the file inputs share one options object.
    const direct = mockRegistry();
    await invokeSubTool(
      direct,
      { artifacts: {}, signal } as unknown as ToolContext,
      "screenshot-diff",
      args,
      { fileInputs }
    );
    expect(vi.mocked(direct.invokeTool).mock.calls).toStrictEqual([
      ["screenshot-diff", args, { signal, fileInputs }],
    ]);

    // With a recorder: forwarded beside the minted id and the recorder.
    const recorded = mockRegistry();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => vi.fn());
    await invokeSubTool(
      recorded,
      { artifacts: {}, signal, recordChildInvocation } as unknown as ToolContext,
      "screenshot-diff",
      args,
      { fileInputs }
    );
    const childId = recordChildInvocation.mock.calls[0]![0];
    expect(vi.mocked(recorded.invokeTool).mock.calls).toStrictEqual([
      [
        "screenshot-diff",
        args,
        { signal, toolInvocationId: childId, recordChildInvocation, fileInputs },
      ],
    ]);
  });

  it("passes an options object when only extra.fileInputs is set", async () => {
    const registry = mockRegistry();
    const fileInputs: Record<string, ResolvedFileInput> = {
      currentPath: { clientPath: "/client/cur.png", presentOnHost: true, viaUpload: true },
    };

    const args = { currentPath: "/tmp/c.png" };

    await invokeSubTool(registry, undefined, "screenshot-diff", args, { fileInputs });

    // No signal key: only what was set travels.
    expect(vi.mocked(registry.invokeTool).mock.calls).toStrictEqual([
      ["screenshot-diff", args, { fileInputs }],
    ]);
  });

  it("keeps the two-argument call when extra carries no fileInputs", async () => {
    const registry = mockRegistry();
    const ctx = { artifacts: {} } as unknown as ToolContext;

    await invokeSubTool(registry, ctx, "gesture-tap", { x: 0.1 }, { fileInputs: undefined });
    await invokeSubTool(registry, undefined, "gesture-tap", { x: 0.2 }, {});

    expect(vi.mocked(registry.invokeTool).mock.calls).toStrictEqual([
      ["gesture-tap", { x: 0.1 }],
      ["gesture-tap", { x: 0.2 }],
    ]);
  });

  it("forwards flowStack on both paths", async () => {
    const flowStack = [{ canonical: "/proj/.argent/flows/root.yaml", display: "root" }];
    const args = { name: "child", project_root: "/proj" };
    const signal = new AbortController().signal;

    // Without a recorder: from ctx alone, from ctx beside the signal, and from
    // extra with no ctx at all.
    const direct = mockRegistry();
    await invokeSubTool(
      direct,
      { artifacts: {}, flowStack } as unknown as ToolContext,
      "flow-execute",
      args
    );
    await invokeSubTool(
      direct,
      { artifacts: {}, signal, flowStack } as unknown as ToolContext,
      "flow-execute",
      args
    );
    await invokeSubTool(direct, undefined, "flow-execute", args, { flowStack });
    expect(vi.mocked(direct.invokeTool).mock.calls).toStrictEqual([
      ["flow-execute", args, { flowStack }],
      ["flow-execute", args, { signal, flowStack }],
      ["flow-execute", args, { flowStack }],
    ]);

    // With a recorder: forwarded beside the minted id and the recorder.
    const recorded = mockRegistry();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => vi.fn());
    await invokeSubTool(
      recorded,
      { artifacts: {}, signal, recordChildInvocation, flowStack } as unknown as ToolContext,
      "flow-execute",
      args
    );
    const childId = recordChildInvocation.mock.calls[0]![0];
    expect(vi.mocked(recorded.invokeTool).mock.calls).toStrictEqual([
      [
        "flow-execute",
        args,
        { signal, toolInvocationId: childId, recordChildInvocation, flowStack },
      ],
    ]);
  });

  it("lets a key of extra win over the field of ctx", async () => {
    const outer = [{ canonical: "/proj/.argent/flows/outer.yaml", display: "outer" }];
    const inner = [...outer, { canonical: "/proj/.argent/flows/root.yaml", display: "root" }];
    const args = { name: "child", project_root: "/proj" };

    const direct = mockRegistry();
    await invokeSubTool(
      direct,
      { artifacts: {}, flowStack: outer } as unknown as ToolContext,
      "flow-execute",
      args,
      { flowStack: inner }
    );
    const recorded = mockRegistry();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => vi.fn());
    await invokeSubTool(
      recorded,
      { artifacts: {}, recordChildInvocation, flowStack: outer } as unknown as ToolContext,
      "flow-execute",
      args,
      { flowStack: inner }
    );

    const directOptions = vi.mocked(direct.invokeTool).mock.calls[0]![2];
    const recordedOptions = vi.mocked(recorded.invokeTool).mock.calls[0]![2];
    expect(directOptions).toStrictEqual({ flowStack: inner });
    expect(directOptions?.flowStack).toBe(inner);
    expect(recordedOptions?.flowStack).toBe(inner);
  });

  it("does not forward fileInputs or linked from ctx", async () => {
    // The outer call's file inputs (a flow and the members the client sent
    // with it) belong to that call: a sub-tool gets file inputs only when its
    // dispatcher resolved them for it and passed them in `extra`.
    const fileInputs: Record<string, ResolvedFileInput> = {
      flow_file: {
        clientPath: "/client/proj/.argent/flows/root.yaml",
        presentOnHost: false,
        viaUpload: true,
        members: {},
      },
    };
    const args = { name: "child", project_root: "/client/proj" };

    // Nothing else to forward: the two-argument call, as for a bare ctx.
    const direct = mockRegistry();
    await invokeSubTool(
      direct,
      { artifacts: {}, fileInputs, linked: true } as unknown as ToolContext,
      "flow-execute",
      args
    );
    expect(vi.mocked(direct.invokeTool).mock.calls).toStrictEqual([["flow-execute", args]]);

    // With a recorder: only the id and the recorder travel.
    const recorded = mockRegistry();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => vi.fn());
    await invokeSubTool(
      recorded,
      {
        artifacts: {},
        fileInputs,
        linked: true,
        recordChildInvocation,
      } as unknown as ToolContext,
      "flow-execute",
      args
    );
    const childId = recordChildInvocation.mock.calls[0]![0];
    expect(vi.mocked(recorded.invokeTool).mock.calls).toStrictEqual([
      [
        "flow-execute",
        args,
        { signal: undefined, toolInvocationId: childId, recordChildInvocation },
      ],
    ]);
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
