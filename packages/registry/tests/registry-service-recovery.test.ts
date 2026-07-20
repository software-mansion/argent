import { describe, it, expect } from "vitest";
import { Registry } from "../src/registry";
import { TypedEventEmitter } from "../src/event-emitter";
import { ServiceState } from "../src/types";
import type { ServiceBlueprint, ServiceEvents, ToolDefinition } from "../src/types";
import { ToolExecutionError } from "../src/errors";

/**
 * A blueprint whose instances carry an incrementing `epoch` and whose
 * `recoverable` predicate matches a marker error. `stats()` exposes how many
 * instances were created and disposed so a test can prove the registry tore a
 * dead one down and re-created a fresh one.
 */
function makeRecoverableBlueprint(namespace = "recov") {
  let created = 0;
  let disposed = 0;
  const blueprint: ServiceBlueprint<{ epoch: number }, string> = {
    namespace,
    getURN() {
      return `${namespace}:only`;
    },
    async factory() {
      const epoch = created++;
      const events = new TypedEventEmitter<ServiceEvents>();
      return {
        api: { epoch },
        dispose: async () => {
          disposed++;
        },
        events,
      };
    },
    recoverable(error: unknown): boolean {
      return error instanceof Error && error.message.includes("DEAD_SERVER");
    },
  };
  return {
    blueprint,
    urn: `${namespace}:only`,
    stats: () => ({ created, disposed }),
  };
}

/** Tool that throws a marker error while the resolved service's epoch is below `healthyFrom`. */
function makeProbeTool(
  urn: string,
  opts: { healthyFrom: number; recoverableError?: boolean } = { healthyFrom: 1 }
): ToolDefinition<unknown, { epoch: number }> {
  return {
    id: "probe",
    services: () => ({ svc: urn }),
    async execute(resolved): Promise<{ epoch: number }> {
      const svc = resolved.svc as { epoch: number };
      if (svc.epoch < opts.healthyFrom) {
        throw new Error(
          opts.recoverableError === false
            ? "plain failure, do not recover"
            : "DEAD_SERVER: connect ECONNREFUSED"
        );
      }
      return { epoch: svc.epoch };
    },
  };
}

describe("Registry -- service self-recovery on recoverable tool failure", () => {
  it("disposes a dead service and retries once, succeeding against a fresh instance", async () => {
    const registry = new Registry();
    const { blueprint, urn, stats } = makeRecoverableBlueprint();
    registry.registerBlueprint(blueprint);
    registry.registerTool(makeProbeTool(urn, { healthyFrom: 1 }));

    const result = await registry.invokeTool<{ epoch: number }>("probe");

    // Retried against a freshly re-created instance (epoch 1), not the dead one.
    expect(result.epoch).toBe(1);
    expect(stats()).toEqual({ created: 2, disposed: 1 });
    // The replacement instance is live and cached.
    expect(registry.getServiceState(urn)).toBe(ServiceState.RUNNING);
  });

  it("does not retry when the error is not recoverable", async () => {
    const registry = new Registry();
    const { blueprint, urn, stats } = makeRecoverableBlueprint();
    registry.registerBlueprint(blueprint);
    registry.registerTool(makeProbeTool(urn, { healthyFrom: 1, recoverableError: false }));

    await expect(registry.invokeTool("probe")).rejects.toBeInstanceOf(ToolExecutionError);

    // No dispose, no re-create — the original instance is left intact.
    expect(stats()).toEqual({ created: 1, disposed: 0 });
    expect(registry.getServiceState(urn)).toBe(ServiceState.RUNNING);
  });

  it("retries at most once, then surfaces the failure (no infinite respawn)", async () => {
    const registry = new Registry();
    const { blueprint, urn, stats } = makeRecoverableBlueprint();
    registry.registerBlueprint(blueprint);
    // healthyFrom huge → every instance throws the recoverable error.
    registry.registerTool(makeProbeTool(urn, { healthyFrom: 999 }));

    await expect(registry.invokeTool("probe")).rejects.toBeInstanceOf(ToolExecutionError);

    // Exactly one recovery: first instance disposed, one replacement created,
    // and the retry's failure is not itself retried.
    expect(stats()).toEqual({ created: 2, disposed: 1 });
  });

  it("only disposes the service that reports the error as recoverable", async () => {
    const registry = new Registry();
    const dead = makeRecoverableBlueprint("dead");
    const healthy = makeRecoverableBlueprint("healthy");
    // The healthy service never claims an error is recoverable.
    healthy.blueprint.recoverable = () => false;
    registry.registerBlueprint(dead.blueprint);
    registry.registerBlueprint(healthy.blueprint);

    // Tool resolves BOTH services; fails against the dead one on epoch 0.
    const tool: ToolDefinition<unknown, { epoch: number }> = {
      id: "probe",
      services: () => ({ dead: dead.urn, healthy: healthy.urn }),
      async execute(resolved): Promise<{ epoch: number }> {
        const d = resolved.dead as { epoch: number };
        if (d.epoch < 1) throw new Error("DEAD_SERVER: connect ECONNREFUSED");
        return { epoch: d.epoch };
      },
    };
    registry.registerTool(tool);

    const result = await registry.invokeTool<{ epoch: number }>("probe");

    expect(result.epoch).toBe(1);
    // Dead service was torn down + re-created; healthy one was left untouched.
    expect(dead.stats()).toEqual({ created: 2, disposed: 1 });
    expect(healthy.stats()).toEqual({ created: 1, disposed: 0 });
  });
});
