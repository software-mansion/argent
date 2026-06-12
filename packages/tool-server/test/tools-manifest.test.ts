import { describe, expect, it } from "vitest";
import { Registry, type ToolDefinition } from "@argent/registry";
import { createAllTools } from "../src/tools-manifest";

describe("tools-manifest", () => {
  it("keys every tool by its own id", () => {
    const tools = createAllTools(new Registry());
    for (const [key, tool] of Object.entries(tools)) {
      expect(tool.id, `manifest key "${key}" must equal the tool's id`).toBe(key);
    }
  });

  it("has no duplicate ids (registry would reject them)", () => {
    const registry = new Registry();
    const tools = createAllTools(registry);
    // registerTool throws on a duplicate id, so a full registration pass is
    // the authoritative check.
    for (const tool of Object.values(tools)) {
      registry.registerTool(tool as ToolDefinition<unknown, unknown>);
    }
    expect(registry.getSnapshot().tools).toHaveLength(Object.keys(tools).length);
  });
});
