import { describe, expect, it } from "vitest";
import { Registry, TOOL_ID_ALIASES, canonicalToolId } from "../src/index";
import type { ToolDefinition } from "../src/index";

function renamedTool(execute = async (_s: unknown, params: unknown) => ({ params })) {
  return {
    id: "e2e-execute",
    aliases: ["flow-execute"],
    services: () => ({}),
    execute,
  } as ToolDefinition<any, any>;
}

describe("tool aliases", () => {
  it("resolves an alias to the same definition", () => {
    const registry = new Registry();
    registry.registerTool(renamedTool());

    expect(registry.getTool("flow-execute")).toBe(registry.getTool("e2e-execute"));
    expect(registry.getTool("flow-execute")?.id).toBe("e2e-execute");
  });

  it("runs the tool by an alias, with the same result as by its id", async () => {
    const registry = new Registry();
    registry.registerTool(renamedTool());

    const byAlias = await registry.invokeTool("flow-execute", { a: 1 });
    const byId = await registry.invokeTool("e2e-execute", { a: 1 });

    expect(byAlias).toEqual({ params: { a: 1 } });
    expect(byAlias).toEqual(byId);
  });

  it("names the tool by its id in events, and the alias as calledAs", async () => {
    const registry = new Registry();
    registry.registerTool(renamedTool());
    const seen: unknown[][] = [];
    registry.events.on("toolInvoked", (id, _call, _msg, calledAs) =>
      seen.push(["invoked", id, calledAs])
    );
    registry.events.on("toolCompleted", (id, _call, _ms, _msg, calledAs) =>
      seen.push(["completed", id, calledAs])
    );
    registry.events.on("toolFailed", (id, _call, _err, _ms, _msg, calledAs) =>
      seen.push(["failed", id, calledAs])
    );

    await registry.invokeTool("flow-execute", {});
    await registry.invokeTool("e2e-execute", {});

    expect(seen).toEqual([
      ["invoked", "e2e-execute", "flow-execute"],
      ["completed", "e2e-execute", "flow-execute"],
      ["invoked", "e2e-execute", undefined],
      ["completed", "e2e-execute", undefined],
    ]);
  });

  it("reports a failure under the tool's id with the alias as calledAs", async () => {
    const registry = new Registry();
    registry.registerTool(
      renamedTool(async () => {
        throw new Error("boom");
      })
    );
    const failed: unknown[] = [];
    registry.events.on("toolFailed", (id, _call, _err, _ms, _msg, calledAs) =>
      failed.push([id, calledAs])
    );

    await expect(registry.invokeTool("flow-execute", {})).rejects.toThrow(
      "[Tool:e2e-execute] boom"
    );
    expect(failed).toEqual([["e2e-execute", "flow-execute"]]);
  });

  it("lists only the tool's id in the snapshot", () => {
    const registry = new Registry();
    registry.registerTool(renamedTool());

    expect(registry.getSnapshot().tools).toEqual(["e2e-execute"]);
  });

  it("refuses an alias or id that is already taken", () => {
    const registry = new Registry();
    registry.registerTool(renamedTool());
    const tool = (id: string, aliases?: string[]) =>
      ({ id, aliases, services: () => ({}), execute: async () => ({}) }) as ToolDefinition<
        any,
        any
      >;

    expect(() => registry.registerTool(tool("flow-execute"))).toThrow(
      'Tool "flow-execute" already registered'
    );
    expect(() => registry.registerTool(tool("other", ["e2e-execute"]))).toThrow(
      'Tool "e2e-execute" already registered'
    );
    expect(() => registry.registerTool(tool("other", ["flow-execute"]))).toThrow(
      'Tool "flow-execute" already registered'
    );
    expect(registry.getTool("other")).toBeUndefined();
  });
});

describe("canonicalToolId", () => {
  it("maps each former flow tool id to its e2e id", () => {
    for (const [alias, id] of Object.entries(TOOL_ID_ALIASES)) {
      expect(alias).toMatch(/^flow-/);
      expect(id).toBe(`e2e-${alias.slice("flow-".length)}`);
      expect(canonicalToolId(alias)).toBe(id);
    }
    expect(Object.keys(TOOL_ID_ALIASES)).toHaveLength(7);
  });

  it("leaves any other id unchanged", () => {
    expect(canonicalToolId("e2e-execute")).toBe("e2e-execute");
    expect(canonicalToolId("gesture-tap")).toBe("gesture-tap");
    expect(canonicalToolId("toString")).toBe("toString");
  });
});
