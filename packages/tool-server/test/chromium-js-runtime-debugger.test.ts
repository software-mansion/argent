import { describe, it, expect, vi } from "vitest";
import { TypedEventEmitter } from "@argent/registry";
import {
  chromiumJsRuntimeDebuggerBlueprint,
  chromiumJsRuntimeDebuggerRef,
  CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE,
} from "../src/blueprints/chromium-js-runtime-debugger";
import { resolveDevice } from "../src/utils/device-info";
import type { ChromiumCdpApi } from "../src/blueprints/chromium-cdp";
import type { CDPClientEvents } from "../src/utils/debugger/cdp-client";

function makeFakeChromiumCdpApi(): {
  api: ChromiumCdpApi;
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
  } as unknown as ChromiumCdpApi;
  return { api, events, sendSpy, addBindingSpy };
}

describe("ChromiumJsRuntimeDebugger blueprint", () => {
  const chromiumDevice = resolveDevice("chromium-cdp-19222");

  it("namespace + URN + ref are stable", () => {
    expect(CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE).toBe("ChromiumJsRuntimeDebugger");
    expect(chromiumJsRuntimeDebuggerBlueprint.namespace).toBe("ChromiumJsRuntimeDebugger");
    expect(chromiumJsRuntimeDebuggerBlueprint.getURN("chromium-cdp-9222")).toBe(
      "ChromiumJsRuntimeDebugger:chromium-cdp-9222"
    );
    const ref = chromiumJsRuntimeDebuggerRef(chromiumDevice);
    expect(ref.urn).toBe("ChromiumJsRuntimeDebugger:chromium-cdp-19222");
    expect(ref.options.device).toEqual(chromiumDevice);
  });

  it("declares ChromiumCdp as its dep so the registry resolves the page session first", () => {
    const deps = chromiumJsRuntimeDebuggerBlueprint.getDependencies!("chromium-cdp-19222");
    expect(deps).toEqual({ chromium: "ChromiumCdp:chromium-cdp-19222" });
  });

  it("factory rejects without options.device", async () => {
    await expect(
      chromiumJsRuntimeDebuggerBlueprint.factory(
        { chromium: makeFakeChromiumCdpApi().api },
        "chromium-cdp-19222",
        undefined
      )
    ).rejects.toThrow(/requires a resolved DeviceInfo/);
  });

  it("factory rejects when options.device.id disagrees with the payload", async () => {
    await expect(
      chromiumJsRuntimeDebuggerBlueprint.factory(
        { chromium: makeFakeChromiumCdpApi().api },
        "chromium-cdp-19222",
        { device: resolveDevice("chromium-cdp-9999") }
      )
    ).rejects.toThrow(/payload .* does not match/);
  });

  it("factory: produces a JsRuntimeDebuggerApi-shaped object and subscribes to consoleAPICalled", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    try {
      expect(instance.api.port).toBe(19222);
      expect(instance.api.projectRoot).toBe("");
      expect(instance.api.logicalDeviceId).toBe("chromium-cdp-19222");
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
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
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

  it("dispose does NOT disconnect the underlying CDP — that belongs to ChromiumCdp", async () => {
    const fake = makeFakeChromiumCdpApi();
    // Track whether anything calls disconnect on the cdp.
    const disconnect = vi.fn();
    (fake.api.cdp as unknown as { disconnect: typeof disconnect }).disconnect = disconnect;
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    await instance.dispose();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("cdp.disconnected → events.terminated propagation, with the original error preserved", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    try {
      const terminated: Array<Error | undefined> = [];
      instance.events.on("terminated", (err) => terminated.push(err));
      const cause = new Error("websocket closed by peer");
      fake.events.emit("disconnected", cause);
      expect(terminated).toHaveLength(1);
      expect(terminated[0]).toBe(cause);
    } finally {
      await instance.dispose();
    }
  });

  it("cdp.disconnected with no error still emits a terminated event with a synthetic Error", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    try {
      const terminated: Array<Error | undefined> = [];
      instance.events.on("terminated", (err) => terminated.push(err));
      fake.events.emit("disconnected", undefined);
      expect(terminated).toHaveLength(1);
      expect(terminated[0]).toBeInstanceOf(Error);
      expect((terminated[0] as Error).message).toMatch(/Chromium CDP disconnected/);
    } finally {
      await instance.dispose();
    }
  });

  it("dispose detaches the disconnected listener — no terminated emission after dispose", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    const terminated: unknown[] = [];
    instance.events.on("terminated", (err) => terminated.push(err));
    await instance.dispose();
    fake.events.emit("disconnected", new Error("late"));
    expect(terminated).toHaveLength(0);
  });

  it("a non-finite consoleAPICalled.timestamp is coerced — entry is captured, not silently dropped", async () => {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    try {
      const received: Array<{ message: string; timestamp: number }> = [];
      instance.api.consoleEvents.on("log", (entry) =>
        received.push({ message: entry.message, timestamp: entry.timestamp })
      );
      const before = Date.now();
      fake.events.emit("consoleAPICalled", {
        type: "log",
        args: [{ type: "string", value: "nan-test" }],
        timestamp: Number.NaN,
      });
      const after = Date.now();
      expect(received).toHaveLength(1);
      expect(received[0].message).toBe("nan-test");
      // Coerced to Date.now() — must be finite and within the call window.
      expect(Number.isFinite(received[0].timestamp)).toBe(true);
      expect(received[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(received[0].timestamp).toBeLessThanOrEqual(after);
    } finally {
      await instance.dispose();
    }
  });
});
