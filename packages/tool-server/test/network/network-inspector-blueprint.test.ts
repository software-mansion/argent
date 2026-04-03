import { describe, it, expect, vi } from "vitest";
import { Registry, ServiceState } from "@argent/registry";
import {
  networkInspectorBlueprint,
  NETWORK_INSPECTOR_NAMESPACE,
} from "../../src/blueprints/network-inspector";

describe("NetworkInspector blueprint", () => {
  it("has namespace 'NetworkInspector'", () => {
    expect(networkInspectorBlueprint.namespace).toBe("NetworkInspector");
    expect(NETWORK_INSPECTOR_NAMESPACE).toBe("NetworkInspector");
  });

  it("getURN returns correct format", () => {
    expect(networkInspectorBlueprint.getURN("8081")).toBe("NetworkInspector:8081");
    expect(networkInspectorBlueprint.getURN("3000")).toBe("NetworkInspector:3000");
  });

  it("declares JsRuntimeDebugger as a dependency via getDependencies", () => {
    expect(networkInspectorBlueprint.getDependencies).toBeDefined();
    const deps = networkInspectorBlueprint.getDependencies!("8081");
    expect(deps).toEqual({ debugger: "JsRuntimeDebugger:8081" });
  });

  it("getDependencies uses the port context for the JsRuntimeDebugger URN", () => {
    const deps3000 = networkInspectorBlueprint.getDependencies!("3000");
    expect(deps3000).toEqual({ debugger: "JsRuntimeDebugger:3000" });

    const deps9090 = networkInspectorBlueprint.getDependencies!("9090");
    expect(deps9090).toEqual({ debugger: "JsRuntimeDebugger:9090" });
  });

  it("factory reuses the CDP client from the debugger dependency (does NOT create its own)", async () => {
    const mockEvaluate = vi.fn().mockResolvedValue(JSON.stringify({ installed: true }));
    const mockCdp = {
      evaluate: mockEvaluate,
      events: { on: vi.fn() },
    };
    const mockDebuggerApi = {
      port: 8081,
      cdp: mockCdp,
    };

    const instance = await networkInspectorBlueprint.factory({ debugger: mockDebuggerApi }, "8081");

    // The API's cdp should be the SAME object as the debugger's cdp
    expect(instance.api.cdp).toBe(mockCdp);
    expect(instance.api.port).toBe(8081);
  });

  it("factory injects the network interceptor script via cdp.evaluate", async () => {
    const mockEvaluate = vi.fn().mockResolvedValue(JSON.stringify({ installed: true }));
    const mockCdp = {
      evaluate: mockEvaluate,
      events: { on: vi.fn() },
    };
    const mockDebuggerApi = {
      port: 8081,
      cdp: mockCdp,
    };

    await networkInspectorBlueprint.factory({ debugger: mockDebuggerApi }, "8081");

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    // Verify it called evaluate with a string containing the interceptor guard
    const script = mockEvaluate.mock.calls[0][0] as string;
    expect(script).toContain("__argent_network_installed");
    expect(script).toContain("globalThis.fetch");
  });

  it("factory does not fail if interceptor injection throws (catches error)", async () => {
    const mockEvaluate = vi.fn().mockRejectedValue(new Error("eval failed"));
    const mockCdp = {
      evaluate: mockEvaluate,
      events: { on: vi.fn() },
    };
    const mockDebuggerApi = {
      port: 8081,
      cdp: mockCdp,
    };

    // Should not throw
    const instance = await networkInspectorBlueprint.factory({ debugger: mockDebuggerApi }, "8081");
    expect(instance.api).toBeDefined();
    expect(instance.api.port).toBe(8081);
  });

  it("dispose does NOT disconnect the CDP client (owned by JsRuntimeDebugger)", async () => {
    const mockDisconnect = vi.fn();
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue("{}"),
      disconnect: mockDisconnect,
      events: { on: vi.fn() },
    };
    const mockDebuggerApi = {
      port: 8081,
      cdp: mockCdp,
    };

    const instance = await networkInspectorBlueprint.factory({ debugger: mockDebuggerApi }, "8081");

    await instance.dispose();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  it("emits 'terminated' when the CDP connection disconnects", async () => {
    let disconnectHandler: ((error?: Error) => void) | null = null;
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue("{}"),
      events: {
        on: vi.fn((event: string, handler: (error?: Error) => void) => {
          if (event === "disconnected") {
            disconnectHandler = handler;
          }
        }),
      },
    };
    const mockDebuggerApi = {
      port: 8081,
      cdp: mockCdp,
    };

    const instance = await networkInspectorBlueprint.factory({ debugger: mockDebuggerApi }, "8081");

    const terminatedHandler = vi.fn();
    instance.events.on("terminated", terminatedHandler);

    // Simulate CDP disconnect
    expect(disconnectHandler).not.toBeNull();
    disconnectHandler!(new Error("connection lost"));

    expect(terminatedHandler).toHaveBeenCalledOnce();
    expect(terminatedHandler.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(terminatedHandler.mock.calls[0][0].message).toBe("connection lost");
  });

  it("registers in a Registry and resolves correctly with JsRuntimeDebugger dependency", async () => {
    // Use the real Registry to verify wiring is correct at the registry level.
    // We create a mock JsRuntimeDebugger blueprint that returns a fake API.
    const registry = new Registry();

    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue(JSON.stringify({ installed: true })),
      events: { on: vi.fn() },
    };

    // Register a fake JsRuntimeDebugger blueprint
    registry.registerBlueprint({
      namespace: "JsRuntimeDebugger",
      getURN(port: string) {
        return `JsRuntimeDebugger:${port}`;
      },
      async factory() {
        const { TypedEventEmitter } = await import("@argent/registry");
        const events = new TypedEventEmitter();
        return {
          api: { port: 8081, cdp: mockCdp, projectRoot: "/test" },
          dispose: async () => {},
          events,
        };
      },
    });

    registry.registerBlueprint(networkInspectorBlueprint);

    const api = (await registry.resolveService("NetworkInspector:8081")) as {
      port: number;
      cdp: unknown;
    };

    expect(api.port).toBe(8081);
    expect(api.cdp).toBe(mockCdp);

    // Both services should be RUNNING
    expect(registry.getServiceState("JsRuntimeDebugger:8081")).toBe(ServiceState.RUNNING);
    expect(registry.getServiceState("NetworkInspector:8081")).toBe(ServiceState.RUNNING);

    await registry.dispose();
  });

  it("emits 'terminated' with fallback Error when disconnectHandler called with undefined", async () => {
    let disconnectHandler: ((error?: Error) => void) | null = null;
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue("{}"),
      events: {
        on: vi.fn((event: string, handler: (error?: Error) => void) => {
          if (event === "disconnected") {
            disconnectHandler = handler;
          }
        }),
      },
    };
    const mockDebuggerApi = {
      port: 8081,
      cdp: mockCdp,
    };

    const instance = await networkInspectorBlueprint.factory({ debugger: mockDebuggerApi }, "8081");

    const terminatedHandler = vi.fn();
    instance.events.on("terminated", terminatedHandler);

    // Simulate CDP disconnect with no error (undefined)
    disconnectHandler!(undefined as unknown as Error);

    expect(terminatedHandler).toHaveBeenCalledOnce();
    const emittedError = terminatedHandler.mock.calls[0][0];
    expect(emittedError).toBeInstanceOf(Error);
    expect(emittedError.message).toBe("CDP disconnected");
  });

  it("does not import discovery, target-selection, or construct CDPClient", async () => {
    // Read the source file to verify no dangerous imports exist.
    // This is a static analysis check to catch regressions.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.resolve(__dirname, "../../src/blueprints/network-inspector.ts"),
      "utf-8"
    );

    // Must NOT import from discovery or target-selection (that would mean it creates its own connection)
    expect(source).not.toContain('from "../utils/debugger/discovery"');
    expect(source).not.toContain('from "../utils/debugger/target-selection"');
    // Must NOT construct new CDPClient (only imports the type)
    expect(source).not.toContain("new CDPClient");
    // Should use type-only import for CDPClient
    expect(source).toContain("import type");
  });
});
