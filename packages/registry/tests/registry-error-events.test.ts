import { describe, it, expect } from "vitest";
import { Registry } from "../src/registry";
import { ServiceState } from "../src/types";
import { ServiceInitializationError } from "../src/errors";
import { createStaticBlueprint, staticUrn } from "./helpers";

describe("Registry — serviceError events carry cause", () => {
  it("emits serviceError with cause message when factory throws", async () => {
    const registry = new Registry();
    const { blueprint } = createStaticBlueprint("Broken", { failOnInit: true });
    registry.registerBlueprint(blueprint);

    const errors: { serviceId: string; error: Error }[] = [];
    registry.events.on("serviceError", (serviceId, error) => {
      errors.push({ serviceId, error });
    });

    await expect(registry.resolveService(staticUrn("Broken"))).rejects.toThrow();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    const event = errors.find((e) => e.serviceId === staticUrn("Broken"))!;
    expect(event).toBeDefined();
    expect(event.error.message).toContain("entered ERROR state");
    expect(event.error.message).toContain("Broken factory failure");
    expect(event.error.cause).toBeInstanceOf(Error);
    expect((event.error.cause as Error).message).toBe("Broken factory failure");
  });

  it("emits serviceError without cause message when no cause is provided", async () => {
    const registry = new Registry();
    const { blueprint } = createStaticBlueprint("A");
    registry.registerBlueprint(blueprint);

    const errors: { serviceId: string; error: Error }[] = [];
    registry.events.on("serviceError", (serviceId, error) => {
      errors.push({ serviceId, error });
    });

    await registry.resolveService(staticUrn("A"));

    // Manually trigger termination without error — teardown to IDLE, no serviceError
    await registry.disposeService(staticUrn("A"));
    const errorForA = errors.find((e) => e.serviceId === staticUrn("A"));
    expect(errorForA).toBeUndefined();
  });

  it("propagates cause through cascaded termination with error", async () => {
    const registry = new Registry();
    const { blueprint: bBlueprint, emitters: bEmitters } = createStaticBlueprint("B");
    const { blueprint: aBlueprint } = createStaticBlueprint("A", { deps: ["B"] });
    registry.registerBlueprint(bBlueprint);
    registry.registerBlueprint(aBlueprint);

    await registry.resolveService(staticUrn("A"));

    const errors: { serviceId: string; error: Error }[] = [];
    registry.events.on("serviceError", (serviceId, error) => {
      errors.push({ serviceId, error });
    });

    const disconnectError = new Error("WebSocket closed unexpectedly");
    bEmitters[0]!.emit("terminated", disconnectError);
    await new Promise((r) => setTimeout(r, 100));

    // Both A (dependent) and B should enter ERROR with cause info
    const errorForB = errors.find((e) => e.serviceId === staticUrn("B"));
    expect(errorForB).toBeDefined();
    expect(errorForB!.error.message).toContain("WebSocket closed unexpectedly");

    const errorForA = errors.find((e) => e.serviceId === staticUrn("A"));
    expect(errorForA).toBeDefined();
    expect(errorForA!.error.message).toContain("WebSocket closed unexpectedly");
  });

  it("preserves original cause in ServiceInitializationError through dep chain", async () => {
    const registry = new Registry();
    const { blueprint: bBlueprint } = createStaticBlueprint("DepFail", { failOnInit: true });
    const { blueprint: aBlueprint } = createStaticBlueprint("Parent", { deps: ["DepFail"] });
    registry.registerBlueprint(bBlueprint);
    registry.registerBlueprint(aBlueprint);

    try {
      await registry.resolveService(staticUrn("Parent"));
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceInitializationError);
      // Walk the cause chain — the original "DepFail factory failure" should be reachable
      let cursor: unknown = error;
      const messages: string[] = [];
      while (cursor instanceof Error) {
        messages.push(cursor.message);
        cursor = cursor.cause;
      }
      expect(messages.some((m) => m.includes("DepFail factory failure"))).toBe(true);
    }

    expect(registry.getServiceState(staticUrn("Parent"))).toBe(ServiceState.ERROR);
    expect(registry.getServiceState(staticUrn("DepFail"))).toBe(ServiceState.ERROR);
  });

  it("emits serviceError with cause when teardown is triggered with an error", async () => {
    const registry = new Registry();
    const { blueprint, emitters } = createStaticBlueprint("Teardown");
    registry.registerBlueprint(blueprint);

    await registry.resolveService(staticUrn("Teardown"));

    const errors: { serviceId: string; error: Error }[] = [];
    registry.events.on("serviceError", (serviceId, error) => {
      errors.push({ serviceId, error });
    });

    emitters[0]!.emit("terminated", new Error("process killed"));
    await new Promise((r) => setTimeout(r, 50));

    expect(registry.getServiceState(staticUrn("Teardown"))).toBe(ServiceState.ERROR);
    const event = errors.find((e) => e.serviceId === staticUrn("Teardown"));
    expect(event).toBeDefined();
    expect(event!.error.message).toContain("process killed");
    expect(event!.error.cause).toBeInstanceOf(Error);
  });

  it("transitions to IDLE (not ERROR) when terminated without error", async () => {
    const registry = new Registry();
    const { blueprint, emitters } = createStaticBlueprint("Clean");
    registry.registerBlueprint(blueprint);

    await registry.resolveService(staticUrn("Clean"));

    const errors: { serviceId: string; error: Error }[] = [];
    registry.events.on("serviceError", (serviceId, error) => {
      errors.push({ serviceId, error });
    });

    emitters[0]!.emit("terminated");
    await new Promise((r) => setTimeout(r, 50));

    expect(registry.getServiceState(staticUrn("Clean"))).toBe(ServiceState.IDLE);
    expect(errors.find((e) => e.serviceId === staticUrn("Clean"))).toBeUndefined();
  });
});
