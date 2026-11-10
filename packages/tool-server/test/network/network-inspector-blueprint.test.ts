import { EventEmitter } from "node:events";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Registry, ServiceState, TypedEventEmitter } from "@argent/registry";
import {
  networkInspectorBlueprint,
  NETWORK_INSPECTOR_NAMESPACE,
  findJsCapture,
  forgetJsCapture,
  forgetJsCapturesOf,
  installNetworkInterceptor,
  jsCapture,
  jsCapturePayload,
  jsCapturesOn,
  setJsCapture,
  type JsCapture,
} from "../../src/blueprints/network-inspector";
import type { CDPClient } from "../../src/utils/debugger/cdp-client";
import {
  NETWORK_INTERCEPTOR_SCRIPT,
  makeNetworkCaptureControlScript,
} from "../../src/utils/debugger/scripts/network-interceptor";

const ANDROID_PAYLOAD = "8081:emulator-5554";
const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const VEGA_PAYLOAD = "8081:amazon-6b8a76bae9485138";
const APP = "com.example.app";

function started(bundleId = APP): JsCapture {
  return { bundleId, intent: "started", mark: { install: null }, installed: false };
}

function stopped(bundleId = APP): JsCapture {
  return { bundleId, intent: "stopped", mark: { install: "t1", lastId: 3 }, installed: true };
}

/**
 * A CDP client of the app's JS runtime: it notes each script it evaluates and answers an install
 * with `install`, any other script with `{ installed: false }`.
 */
function fakeCdp(install: unknown = { installed: true }) {
  const scripts: string[] = [];
  const events = new EventEmitter();
  return {
    scripts,
    events,
    evaluate: vi.fn(async (script: string) => {
      scripts.push(script);
      return JSON.stringify(script === NETWORK_INTERCEPTOR_SCRIPT ? install : { installed: false });
    }),
  };
}

function asCdp(cdp: ReturnType<typeof fakeCdp>): CDPClient {
  return cdp as unknown as CDPClient;
}

afterEach(() => {
  forgetJsCapturesOf();
});

describe("NetworkInspector blueprint", () => {
  it("has namespace 'NetworkInspector'", () => {
    expect(networkInspectorBlueprint.namespace).toBe("NetworkInspector");
    expect(NETWORK_INSPECTOR_NAMESPACE).toBe("NetworkInspector");
  });

  it("getURN returns correct format", () => {
    expect(networkInspectorBlueprint.getURN("8081:SIM-UDID-123")).toBe(
      "NetworkInspector:8081:SIM-UDID-123"
    );
    expect(networkInspectorBlueprint.getURN("3000:DEV-B")).toBe("NetworkInspector:3000:DEV-B");
  });

  it("declares JsRuntimeDebugger as a dependency via getDependencies", () => {
    expect(networkInspectorBlueprint.getDependencies).toBeDefined();
    const deps = networkInspectorBlueprint.getDependencies!("8081:SIM-UDID-123");
    expect(deps).toEqual({ debugger: "JsRuntimeDebugger:8081:SIM-UDID-123" });
  });

  it("getDependencies uses the composite port:deviceId payload for the JsRuntimeDebugger URN", () => {
    const deps3000 = networkInspectorBlueprint.getDependencies!("3000:DEV-A");
    expect(deps3000).toEqual({ debugger: "JsRuntimeDebugger:3000:DEV-A" });

    const deps9090 = networkInspectorBlueprint.getDependencies!("9090:DEV-B");
    expect(deps9090).toEqual({ debugger: "JsRuntimeDebugger:9090:DEV-B" });
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

  it("factory installs the interceptor for a started capture, clearing a pause first", async () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    const cdp = fakeCdp();

    await networkInspectorBlueprint.factory({ debugger: { port: 8081, cdp } }, ANDROID_PAYLOAD);

    expect(cdp.scripts).toEqual([
      makeNetworkCaptureControlScript(false),
      NETWORK_INTERCEPTOR_SCRIPT,
    ]);
    expect(jsCapture(ANDROID_PAYLOAD)?.installed).toBe(true);
  });

  it("factory does not fail if interceptor injection throws (catches error)", async () => {
    setJsCapture("8081:emulator-5554", started());
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
    const instance = await networkInspectorBlueprint.factory(
      { debugger: mockDebuggerApi },
      "8081:emulator-5554"
    );
    expect(mockEvaluate).toHaveBeenCalled();
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
      getURN(payload: string) {
        return `JsRuntimeDebugger:${payload}`;
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

    const api = (await registry.resolveService("NetworkInspector:8081:SIM-UDID-123")) as {
      port: number;
      cdp: unknown;
    };

    expect(api.port).toBe(8081);
    expect(api.cdp).toBe(mockCdp);

    // Both services should be RUNNING
    expect(registry.getServiceState("JsRuntimeDebugger:8081:SIM-UDID-123")).toBe(
      ServiceState.RUNNING
    );
    expect(registry.getServiceState("NetworkInspector:8081:SIM-UDID-123")).toBe(
      ServiceState.RUNNING
    );

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

describe("installNetworkInterceptor", () => {
  it("installs for a started capture of the runtime's own app", async () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    const cdp = fakeCdp();

    expect(await installNetworkInterceptor(asCdp(cdp), ANDROID_PAYLOAD, { appId: APP })).toEqual({
      installed: true,
    });
    expect(cdp.scripts).toEqual([
      makeNetworkCaptureControlScript(false),
      NETWORK_INTERCEPTOR_SCRIPT,
    ]);
    expect(jsCapture(ANDROID_PAYLOAD)?.installed).toBe(true);
  });

  it("installs for a started capture when the runtime names no app", async () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    const cdp = fakeCdp();

    expect(await installNetworkInterceptor(asCdp(cdp), ANDROID_PAYLOAD, undefined)).toEqual({
      installed: true,
    });
    expect(cdp.scripts).toEqual([
      makeNetworkCaptureControlScript(false),
      NETWORK_INTERCEPTOR_SCRIPT,
    ]);
  });

  it("installs for a started capture stored with the device id in another case", async () => {
    setJsCapture(jsCapturePayload(8081, IOS_UDID), started());
    const cdp = fakeCdp();
    const payload = jsCapturePayload(8081, IOS_UDID.toLowerCase());

    expect(await installNetworkInterceptor(asCdp(cdp), payload, { appId: APP })).toEqual({
      installed: true,
    });
    expect(cdp.scripts).toEqual([
      makeNetworkCaptureControlScript(false),
      NETWORK_INTERCEPTOR_SCRIPT,
    ]);
    expect(jsCapture(jsCapturePayload(8081, IOS_UDID))?.installed).toBe(true);
  });

  it("counts a context that already has the interceptor as installed", async () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    const cdp = fakeCdp({ installed: false, reason: "already installed" });

    expect(await installNetworkInterceptor(asCdp(cdp), ANDROID_PAYLOAD, {})).toEqual({
      installed: true,
    });
    expect(jsCapture(ANDROID_PAYLOAD)?.installed).toBe(true);
  });

  it("returns why a context before its bundle got no interceptor, and keeps the capture not installed", async () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    const cdp = fakeCdp({ installed: false, reason: "no XMLHttpRequest yet" });

    expect(await installNetworkInterceptor(asCdp(cdp), ANDROID_PAYLOAD, {})).toEqual({
      installed: false,
      reason: "no XMLHttpRequest yet",
    });
    expect(jsCapture(ANDROID_PAYLOAD)?.installed).toBe(false);
  });

  it("installs nothing for a stopped capture", async () => {
    setJsCapture(ANDROID_PAYLOAD, stopped());
    const cdp = fakeCdp();

    expect(await installNetworkInterceptor(asCdp(cdp), ANDROID_PAYLOAD, { appId: APP })).toEqual({
      installed: false,
      reason: "capture is stopped",
    });
    expect(cdp.scripts).toEqual([]);
  });

  it("installs nothing in a runtime of another app", async () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    const cdp = fakeCdp();

    expect(
      await installNetworkInterceptor(asCdp(cdp), ANDROID_PAYLOAD, { appId: "com.other.app" })
    ).toEqual({ installed: false, reason: "the JS runtime is com.other.app's" });
    expect(cdp.scripts).toEqual([]);
    expect(jsCapture(ANDROID_PAYLOAD)?.installed).toBe(false);
  });

  it("installs nothing for a payload without a capture", async () => {
    const cdp = fakeCdp();

    expect(await installNetworkInterceptor(asCdp(cdp), ANDROID_PAYLOAD, undefined)).toEqual({
      installed: false,
      reason: "capture is not started",
    });
    expect(cdp.scripts).toEqual([]);
    expect(jsCapture(ANDROID_PAYLOAD)).toBeUndefined();
  });

  it("installs nothing for a capture on another Metro port of the device", async () => {
    setJsCapture("8190:emulator-5554", started());
    const cdp = fakeCdp();

    await installNetworkInterceptor(asCdp(cdp), ANDROID_PAYLOAD, undefined);
    expect(cdp.scripts).toEqual([]);
  });

  it("installs on Vega without a capture, as every Vega read does", async () => {
    const cdp = fakeCdp();

    expect(await installNetworkInterceptor(asCdp(cdp), VEGA_PAYLOAD, undefined)).toEqual({
      installed: true,
    });
    expect(cdp.scripts).toEqual([NETWORK_INTERCEPTOR_SCRIPT]);
    expect(jsCapture(VEGA_PAYLOAD)).toBeUndefined();
  });
});

describe("NetworkInspector service and the capture intent", () => {
  /** A registry whose JsRuntimeDebugger hands out `cdp`, for the runtime of `appId`. */
  function registryWith(cdp: ReturnType<typeof fakeCdp>, appId?: string): Registry {
    const registry = new Registry();
    registry.registerBlueprint({
      namespace: "JsRuntimeDebugger",
      getURN: (payload: string) => `JsRuntimeDebugger:${payload}`,
      async factory() {
        return {
          api: { port: 8081, cdp, runtimeApp: appId === undefined ? {} : { appId } },
          dispose: async () => {},
          events: new TypedEventEmitter(),
        };
      },
    });
    registry.registerBlueprint(networkInspectorBlueprint);
    return registry;
  }

  /** The app's JS runtime reloads: the CDP session ends and the service with it. */
  async function reload(registry: Registry, cdp: ReturnType<typeof fakeCdp>): Promise<void> {
    cdp.events.emit("disconnected", new Error("reloaded"));
    await vi.waitFor(() =>
      expect(registry.getServiceState(`NetworkInspector:${ANDROID_PAYLOAD}`)).toBe(
        ServiceState.ERROR
      )
    );
  }

  it("installs again in a service re-created after a reload while the capture is started", async () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    const cdp = fakeCdp();
    const registry = registryWith(cdp, APP);

    await registry.resolveService(`NetworkInspector:${ANDROID_PAYLOAD}`);
    await reload(registry, cdp);
    cdp.scripts.length = 0;
    await registry.resolveService(`NetworkInspector:${ANDROID_PAYLOAD}`);

    expect(cdp.scripts).toEqual([
      makeNetworkCaptureControlScript(false),
      NETWORK_INTERCEPTOR_SCRIPT,
    ]);
    expect(jsCapture(ANDROID_PAYLOAD)).toMatchObject({ bundleId: APP, intent: "started" });
    await registry.dispose();
  });

  it("keeps a stopped capture off in a service re-created after a reload", async () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    const cdp = fakeCdp();
    const registry = registryWith(cdp, APP);

    await registry.resolveService(`NetworkInspector:${ANDROID_PAYLOAD}`);
    setJsCapture(ANDROID_PAYLOAD, { ...jsCapture(ANDROID_PAYLOAD)!, intent: "stopped" });
    await reload(registry, cdp);
    cdp.scripts.length = 0;
    await registry.resolveService(`NetworkInspector:${ANDROID_PAYLOAD}`);

    expect(cdp.scripts).toEqual([]);
    expect(jsCapture(ANDROID_PAYLOAD)).toMatchObject({ intent: "stopped", installed: true });
    await registry.dispose();
  });

  it("installs nothing from the factory for a runtime of another app or a payload without a capture", async () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    const other = fakeCdp();
    const otherRegistry = registryWith(other, "com.other.app");
    await otherRegistry.resolveService(`NetworkInspector:${ANDROID_PAYLOAD}`);
    expect(other.scripts).toEqual([]);
    await otherRegistry.dispose();

    const none = fakeCdp();
    const noneRegistry = registryWith(none);
    await noneRegistry.resolveService("NetworkInspector:8190:emulator-5554");
    expect(none.scripts).toEqual([]);
    await noneRegistry.dispose();
  });
});

describe("JS capture map", () => {
  it("keeps one entry per device and app across Metro ports", () => {
    setJsCapture("8081:emulator-5554", started());
    setJsCapture("8081:emulator-5556", started());
    setJsCapture("9000:emulator-5554", started("com.other.app"));
    setJsCapture("8190:emulator-5554", { ...started(), mark: { install: "t2", lastId: 7 } });

    expect(jsCapture("8081:emulator-5554")).toBeUndefined();
    expect(jsCapture("8190:emulator-5554")).toMatchObject({ bundleId: APP });
    // Another app and another device keep theirs.
    expect(jsCapturesOn("emulator-5554").map(({ bundleId, port }) => [bundleId, port])).toEqual([
      ["com.other.app", 9000],
      [APP, 8190],
    ]);
    expect(jsCapturesOn("emulator-5556")).toHaveLength(1);
    expect(findJsCapture("emulator-5554", APP)).toEqual({
      ...started(),
      mark: { install: "t2", lastId: 7 },
      port: 8190,
    });
  });

  it("matches a device id written in another case", () => {
    setJsCapture(jsCapturePayload(8081, IOS_UDID), started());
    setJsCapture(jsCapturePayload(8190, IOS_UDID.toLowerCase()), stopped());

    expect(jsCapturesOn(IOS_UDID.toLowerCase())).toEqual([{ ...stopped(), port: 8190 }]);
    expect(findJsCapture(IOS_UDID, APP)).toMatchObject({ intent: "stopped", port: 8190 });
  });

  it("holds one capture per Metro port and device: another app's start there replaces it", () => {
    setJsCapture(ANDROID_PAYLOAD, started());
    setJsCapture(ANDROID_PAYLOAD, started("com.other.app"));

    expect(findJsCapture("emulator-5554", APP)).toBeUndefined();
    expect(jsCapture(ANDROID_PAYLOAD)).toMatchObject({ bundleId: "com.other.app" });
  });

  it("holds one capture per Metro port and device whatever the case of the device id", () => {
    setJsCapture(jsCapturePayload(8081, IOS_UDID), started());
    setJsCapture(jsCapturePayload(8081, IOS_UDID.toLowerCase()), stopped("com.other.app"));

    expect(jsCapture(jsCapturePayload(8081, IOS_UDID))).toMatchObject({
      bundleId: "com.other.app",
      intent: "stopped",
    });
    expect(jsCapturesOn(IOS_UDID)).toHaveLength(1);
  });

  it("finds nothing for an app or device without an entry", () => {
    setJsCapture(ANDROID_PAYLOAD, started());

    expect(findJsCapture("emulator-5554", "com.other.app")).toBeUndefined();
    expect(findJsCapture("emulator-5556", APP)).toBeUndefined();
    expect(jsCapturesOn("emulator-5556")).toEqual([]);
  });

  it("forgetJsCapture forgets the app's entries on that device only", () => {
    setJsCapture("8081:emulator-5554", started());
    setJsCapture("8190:emulator-5554", started("com.other.app"));
    setJsCapture("8081:emulator-5556", started());

    forgetJsCapture("emulator-5554", APP);

    expect(jsCapturesOn("emulator-5554").map(({ bundleId }) => bundleId)).toEqual([
      "com.other.app",
    ]);
    expect(findJsCapture("emulator-5556", APP)).toBeDefined();
  });

  it("forgetJsCapturesOf forgets the named devices' entries, or every entry without names", () => {
    setJsCapture("8081:emulator-5554", started());
    setJsCapture("8190:emulator-5554", started("com.other.app"));
    setJsCapture(jsCapturePayload(8081, IOS_UDID), started());
    setJsCapture("8081:emulator-5556", started());

    forgetJsCapturesOf(["emulator-5554", IOS_UDID.toLowerCase()]);

    expect(jsCapturesOn("emulator-5554")).toEqual([]);
    expect(jsCapturesOn(IOS_UDID)).toEqual([]);
    expect(jsCapturesOn("emulator-5556")).toHaveLength(1);

    forgetJsCapturesOf();
    expect(jsCapturesOn("emulator-5556")).toEqual([]);
  });
});
