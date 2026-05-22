import { describe, it, expect, vi, beforeEach } from "vitest";
import { TypedEventEmitter } from "@argent/registry";
import {
  electronJsRuntimeDebuggerBlueprint,
  electronJsRuntimeDebuggerRef,
  ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE,
} from "../src/blueprints/electron-js-runtime-debugger";
import { resolveDevice } from "../src/utils/device-info";
import type { ElectronCdpApi } from "../src/blueprints/electron-cdp";
import type { CDPClientEvents } from "../src/utils/debugger/cdp-client";

function makeFakeElectronCdpApi(): {
  api: ElectronCdpApi;
  events: TypedEventEmitter<CDPClientEvents>;
  sendSpy: ReturnType<typeof vi.fn>;
  addBindingSpy: ReturnType<typeof vi.fn>;
} {
  const events = new TypedEventEmitter<CDPClientEvents>();
  const sendSpy = vi.fn().mockResolvedValue({});
  const addBindingSpy = vi.fn().mockResolvedValue(undefined);
  const cdp = {
    events,
    isConnected: () => true,
    send: sendSpy,
    evaluate: vi.fn().mockResolvedValue(null),
    addBinding: addBindingSpy,
    getLoadedScripts: () => new Map(),
    getEnabledDomains: () => new Set<string>(),
  };
  // Cast through unknown — the blueprint only touches `cdp`, `port`, and
  // the events the test exercises, so a partial fake is fine.
  const api = {
    port: 19222,
    cdp,
  } as unknown as ElectronCdpApi;
  return { api, events, sendSpy, addBindingSpy };
}

describe("ElectronJsRuntimeDebugger blueprint", () => {
  const electronDevice = resolveDevice("electron-cdp-19222");

  it("namespace + URN + ref are stable", () => {
    expect(ELECTRON_JS_RUNTIME_DEBUGGER_NAMESPACE).toBe("ElectronJsRuntimeDebugger");
    expect(electronJsRuntimeDebuggerBlueprint.namespace).toBe("ElectronJsRuntimeDebugger");
    expect(electronJsRuntimeDebuggerBlueprint.getURN("electron-cdp-9222")).toBe(
      "ElectronJsRuntimeDebugger:electron-cdp-9222"
    );
    const ref = electronJsRuntimeDebuggerRef(electronDevice);
    expect(ref.urn).toBe("ElectronJsRuntimeDebugger:electron-cdp-19222");
    expect(ref.options.device).toEqual(electronDevice);
  });

  it("declares ElectronCdp as its dep so the registry resolves the page session first", () => {
    const deps = electronJsRuntimeDebuggerBlueprint.getDependencies!("electron-cdp-19222");
    expect(deps).toEqual({ electron: "ElectronCdp:electron-cdp-19222" });
  });

  it("factory rejects without options.device", async () => {
    await expect(
      electronJsRuntimeDebuggerBlueprint.factory(
        { electron: makeFakeElectronCdpApi().api },
        "electron-cdp-19222",
        undefined
      )
    ).rejects.toThrow(/requires a resolved DeviceInfo/);
  });

  it("factory rejects when options.device.id disagrees with the payload", async () => {
    await expect(
      electronJsRuntimeDebuggerBlueprint.factory(
        { electron: makeFakeElectronCdpApi().api },
        "electron-cdp-19222",
        { device: resolveDevice("electron-cdp-9999") }
      )
    ).rejects.toThrow(/payload .* does not match/);
  });

  it("factory: produces a JsRuntimeDebuggerApi-shaped object and subscribes to consoleAPICalled", async () => {
    const fake = makeFakeElectronCdpApi();
    const instance = await electronJsRuntimeDebuggerBlueprint.factory(
      { electron: fake.api },
      "electron-cdp-19222",
      { device: electronDevice }
    );
    try {
      expect(instance.api.port).toBe(19222);
      expect(instance.api.projectRoot).toBe("");
      expect(instance.api.logicalDeviceId).toBe("electron-cdp-19222");
      expect(instance.api.isNewDebugger).toBe(true);
      expect(instance.api.cdp).toBe(fake.api.cdp);
      // sourceResolver / sourceMaps stubs exist (only used by locked-out
      // inspect-element, but the type contract must hold).
      expect(typeof instance.api.sourceResolver.symbolicate).toBe("function");
      expect(typeof instance.api.sourceMaps.waitForPending).toBe("function");
      await expect(instance.api.sourceMaps.waitForPending()).resolves.toBeUndefined();

      // Console events from the CDP feed through to the api's consoleEvents.
      const received: unknown[] = [];
      instance.api.consoleEvents.on("log", (entry) => received.push(entry));
      fake.events.emit("consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "hello" }],
        timestamp: Date.now(),
      });
      expect(received).toHaveLength(1);
      expect((received[0] as { message: string }).message).toBe("hello");

      // Binding is registered best-effort so future tools using
      // evaluateWithBinding don't need their own setup.
      expect(fake.addBindingSpy).toHaveBeenCalledWith("__argent_callback");
    } finally {
      await instance.dispose();
    }
  });

  it("dispose unsubscribes from the underlying CDP — events do NOT keep firing", async () => {
    const fake = makeFakeElectronCdpApi();
    const instance = await electronJsRuntimeDebuggerBlueprint.factory(
      { electron: fake.api },
      "electron-cdp-19222",
      { device: electronDevice }
    );
    const received: unknown[] = [];
    instance.api.consoleEvents.on("log", (entry) => received.push(entry));
    await instance.dispose();
    fake.events.emit("consoleAPICalled", {
      type: "log",
      args: [{ type: "string", value: "after-dispose" }],
      timestamp: Date.now(),
    });
    expect(received).toHaveLength(0);
  });

  it("dispose does NOT disconnect the underlying CDP — that belongs to ElectronCdp", async () => {
    const fake = makeFakeElectronCdpApi();
    // Track whether anything calls disconnect on the cdp.
    const disconnect = vi.fn();
    (fake.api.cdp as unknown as { disconnect: typeof disconnect }).disconnect = disconnect;
    const instance = await electronJsRuntimeDebuggerBlueprint.factory(
      { electron: fake.api },
      "electron-cdp-19222",
      { device: electronDevice }
    );
    await instance.dispose();
    expect(disconnect).not.toHaveBeenCalled();
  });
});
