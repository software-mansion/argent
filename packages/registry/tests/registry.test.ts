import { describe, it, expect } from "vitest";
import { Registry } from "../src/registry";
import { TypedEventEmitter } from "../src/event-emitter";
import { ServiceState } from "../src/types";
import type { ServiceEvents } from "../src/types";
import {
  ServiceNotFoundError,
  ServiceInitializationError,
  ToolNotFoundError,
  ToolExecutionError,
} from "../src/errors";
import {
  createStaticBlueprint,
  createMockToolDef,
  createMockBlueprint,
  staticUrn,
} from "./helpers";

describe("Registry -- Service Tests (blueprint-based)", () => {
  it("resolves a service and transitions to RUNNING", async () => {
    const registry = new Registry();
    const { blueprint } = createStaticBlueprint("A");
    registry.registerBlueprint(blueprint);

    const api = await registry.resolveService(staticUrn("A"));
    expect(api).toBeDefined();
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.RUNNING);
  });

  it("resolves a dependency chain", async () => {
    const registry = new Registry();
    const { blueprint: bBlueprint } = createStaticBlueprint("B");
    const { blueprint: aBlueprint } = createStaticBlueprint("A", {
      deps: ["B"],
    });
    registry.registerBlueprint(bBlueprint);
    registry.registerBlueprint(aBlueprint);

    await registry.resolveService(staticUrn("A"));
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.RUNNING);
    expect(registry.getServiceState(staticUrn("B"))).toBe(ServiceState.RUNNING);
  });

  it("deduplicates concurrent resolve calls", async () => {
    const registry = new Registry();
    const { blueprint } = createStaticBlueprint("A", { delay: 50 });
    registry.registerBlueprint(blueprint);

    const p1 = registry.resolveService(staticUrn("A"));
    const p2 = registry.resolveService(staticUrn("A"));
    expect(p1).toBe(p2);

    await p1;
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.RUNNING);
  });

  it("cascades termination to dependents", async () => {
    const registry = new Registry();
    const { blueprint: bBlueprint, emitters: bEmitters } = createStaticBlueprint("B");
    const { blueprint: aBlueprint } = createStaticBlueprint("A", {
      deps: ["B"],
    });
    registry.registerBlueprint(bBlueprint);
    registry.registerBlueprint(aBlueprint);

    await registry.resolveService(staticUrn("A"));
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.RUNNING);

    bEmitters[0]!.emit("terminated");
    await new Promise((r) => setTimeout(r, 50));

    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.IDLE);
    expect(registry.getServiceState(staticUrn("B"))).toBe(ServiceState.IDLE);
  });

  it("propagates initialization errors through dependency chain", async () => {
    const registry = new Registry();
    const { blueprint: bBlueprint } = createStaticBlueprint("B", {
      failOnInit: true,
    });
    const { blueprint: aBlueprint } = createStaticBlueprint("A", {
      deps: ["B"],
    });
    registry.registerBlueprint(bBlueprint);
    registry.registerBlueprint(aBlueprint);

    await expect(registry.resolveService(staticUrn("A"))).rejects.toThrow(
      ServiceInitializationError
    );
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.ERROR);
    expect(registry.getServiceState(staticUrn("B"))).toBe(ServiceState.ERROR);
  });

  it("re-initializes a service after ERROR state", async () => {
    const registry = new Registry();
    let callCount = 0;
    const { blueprint } = createStaticBlueprint("A", {
      failOnInit: () => {
        callCount++;
        return callCount === 1;
      },
    });
    registry.registerBlueprint(blueprint);

    await expect(registry.resolveService(staticUrn("A"))).rejects.toThrow();
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.ERROR);

    const api = await registry.resolveService(staticUrn("A"));
    expect(api).toBeDefined();
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.RUNNING);
  });

  it("detects circular dependencies", async () => {
    const registry = new Registry();
    const { blueprint: aBlueprint } = createStaticBlueprint("A", {
      deps: ["B"],
    });
    const { blueprint: bBlueprint } = createStaticBlueprint("B", {
      deps: ["A"],
    });
    registry.registerBlueprint(aBlueprint);
    registry.registerBlueprint(bBlueprint);

    await expect(registry.resolveService(staticUrn("A"))).rejects.toThrow(
      ServiceInitializationError
    );
  });

  it("throws ServiceNotFoundError for unregistered service", async () => {
    const registry = new Registry();
    await expect(registry.resolveService("unknown-ns:payload")).rejects.toThrow(
      ServiceNotFoundError
    );
  });

  it("cleans up reverse dependency references after teardown", async () => {
    const registry = new Registry();
    const { blueprint: bBlueprint, emitters: bEmitters } = createStaticBlueprint("B");
    const { blueprint: aBlueprint } = createStaticBlueprint("A", {
      deps: ["B"],
    });
    registry.registerBlueprint(bBlueprint);
    registry.registerBlueprint(aBlueprint);

    await registry.resolveService(staticUrn("A"));
    const snapshot1 = registry.getSnapshot();
    expect(snapshot1.services.get(staticUrn("B"))!.dependents).toContain(staticUrn("A"));

    bEmitters[0]!.emit("terminated");
    await new Promise((r) => setTimeout(r, 50));

    const snapshot2 = registry.getSnapshot();
    expect(snapshot2.services.get(staticUrn("B"))!.dependents).not.toContain(staticUrn("A"));
  });

  it("disposes all running services", async () => {
    const registry = new Registry();
    const { blueprint: aBlueprint } = createStaticBlueprint("A");
    const { blueprint: bBlueprint } = createStaticBlueprint("B");
    registry.registerBlueprint(aBlueprint);
    registry.registerBlueprint(bBlueprint);

    await registry.resolveService(staticUrn("A"));
    await registry.resolveService(staticUrn("B"));
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.RUNNING);
    expect(registry.getServiceState(staticUrn("B"))).toBe(ServiceState.RUNNING);

    await registry.dispose();
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.IDLE);
    expect(registry.getServiceState(staticUrn("B"))).toBe(ServiceState.IDLE);
  });
});

describe("Registry -- disposeService", () => {
  it("tears down a single running service to IDLE", async () => {
    const registry = new Registry();
    const { blueprint: aBlueprint } = createStaticBlueprint("A");
    const { blueprint: bBlueprint } = createStaticBlueprint("B");
    registry.registerBlueprint(aBlueprint);
    registry.registerBlueprint(bBlueprint);

    await registry.resolveService(staticUrn("A"));
    await registry.resolveService(staticUrn("B"));

    await registry.disposeService(staticUrn("A"));

    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.IDLE);
    expect(registry.getServiceState(staticUrn("B"))).toBe(ServiceState.RUNNING);
  });

  it("cascades teardown to dependents", async () => {
    const registry = new Registry();
    const { blueprint: bBlueprint } = createStaticBlueprint("B");
    const { blueprint: aBlueprint } = createStaticBlueprint("A", {
      deps: ["B"],
    });
    registry.registerBlueprint(bBlueprint);
    registry.registerBlueprint(aBlueprint);

    await registry.resolveService(staticUrn("A"));
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.RUNNING);
    expect(registry.getServiceState(staticUrn("B"))).toBe(ServiceState.RUNNING);

    await registry.disposeService(staticUrn("B"));

    expect(registry.getServiceState(staticUrn("B"))).toBe(ServiceState.IDLE);
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.IDLE);
  });

  it("throws ServiceNotFoundError for unknown URN", async () => {
    const registry = new Registry();
    await expect(registry.disposeService("nonexistent:urn")).rejects.toThrow(ServiceNotFoundError);
  });

  it("is a no-op for already-IDLE service", async () => {
    const registry = new Registry();
    const { blueprint } = createStaticBlueprint("A");
    registry.registerBlueprint(blueprint);

    await registry.resolveService(staticUrn("A"));
    await registry.dispose();
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.IDLE);

    await registry.disposeService(staticUrn("A"));
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.IDLE);
  });

  it("allows re-resolving a service after disposeService", async () => {
    const registry = new Registry();
    const { blueprint } = createStaticBlueprint("A");
    registry.registerBlueprint(blueprint);

    await registry.resolveService(staticUrn("A"));
    await registry.disposeService(staticUrn("A"));
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.IDLE);

    const api = await registry.resolveService(staticUrn("A"));
    expect(api).toBeDefined();
    expect(registry.getServiceState(staticUrn("A"))).toBe(ServiceState.RUNNING);
  });
});

describe("Registry -- Tool Tests", () => {
  it("starts required services when tool is invoked", async () => {
    const registry = new Registry();
    const { blueprint: sBlueprint } = createStaticBlueprint("S");
    registry.registerBlueprint(sBlueprint);
    registry.registerTool(createMockToolDef("T", () => ({ S: staticUrn("S") })));

    await registry.invokeTool("T");
    expect(registry.getServiceState(staticUrn("S"))).toBe(ServiceState.RUNNING);
  });

  it("passes correct service APIs to tool execute", async () => {
    const registry = new Registry();
    const { blueprint: sBlueprint } = createStaticBlueprint("S", {
      api: { hello: "world" },
    });
    registry.registerBlueprint(sBlueprint);

    let receivedServices: Record<string, unknown> = {};
    registry.registerTool({
      id: "T",
      services: () => ({ S: staticUrn("S") }),
      async execute(services) {
        receivedServices = services;
        return null;
      },
    });

    await registry.invokeTool("T");
    expect(receivedServices["S"]).toEqual({ hello: "world" });
  });

  it("returns the result from tool execute", async () => {
    const registry = new Registry();
    const { blueprint: sBlueprint } = createStaticBlueprint("S");
    registry.registerBlueprint(sBlueprint);
    registry.registerTool(createMockToolDef("T", () => ({ S: staticUrn("S") })));

    const result = (await registry.invokeTool("T")) as {
      toolId: string;
      receivedServices: string[];
      params: unknown;
    };
    expect(result.toolId).toBe("T");
  });

  it("forwards params to tool execute", async () => {
    const registry = new Registry();
    const { blueprint: sBlueprint } = createStaticBlueprint("S");
    registry.registerBlueprint(sBlueprint);
    registry.registerTool(createMockToolDef("T", () => ({ S: staticUrn("S") })));

    const result = (await registry.invokeTool("T", {
      key: "value",
    })) as { params: unknown };
    expect(result.params).toEqual({ key: "value" });
  });

  it("keeps services RUNNING after tool completes", async () => {
    const registry = new Registry();
    const { blueprint: sBlueprint } = createStaticBlueprint("S");
    registry.registerBlueprint(sBlueprint);
    registry.registerTool(createMockToolDef("T", () => ({ S: staticUrn("S") })));

    await registry.invokeTool("T");
    expect(registry.getServiceState(staticUrn("S"))).toBe(ServiceState.RUNNING);
  });

  it("wraps tool execute errors in ToolExecutionError", async () => {
    const registry = new Registry();
    const { blueprint: sBlueprint } = createStaticBlueprint("S");
    registry.registerBlueprint(sBlueprint);
    registry.registerTool(createMockToolDef("T", () => ({ S: staticUrn("S") }), { fail: true }));

    await expect(registry.invokeTool("T")).rejects.toThrow(ToolExecutionError);
  });

  it("wraps service init failures as ToolExecutionError", async () => {
    const registry = new Registry();
    const { blueprint: sBlueprint } = createStaticBlueprint("S", {
      failOnInit: true,
    });
    registry.registerBlueprint(sBlueprint);
    registry.registerTool(createMockToolDef("T", () => ({ S: staticUrn("S") })));

    await expect(registry.invokeTool("T")).rejects.toThrow(ToolExecutionError);
  });

  it("throws ToolNotFoundError for unregistered tool", async () => {
    const registry = new Registry();
    await expect(registry.invokeTool("x")).rejects.toThrow(ToolNotFoundError);
  });

  it("emits tool lifecycle events", async () => {
    const registry = new Registry();
    const { blueprint: sBlueprint } = createStaticBlueprint("S");
    registry.registerBlueprint(sBlueprint);
    registry.registerTool(createMockToolDef("T", () => ({ S: staticUrn("S") })));

    const invokedEvents: string[] = [];
    const completedEvents: string[] = [];

    registry.events.on("toolInvoked", (id) => invokedEvents.push(id));
    registry.events.on("toolCompleted", (id) => completedEvents.push(id));

    await registry.invokeTool("T");

    expect(invokedEvents).toEqual(["T"]);
    expect(completedEvents).toEqual(["T"]);
  });
});

describe("Registry -- Blueprint", () => {
  it("registers a blueprint and stores it by namespace", () => {
    const registry = new Registry();
    const blueprint = createMockBlueprint("sim-server");
    registry.registerBlueprint(blueprint);
    expect(registry.getBlueprint("sim-server")).toBe(blueprint);
  });

  it("throws when registering duplicate blueprint namespace", () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("sim-server"));
    expect(() => registry.registerBlueprint(createMockBlueprint("sim-server"))).toThrow(
      /already registered/
    );
  });

  it("resolveService JIT-instantiates and returns RUNNING instance", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("sim-server"));

    const api = (await registry.resolveService("sim-server:device1")) as { id: string };
    expect(api).toBeDefined();
    expect(api.id).toBe("device1");
    expect(registry.getServiceState("sim-server:device1")).toBe(ServiceState.RUNNING);
  });

  it("resolveService deduplicates concurrent calls for same URN", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("sim-server"));

    const p1 = registry.resolveService("sim-server:device1");
    const p2 = registry.resolveService("sim-server:device1");
    expect(p1).toBe(p2);

    await p1;
    expect(registry.getServiceState("sim-server:device1")).toBe(ServiceState.RUNNING);
  });

  it("resolveService throws ServiceNotFoundError for invalid URN", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("sim-server"));
    await expect(registry.resolveService("no-colon")).rejects.toThrow(ServiceNotFoundError);
  });

  it("resolveService throws ServiceNotFoundError for unknown namespace", async () => {
    const registry = new Registry();
    await expect(registry.resolveService("unknown-ns:payload")).rejects.toThrow(
      ServiceNotFoundError
    );
  });

  it("resolveService resolves blueprint with getDependencies", async () => {
    const registry = new Registry();
    registry.registerBlueprint(createMockBlueprint("B"));
    registry.registerBlueprint(
      createMockBlueprint("A", {
        dependencies: (ctx) => ({ b: `B:${ctx}` }),
      })
    );

    const api = (await registry.resolveService("A:ctx1")) as {
      id: string;
      deps: string[];
    };
    expect(api.id).toBe("ctx1");
    expect(api.deps).toContain("b");
    expect(registry.getServiceState("A:ctx1")).toBe(ServiceState.RUNNING);
    expect(registry.getServiceState("B:ctx1")).toBe(ServiceState.RUNNING);
  });

  it("invokeTool with services(params) resolves URNs and passes alias→API to execute", async () => {
    const registry = new Registry();
    const blueprint = createMockBlueprint("sim-server");
    registry.registerBlueprint(blueprint);
    registry.registerTool({
      id: "T",
      services: (params: { deviceId: string }) => ({
        server: blueprint.getURN(params.deviceId),
      }),
      async execute(services) {
        return { received: services.server };
      },
    });

    const result = (await registry.invokeTool("T", {
      deviceId: "device-1",
    })) as { received: { id: string } };
    expect(result.received.id).toBe("device-1");
    expect(registry.getServiceState("sim-server:device-1")).toBe(ServiceState.RUNNING);
  });

  it("resolveService detects circular dependency (A→B→A)", async () => {
    const registry = new Registry();
    registry.registerBlueprint(
      createMockBlueprint("A", {
        dependencies: () => ({ b: "B:y" }),
      })
    );
    registry.registerBlueprint(
      createMockBlueprint("B", {
        dependencies: () => ({ a: "A:x" }),
      })
    );

    await expect(registry.resolveService("A:x")).rejects.toThrow(ServiceInitializationError);
  });

  it("multi-scope: same blueprint different params yields distinct instances", async () => {
    const registry = new Registry();
    const blueprint = createMockBlueprint("sim-server");
    registry.registerBlueprint(blueprint);

    const apiA = (await registry.resolveService("sim-server:device-A")) as { id: string };
    const apiB = (await registry.resolveService("sim-server:device-B")) as { id: string };

    expect(apiA.id).toBe("device-A");
    expect(apiB.id).toBe("device-B");
    expect(apiA).not.toBe(apiB);

    const snapshot = registry.getSnapshot();
    expect(snapshot.services.has("sim-server:device-A")).toBe(true);
    expect(snapshot.services.has("sim-server:device-B")).toBe(true);
    expect(snapshot.services.size).toBe(2);
  });
});

describe("Registry -- getTool and extensions", () => {
  it("getTool returns definition for registered tool", () => {
    const registry = new Registry();
    const def = createMockToolDef("MyTool", () => ({}));
    registry.registerTool(def);
    expect(registry.getTool("MyTool")).toBe(def);
  });

  it("getTool returns undefined for unregistered tool", () => {
    const registry = new Registry();
    expect(registry.getTool("nonexistent")).toBeUndefined();
  });

  it("resolveService passes options to factory", async () => {
    const registry = new Registry();
    const blueprint = createMockBlueprint("opts");
    // Override factory to accept options (third arg)
    const capturedOptions: Record<string, unknown>[] = [];
    registry.registerBlueprint({
      ...blueprint,
      async factory(deps, context, options) {
        capturedOptions.push(options ?? {});
        return blueprint.factory(deps, context, options);
      },
    });

    await registry.resolveService("opts:ctx1", { token: "secret" });
    expect(capturedOptions.length).toBe(1);
    expect(capturedOptions[0]).toEqual({ token: "secret" });
  });

  it("invokeTool with ServiceRef object passes options to resolveService", async () => {
    const registry = new Registry();
    const capturedOptions: Record<string, unknown>[] = [];
    registry.registerBlueprint({
      namespace: "S",
      getURN: () => "S:only",
      async factory(_deps, _ctx, options) {
        capturedOptions.push(options ?? {});
        const events = new TypedEventEmitter<ServiceEvents>();
        return {
          api: {},
          dispose: async () => {},
          events,
        };
      },
    });
    registry.registerTool({
      id: "T",
      services: () => ({
        S: { urn: "S:only", options: { token: "xyz" } },
      }),
      async execute(services) {
        return { ok: !!services.S };
      },
    });

    await registry.invokeTool("T");
    expect(capturedOptions.length).toBe(1);
    expect(capturedOptions[0]).toEqual({ token: "xyz" });
  });
});
