import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../src/registry";
import { ServiceState } from "../src/types";
import { createMockBlueprint, createMockToolDef, createStaticBlueprint, staticUrn } from "./helpers";

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

  it("stamps a service a tool resolves itself when the call ends", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Sim"));
    registry.registerTool({
      id: "screenshot",
      services: () => ({}),
      execute: async () => {
        await registry.resolveService("Sim:dev-1");
        vi.setSystemTime(1_030_000);
      },
    });

    await registry.invokeTool("screenshot");

    expect(lastUsedAt(registry, "Sim:dev-1")).toBe(1_030_000);
  });

  it("reports the current time for a service while a call is using it", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Sim"));
    let duringCall: number | undefined;
    registry.registerTool({
      id: "await-screen-idle",
      services: () => ({ sim: "Sim:dev-1" }),
      execute: async () => {
        vi.setSystemTime(1_010_000);
        duringCall = lastUsedAt(registry, "Sim:dev-1");
      },
    });

    await registry.invokeTool("await-screen-idle");

    expect(duringCall).toBe(1_010_000);
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

  it("forgets a disposed service's stamp, so a later background resolve does not bring it back", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Devtools"));
    registry.registerTool(createMockToolDef("describe", () => ({ devtools: "Devtools:dev-1" })));

    await registry.invokeTool("describe");
    await registry.disposeService("Devtools:dev-1");
    await registry.resolveService("Devtools:dev-1");

    expect(registry.getSnapshot().services.get("Devtools:dev-1")?.state).toBe(ServiceState.RUNNING);
    expect(lastUsedAt(registry, "Devtools:dev-1")).toBeUndefined();
  });

  it("leaves no stamp on a service whose start failed in a tool call", async () => {
    const registry = new Registry();
    let fail = true;
    registry.registerBlueprint(createStaticBlueprint("sim", { failOnInit: () => fail }).blueprint);
    registry.registerTool(createMockToolDef("tap", () => ({ sim: staticUrn("sim") })));

    await expect(registry.invokeTool("tap")).rejects.toThrow();
    fail = false;
    await registry.resolveService(staticUrn("sim"));

    expect(registry.getSnapshot().services.get(staticUrn("sim"))?.state).toBe(ServiceState.RUNNING);
    expect(lastUsedAt(registry, staticUrn("sim"))).toBeUndefined();
  });
});
