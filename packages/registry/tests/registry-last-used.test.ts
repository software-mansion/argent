import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../src/registry";
import { ServiceState } from "../src/types";
import { createMockBlueprint, createMockToolDef } from "./helpers";

function lastUsedAt(registry: Registry, urn: string): number | undefined {
  return registry.getSnapshot().services.get(urn)?.lastUsedAt;
}

describe("Registry -- lastUsedAt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps a service a tool declares, and restamps it on the next call", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Sim"));
    registry.registerTool(createMockToolDef("tap", () => ({ sim: "Sim:dev-1" })));

    await registry.invokeTool("tap");
    expect(lastUsedAt(registry, "Sim:dev-1")).toBe(1_000_000);

    vi.setSystemTime(1_005_000);
    await registry.invokeTool("tap");
    expect(lastUsedAt(registry, "Sim:dev-1")).toBe(1_005_000);
  });

  it("stamps a service a tool resolves itself during execute", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Sim"));
    registry.registerTool({
      id: "screenshot",
      services: () => ({}),
      execute: () => registry.resolveService("Sim:dev-1"),
    });

    await registry.invokeTool("screenshot");

    expect(lastUsedAt(registry, "Sim:dev-1")).toBe(1_000_000);
  });

  it("restamps a service when the call that used it finishes, even when the call fails", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Sim"));
    registry.registerTool({
      id: "await-ui-element",
      services: () => ({ sim: "Sim:dev-1" }),
      execute: async () => {
        vi.setSystemTime(1_060_000);
        throw new Error("element never appeared");
      },
    });

    await expect(registry.invokeTool("await-ui-element")).rejects.toThrow("element never appeared");

    expect(lastUsedAt(registry, "Sim:dev-1")).toBe(1_060_000);
  });

  it("does not stamp a resolve made outside any tool call, nor a dependency", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Devtools"));
    registry.registerBlueprint(
      createMockBlueprint("Sim", { dependencies: (ctx) => ({ devtools: `Devtools:${ctx}` }) })
    );

    await registry.resolveService("Devtools:dev-2");
    registry.registerTool(createMockToolDef("tap", () => ({ sim: "Sim:dev-1" })));
    await registry.invokeTool("tap");

    expect(lastUsedAt(registry, "Devtools:dev-2")).toBeUndefined();
    expect(lastUsedAt(registry, "Devtools:dev-1")).toBeUndefined();
    expect(registry.getSnapshot().services.get("Devtools:dev-1")?.state).toBe(ServiceState.RUNNING);
  });
});
