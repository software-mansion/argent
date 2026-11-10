import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../src/registry";
import { TypedEventEmitter } from "../src/event-emitter";
import { ServiceState } from "../src/types";
import {
  createMockBlueprint,
  createMockToolDef,
  createStaticBlueprint,
  staticUrn,
} from "./helpers";

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

  it("keeps a service a dispatched step used in use until the dispatching call ends", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Sim"));
    registry.registerTool(createMockToolDef("tap", () => ({ sim: "Sim:dev-1" })));
    let betweenSteps: number | undefined;
    registry.registerTool({
      id: "run-sequence",
      services: () => ({}),
      execute: async () => {
        await registry.invokeTool("tap");
        vi.setSystemTime(1_005_000);
        betweenSteps = lastUsedAt(registry, "Sim:dev-1");
        vi.setSystemTime(1_008_000);
      },
    });

    await registry.invokeTool("run-sequence");

    expect(betweenSteps).toBe(1_005_000);
    expect(lastUsedAt(registry, "Sim:dev-1")).toBe(1_008_000);
  });

  it("keeps a service in use until the outermost of several nested calls ends", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Sim"));
    registry.registerTool(createMockToolDef("tap", () => ({ sim: "Sim:dev-1" })));
    registry.registerTool({
      id: "run-sequence",
      services: () => ({}),
      execute: async () => {
        await registry.invokeTool("tap");
      },
    });
    let afterSequence: number | undefined;
    registry.registerTool({
      id: "flow-execute",
      services: () => ({}),
      execute: async () => {
        await registry.invokeTool("run-sequence");
        vi.setSystemTime(1_005_000);
        afterSequence = lastUsedAt(registry, "Sim:dev-1");
      },
    });

    await registry.invokeTool("flow-execute");

    expect(afterSequence).toBe(1_005_000);
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

  it("forgets the stamp of a service that crashed", async () => {
    const registry = new Registry();
    const { blueprint, emitters } = createStaticBlueprint("sim");
    registry.registerBlueprint(blueprint);
    registry.registerTool(createMockToolDef("tap", () => ({ sim: staticUrn("sim") })));

    await registry.invokeTool("tap");
    emitters[0]!.emit("terminated", new Error("simulator-server exited"));
    await vi.waitFor(() =>
      expect(registry.getSnapshot().services.get(staticUrn("sim"))?.state).toBe(ServiceState.ERROR)
    );
    await registry.resolveService(staticUrn("sim"));

    expect(registry.getSnapshot().services.get(staticUrn("sim"))?.state).toBe(ServiceState.RUNNING);
    expect(lastUsedAt(registry, staticUrn("sim"))).toBeUndefined();
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

  it("forgets the stamp as soon as a service starts tearing down", async () => {
    const registry = new Registry();
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    registry.registerBlueprint({
      namespace: "Sim",
      getURN: (ctx: string) => `Sim:${ctx}`,
      factory: async () => ({
        api: {},
        dispose: () => disposeGate,
        events: new TypedEventEmitter(),
      }),
    });
    registry.registerTool(createMockToolDef("tap", () => ({ sim: "Sim:dev-1" })));
    await registry.invokeTool("tap");

    const disposing = registry.disposeService("Sim:dev-1");

    expect(registry.getSnapshot().services.get("Sim:dev-1")?.state).toBe(ServiceState.TERMINATING);
    expect(lastUsedAt(registry, "Sim:dev-1")).toBeUndefined();
    releaseDispose();
    await disposing;
  });

  it("stamps a service still starting when the call ends, and forgets it if the start fails", async () => {
    const registry = new Registry();
    let failStart!: () => void;
    const startGate = new Promise<void>(
      (_, reject) => (failStart = () => reject(new Error("boom")))
    );
    registry.registerBlueprint({
      namespace: "Sim",
      getURN: (ctx: string) => `Sim:${ctx}`,
      factory: async () => {
        await startGate;
        return { api: {}, dispose: async () => {}, events: new TypedEventEmitter() };
      },
    });
    let starting!: Promise<unknown>;
    registry.registerTool({
      id: "screenshot",
      services: () => ({}),
      execute: async () => {
        starting = registry.resolveService("Sim:dev-1").catch(() => {});
        vi.setSystemTime(1_020_000);
      },
    });

    await registry.invokeTool("screenshot");

    expect(registry.getSnapshot().services.get("Sim:dev-1")?.state).toBe(ServiceState.STARTING);
    expect(lastUsedAt(registry, "Sim:dev-1")).toBe(1_020_000);
    failStart();
    await starting;
    expect(registry.getSnapshot().services.get("Sim:dev-1")?.state).toBe(ServiceState.ERROR);
    expect(lastUsedAt(registry, "Sim:dev-1")).toBeUndefined();
  });

  it("reports the services of every call in flight at once as in use", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("Sim"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered = 0;
    registry.registerTool({
      id: "await-ui-element",
      services: (params: { udid: string }) => ({ sim: `Sim:${params.udid}` }),
      execute: async () => {
        entered++;
        await gate;
      },
    });

    const calls = ["dev-1", "dev-2"].map((udid) =>
      registry.invokeTool("await-ui-element", { udid })
    );
    await vi.waitFor(() => expect(entered).toBe(2));
    vi.setSystemTime(1_010_000);

    expect([lastUsedAt(registry, "Sim:dev-1"), lastUsedAt(registry, "Sim:dev-2")]).toEqual([
      1_010_000, 1_010_000,
    ]);
    release();
    await Promise.all(calls);
  });

  it("reports a service as in use while the call disposes it to retry", async () => {
    const registry = new Registry();
    const deadHandle = new Error("dead handle");
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => (releaseDispose = resolve));
    let disposing = false;
    registry.registerBlueprint({
      namespace: "Sim",
      getURN: (ctx: string) => `Sim:${ctx}`,
      recoverable: (error) => error === deadHandle,
      factory: async () => ({
        api: {},
        dispose: async () => {
          disposing = true;
          await disposeGate;
        },
        events: new TypedEventEmitter(),
      }),
    });
    let attempts = 0;
    registry.registerTool({
      id: "tap",
      services: () => ({ sim: "Sim:dev-1" }),
      execute: async () => {
        if (++attempts === 1) throw deadHandle;
      },
    });

    const call = registry.invokeTool("tap");
    await vi.waitFor(() => expect(disposing).toBe(true));
    vi.setSystemTime(1_010_000);

    expect(registry.getSnapshot().services.get("Sim:dev-1")?.state).toBe(ServiceState.TERMINATING);
    expect(lastUsedAt(registry, "Sim:dev-1")).toBe(1_010_000);
    releaseDispose();
    await call;
    expect(attempts).toBe(2);
  });

  it("stamps a service only the failed first attempt of a retried call used", async () => {
    const registry = new Registry();
    const deadHandle = new Error("dead handle");
    registry.registerBlueprint({
      namespace: "Sim",
      getURN: (ctx: string) => `Sim:${ctx}`,
      recoverable: (error) => error === deadHandle,
      factory: async () => ({ api: {}, dispose: async () => {}, events: new TypedEventEmitter() }),
    });
    registry.registerBlueprint(createMockBlueprint("Ax"));
    let attempts = 0;
    registry.registerTool({
      id: "tap",
      services: () => ({ sim: "Sim:dev-1" }),
      execute: async () => {
        if (++attempts > 1) return;
        await registry.resolveService("Ax:dev-1");
        throw deadHandle;
      },
    });

    vi.setSystemTime(1_020_000);
    await registry.invokeTool("tap");

    expect(attempts).toBe(2);
    expect(lastUsedAt(registry, "Ax:dev-1")).toBe(1_020_000);
  });

  it("reports a service as in use while the call is still starting it", async () => {
    const registry = new Registry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let factoryEntered = false;
    registry.registerBlueprint({
      namespace: "Sim",
      getURN: (ctx: string) => `Sim:${ctx}`,
      factory: async () => {
        factoryEntered = true;
        await gate;
        return { api: {}, dispose: async () => {}, events: new TypedEventEmitter() };
      },
    });
    registry.registerTool(createMockToolDef("tap", () => ({ sim: "Sim:dev-1" })));

    const call = registry.invokeTool("tap");
    await vi.waitFor(() => expect(factoryEntered).toBe(true));
    vi.setSystemTime(1_010_000);

    expect(registry.getSnapshot().services.get("Sim:dev-1")?.state).toBe(ServiceState.STARTING);
    expect(lastUsedAt(registry, "Sim:dev-1")).toBe(1_010_000);
    release();
    await call;
  });
});
