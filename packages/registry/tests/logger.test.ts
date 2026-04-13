import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Registry } from "../src/registry";
import { attachRegistryLogger } from "../src/logger";
import { createStaticBlueprint, createMockToolDef, staticUrn } from "./helpers";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("attachRegistryLogger — formatError via serviceError", () => {
  it("logs a single error with message and stack", async () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    const err = new Error("connection refused");
    registry.events.emit("serviceError", "svc:1", err);

    expect(errorSpy).toHaveBeenCalledOnce();
    const output = errorSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[registry] serviceError svc:1:");
    expect(output).toContain("connection refused");
    // Stack trace lines should be present (V8/Node always attaches .stack)
    expect(output).toContain("\n");
  });

  it("logs a 3-level cause chain joined by ' — caused by: '", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    const root = new Error("ECONNREFUSED");
    const mid = new Error("WebSocket handshake failed", { cause: root });
    const outer = new Error("Service init failed", { cause: mid });

    registry.events.emit("serviceError", "svc:2", outer);

    const output = errorSpy.mock.calls[0]![0] as string;
    expect(output).toContain("Service init failed");
    expect(output).toContain(" — caused by: ");
    expect(output).toContain("WebSocket handshake failed");
    expect(output).toContain("ECONNREFUSED");
  });

  it("deduplicates repeated messages in the cause chain", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    const inner = new Error("boom");
    const outer = new Error("boom", { cause: inner });

    registry.events.emit("serviceError", "svc:3", outer);

    const output = errorSpy.mock.calls[0]![0] as string;
    // "boom" should appear only once (no " — caused by: boom")
    expect(output).not.toContain(" — caused by: ");
    expect(output).toContain("boom");
  });

  it("falls back to message-only when stack is absent", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    const err = new Error("no stack");
    // Simulate an error with no stack (e.g. from a non-V8 runtime)
    err.stack = undefined;

    registry.events.emit("serviceError", "svc:4", err);

    const output = errorSpy.mock.calls[0]![0] as string;
    expect(output).toContain("no stack");
    // The output after the message should not have dangling newline + stack
    expect(output).toBe("[registry] serviceError svc:4:\nno stack");
  });

  it("uses the deepest stack in the chain", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    const inner = new Error("root cause");
    const outer = new Error("wrapper", { cause: inner });
    // Delete the outer stack so only the inner stack is available
    outer.stack = undefined;

    registry.events.emit("serviceError", "svc:5", outer);

    const output = errorSpy.mock.calls[0]![0] as string;
    // Should contain the inner error's stack (which has "root cause" in its first line)
    expect(output).toMatch(/at /);
  });
});

describe("attachRegistryLogger — formatError via toolFailed", () => {
  it("formats a cause chain for toolFailed the same way", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    const root = new Error("timeout");
    const outer = new Error("evaluate failed", { cause: root });

    registry.events.emit("toolFailed", "my-tool", outer);

    const output = errorSpy.mock.calls[0]![0] as string;
    expect(output).toContain("[registry] toolFailed my-tool:");
    expect(output).toContain("evaluate failed");
    expect(output).toContain("timeout");
  });
});

describe("attachRegistryLogger — happy-path events", () => {
  it("logs serviceStateChange", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    registry.events.emit("serviceStateChange", "svc:x", "IDLE" as any, "STARTING" as any);

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0]![0]).toContain("serviceStateChange svc:x: IDLE → STARTING");
  });

  it("logs toolRegistered", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    registry.events.emit("toolRegistered", "my-tool");

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0]![0]).toContain("toolRegistered my-tool");
  });

  it("logs toolInvoked", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    registry.events.emit("toolInvoked", "my-tool");

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0]![0]).toContain("toolInvoked my-tool");
  });

  it("logs toolCompleted with duration", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    registry.events.emit("toolCompleted", "my-tool", 123.456);

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0]![0]).toContain("toolCompleted my-tool (123.46ms)");
  });

  it("logs serviceRegistered", () => {
    const registry = new Registry();
    attachRegistryLogger(registry);

    registry.events.emit("serviceRegistered", "svc:1");

    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0]![0]).toContain("serviceRegistered svc:1");
  });
});

describe("attachRegistryLogger — end-to-end with Registry", () => {
  it("logs serviceError with cause when factory throws", async () => {
    const registry = new Registry();
    attachRegistryLogger(registry);
    const { blueprint } = createStaticBlueprint("Fail", { failOnInit: true });
    registry.registerBlueprint(blueprint);

    await expect(registry.resolveService(staticUrn("Fail"))).rejects.toThrow();

    const errorCalls = errorSpy.mock.calls.map((c) => c[0] as string);
    const serviceErrorLog = errorCalls.find((c) => c.includes("serviceError"));
    expect(serviceErrorLog).toBeDefined();
    expect(serviceErrorLog).toContain("Fail factory failure");
  });

  it("logs toolFailed with cause when tool execution errors", async () => {
    const registry = new Registry();
    attachRegistryLogger(registry);
    const { blueprint } = createStaticBlueprint("S");
    registry.registerBlueprint(blueprint);
    registry.registerTool(
      createMockToolDef("bad-tool", () => ({ S: staticUrn("S") }), { fail: true })
    );

    await expect(registry.invokeTool("bad-tool")).rejects.toThrow();

    const errorCalls = errorSpy.mock.calls.map((c) => c[0] as string);
    const toolFailedLog = errorCalls.find((c) => c.includes("toolFailed bad-tool"));
    expect(toolFailedLog).toBeDefined();
    expect(toolFailedLog).toContain("bad-tool execution failure");
  });
});
