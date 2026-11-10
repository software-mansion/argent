import { execFileSync } from "node:child_process";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Registry } from "../src/registry";
import { ServiceState } from "../src/types";
import {
  getFailureSignal,
  ServiceInitializationError,
  subprocessFailureMetadata,
  withFailureSignal,
} from "../src/errors";
import { FAILURE_CODES } from "../src/failure-codes";
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

describe("Registry — failure signals", () => {
  it("preserves a safe failure signal when wrapping tool execution errors", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "failing-tool",
      services: () => ({}),
      async execute() {
        throw withFailureSignal(new Error("private /Users/alice/project failure"), {
          error_code: FAILURE_CODES.TOOL_DEPENDENCY_MISSING,
          failure_stage: "failing_tool_execute",
          failure_area: "tool_server",
          error_kind: "unknown",
        });
      },
    });

    let emittedError: Error | null = null;
    registry.events.on("toolFailed", (_toolId, _toolInvocationId, error) => {
      emittedError = error;
    });

    await expect(registry.invokeTool("failing-tool")).rejects.toThrow();

    expect(emittedError).toBeInstanceOf(Error);
    expect(getFailureSignal(emittedError)).toEqual({
      error_code: FAILURE_CODES.TOOL_DEPENDENCY_MISSING,
      failure_stage: "failing_tool_execute",
      failure_area: "tool_server",
      error_kind: "unknown",
    });
  });

  it("attributes a schema miss to the REGISTRY, not to the tool that never ran", async () => {
    const registry = new Registry();
    const execute = vi.fn();
    registry.registerTool({
      id: "typed-tool",
      services: () => ({}),
      zodSchema: z.object({ x: z.number() }),
      execute,
    } as never);

    let emittedError: Error | null = null;
    registry.events.on("toolFailed", (_toolId, _toolInvocationId, error) => {
      emittedError = error;
    });

    await expect(registry.invokeTool("typed-tool", { xx: 1 })).rejects.toThrow(/Invalid params/);

    expect(execute).not.toHaveBeenCalled();
    expect(getFailureSignal(emittedError)).toEqual({
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "tool_params_parse",
      failure_area: "registry",
      error_kind: "validation",
    });
  });

  it("classifies a tool that throws on its caller's abort as cancelled", async () => {
    const registry = new Registry();
    const controller = new AbortController();
    registry.registerTool({
      id: "slow-tool",
      services: () => ({}),
      execute: async (_services: unknown, _params: unknown, ctx: { signal: AbortSignal }) => {
        controller.abort();
        const err = new Error(`aborted: ${ctx.signal.aborted}`);
        err.name = "AbortError";
        throw err;
      },
    } as never);

    let emittedError: Error | null = null;
    registry.events.on("toolFailed", (_toolId, _toolInvocationId, error) => {
      emittedError = error;
    });

    await expect(
      registry.invokeTool("slow-tool", {}, { signal: controller.signal })
    ).rejects.toThrow("aborted: true");

    expect(getFailureSignal(emittedError)).toEqual({
      error_code: FAILURE_CODES.REGISTRY_TOOL_CALL_CANCELLED,
      failure_stage: "registry_tool_cancelled",
      failure_area: "registry",
      error_kind: "cancelled",
    });
  });

  it("classifies an unclassified failure after its caller's abort as cancelled", async () => {
    const registry = new Registry();
    const controller = new AbortController();
    registry.registerTool({
      id: "adb-tool",
      services: () => ({}),
      execute: async () => {
        controller.abort();
        throw new Error("adb exited with SIGTERM");
      },
    } as never);

    let emittedError: Error | null = null;
    registry.events.on("toolFailed", (_toolId, _toolInvocationId, error) => {
      emittedError = error;
    });

    await expect(
      registry.invokeTool("adb-tool", {}, { signal: controller.signal })
    ).rejects.toThrow("adb exited with SIGTERM");

    expect(getFailureSignal(emittedError)?.error_code).toBe(
      FAILURE_CODES.REGISTRY_TOOL_CALL_CANCELLED
    );
  });

  it("keeps the tool's own classification when it fails after the caller aborted", async () => {
    const registry = new Registry();
    const controller = new AbortController();
    const ownSignal = {
      error_code: FAILURE_CODES.VEGA_BOOT_TIMEOUT,
      failure_stage: "boot_timeout",
      failure_area: "tool_server",
      error_kind: "timeout",
    } as const;
    registry.registerTool({
      id: "slow-tool",
      services: () => ({}),
      execute: async () => {
        controller.abort();
        throw withFailureSignal(new Error("boot timed out"), ownSignal);
      },
    } as never);

    let emittedError: Error | null = null;
    registry.events.on("toolFailed", (_toolId, _toolInvocationId, error) => {
      emittedError = error;
    });

    await expect(
      registry.invokeTool("slow-tool", {}, { signal: controller.signal })
    ).rejects.toThrow("boot timed out");

    expect(getFailureSignal(emittedError)).toEqual(ownSignal);
  });

  it("classifies an abort the tool wrapped in its own failure as cancelled", async () => {
    const registry = new Registry();
    const controller = new AbortController();
    registry.registerTool({
      id: "fetching-tool",
      services: () => ({}),
      execute: async () => {
        controller.abort();
        throw withFailureSignal(
          new Error("request timed out", { cause: controller.signal.reason }),
          {
            error_code: FAILURE_CODES.SIMULATOR_NETWORK_TIMEOUT,
            failure_stage: "simulator_server_network",
            failure_area: "tool_server",
            error_kind: "timeout",
          }
        );
      },
    } as never);

    let emittedError: Error | null = null;
    registry.events.on("toolFailed", (_toolId, _toolInvocationId, error) => {
      emittedError = error;
    });

    await expect(
      registry.invokeTool("fetching-tool", {}, { signal: controller.signal })
    ).rejects.toThrow("request timed out");

    expect(getFailureSignal(emittedError)?.error_code).toBe(
      FAILURE_CODES.REGISTRY_TOOL_CALL_CANCELLED
    );
  });

  it("classifies a tool's own AbortError as cancelled even when a classified failure is its cause", async () => {
    const registry = new Registry();
    const controller = new AbortController();
    registry.registerTool({
      id: "gesture-tool",
      services: () => ({}),
      execute: async () => {
        controller.abort();
        const liftFailure = withFailureSignal(new Error("lift refused"), {
          error_code: FAILURE_CODES.SIMULATOR_NETWORK_TIMEOUT,
          failure_stage: "simulator_server_network",
          failure_area: "tool_server",
          error_kind: "timeout",
        });
        const abortError = new Error("gesture cancelled", { cause: liftFailure });
        abortError.name = "AbortError";
        throw abortError;
      },
    } as never);

    let emittedError: Error | null = null;
    registry.events.on("toolFailed", (_toolId, _toolInvocationId, error) => {
      emittedError = error;
    });

    await expect(
      registry.invokeTool("gesture-tool", {}, { signal: controller.signal })
    ).rejects.toThrow("gesture cancelled");

    expect(getFailureSignal(emittedError)?.error_code).toBe(
      FAILURE_CODES.REGISTRY_TOOL_CALL_CANCELLED
    );
  });

  it("keeps a tool's own timeout that Node raised as an AbortError after the caller aborted", async () => {
    const registry = new Registry();
    const controller = new AbortController();
    const ownTimeout = AbortSignal.timeout(1);
    await new Promise((resolve) => ownTimeout.addEventListener("abort", resolve));
    registry.registerTool({
      id: "runner-tool",
      services: () => ({}),
      execute: async () => {
        controller.abort();
        const nodeAbort = new Error("The operation was aborted", { cause: ownTimeout.reason });
        nodeAbort.name = "AbortError";
        throw withFailureSignal(new Error("runner request timed out", { cause: nodeAbort }), {
          error_code: FAILURE_CODES.SIMULATOR_NETWORK_TIMEOUT,
          failure_stage: "simulator_server_network",
          failure_area: "tool_server",
          error_kind: "timeout",
        });
      },
    } as never);

    let emittedError: Error | null = null;
    registry.events.on("toolFailed", (_toolId, _toolInvocationId, error) => {
      emittedError = error;
    });

    await expect(
      registry.invokeTool("runner-tool", {}, { signal: controller.signal })
    ).rejects.toThrow("runner request timed out");

    expect(getFailureSignal(emittedError)?.error_code).toBe(
      FAILURE_CODES.SIMULATOR_NETWORK_TIMEOUT
    );
  });

  it("keeps the tool's own classification when the caller did not abort", async () => {
    const registry = new Registry();
    registry.registerTool({
      id: "failing-tool",
      services: () => ({}),
      execute: async () => {
        throw new Error("boom");
      },
    } as never);

    let emittedError: Error | null = null;
    registry.events.on("toolFailed", (_toolId, _toolInvocationId, error) => {
      emittedError = error;
    });

    await expect(
      registry.invokeTool("failing-tool", {}, { signal: new AbortController().signal })
    ).rejects.toThrow("boom");

    expect(getFailureSignal(emittedError)?.error_code).toBe(
      FAILURE_CODES.REGISTRY_TOOL_EXECUTION_FAILED
    );
  });

  it("derives only safe subprocess metadata", () => {
    expect(
      subprocessFailureMetadata(
        { code: 127, signal: "SIGKILL", stderr: "secret", message: "/Users/alice/private" },
        "xcrun_simctl"
      )
    ).toEqual({
      failure_command: "xcrun_simctl",
      failure_exit_code: 127,
      failure_signal: "SIGKILL",
    });

    expect(
      subprocessFailureMetadata(
        { code: "ENOENT", signal: "SIGUSR1", path: "/Users/alice/private" },
        "adb"
      )
    ).toEqual({
      failure_command: "adb",
      failure_spawn_code: "ENOENT",
    });
  });

  it("reads the exit code of an execFileSync failure from status", () => {
    let error: unknown;
    try {
      execFileSync(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
    } catch (e) {
      error = e;
    }
    expect(subprocessFailureMetadata(error, "unknown")).toEqual({
      failure_command: "unknown",
      failure_exit_code: 3,
    });
  });

  it("reports an execFileSync timeout as ETIMEDOUT even when the child exited with a status", () => {
    // A child that traps SIGTERM and exits 0 after the timeout.
    expect(
      subprocessFailureMetadata({ code: "ETIMEDOUT", status: 0, signal: null }, "unknown")
    ).toEqual({
      failure_command: "unknown",
      failure_spawn_code: "ETIMEDOUT",
    });
  });

  it("finds a signal attached to a wrapped cause", () => {
    const inner = withFailureSignal(new Error("inner"), {
      error_code: FAILURE_CODES.TOOL_DEPENDENCY_MISSING,
      failure_stage: "inner_stage",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
    });
    const outer = new Error("outer", { cause: inner });

    expect(getFailureSignal(outer)?.error_code).toBe(FAILURE_CODES.TOOL_DEPENDENCY_MISSING);
  });

  it("finds a signal attached to an AggregateError sub-error", () => {
    const sub = withFailureSignal(new Error("sub"), {
      error_code: FAILURE_CODES.TOOL_DEPENDENCY_MISSING,
      failure_stage: "sub_stage",
      failure_area: "tool_server",
      error_kind: "dependency_missing",
    });
    const aggregate = new AggregateError([new Error("noise"), sub], "all failed");

    expect(getFailureSignal(aggregate)?.error_code).toBe(FAILURE_CODES.TOOL_DEPENDENCY_MISSING);
  });

  it("terminates on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as Error & { cause?: unknown }).cause = b;
    (b as Error & { cause?: unknown }).cause = a;

    expect(getFailureSignal(a)).toBeNull();
  });
});
