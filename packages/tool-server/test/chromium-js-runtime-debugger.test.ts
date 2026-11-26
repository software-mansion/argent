import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { TypedEventEmitter } from "@argent/registry";
import {
  chromiumJsRuntimeDebuggerBlueprint,
  chromiumJsRuntimeDebuggerRef,
  CHROMIUM_JS_RUNTIME_DEBUGGER_NAMESPACE,
} from "../src/blueprints/chromium-js-runtime-debugger";
import { resolveDevice } from "../src/utils/device-info";
import type { ChromiumCdpApi } from "../src/blueprints/chromium-cdp";
import type { CDPClientEvents } from "../src/utils/debugger/cdp-client";
import { takeReapedSession, __resetReapedSessionsForTesting } from "../src/utils/reaped-sessions";
import { scopeTempHome } from "./helpers/temp-home";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

// The JS-runtime-debugger / network blueprints build a real LogFileWriter,
// whose constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-chromium-jsdbg-home-");

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

  it("dispose leaves a reaped-session breadcrumb when it deletes captured history", async () => {
    // `debugger-log-registry` documents itself as working against Hermes AND
    // V8, and promises that an empty registry with no `note` means the app
    // logged nothing. `logWriter.close()` here unlinks the log file, and since
    // ChromiumJsRuntimeDebugger joined DEVICE_OWNED_NAMESPACES a
    // stop-all-simulator-servers (or a stop-simulator-server cascading through
    // ChromiumCdp) routinely triggers this dispose. Without the breadcrumb the
    // promise is false on V8: destroyed history reads as a silent app.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    for (let i = 0; i < 18; i++) {
      instance.api.logWriter.write({
        id: i,
        timestamp: new Date(1710000000000 + i * 1000).toISOString(),
        level: "log",
        message: `captured ${i}`,
      });
    }
    await instance.dispose();

    const reaped = takeReapedSession("js-runtime-debugger", "chromium-cdp-19222");
    expect(reaped).toBeDefined();
    expect(reaped!.salvage).toContain("18 captured console entries");
    expect(reaped!.salvage).toContain("the log file is deleted on teardown");
    expect(reaped!.salvage).not.toContain("no log file held them");
    expect(fs.existsSync(instance.api.logWriter.getFilePath())).toBe(false);
  });

  it("dispose after the CDP socket dropped keeps the log file and names it", async () => {
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    instance.api.logWriter.write({
      id: 0,
      timestamp: new Date(1710000000000).toISOString(),
      level: "error",
      message: "before the crash",
    });
    (fake.api.cdp as { isConnected: () => boolean }).isConnected = () => false;
    await instance.dispose();

    const file = instance.api.logWriter.getFilePath();
    expect(fs.readFileSync(file, "utf-8")).toContain("before the crash");
    const reaped = takeReapedSession("js-runtime-debugger", "chromium-cdp-19222");
    expect(reaped!.connectionLost).toBe(true);
    expect(reaped!.salvage).toContain(`kept at ${file}`);
  });

  it("dispose after the CDP socket dropped names no log file when there is none", async () => {
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    instance.api.logWriter.write({
      id: 0,
      timestamp: new Date(1710000000000).toISOString(),
      level: "error",
      message: "before the crash",
    });
    fs.rmSync(instance.api.logWriter.getFilePath(), { force: true });
    (fake.api.cdp as { isConnected: () => boolean }).isConnected = () => false;
    await instance.dispose();

    const reaped = takeReapedSession("js-runtime-debugger", "chromium-cdp-19222");
    expect(reaped!.connectionLost).toBe(true);
    expect(reaped!.salvage).toContain("no log file held them");
    expect(reaped!.salvage).not.toContain("kept at");
  });

  it("dispose after the CDP socket dropped keeps no file that every write failed to fill", async () => {
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    vi.mocked(fs.writeSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    });
    instance.api.logWriter.write({
      id: 0,
      timestamp: new Date(1710000000000).toISOString(),
      level: "error",
      message: "before the crash",
    });
    (fake.api.cdp as { isConnected: () => boolean }).isConnected = () => false;
    await instance.dispose();

    const reaped = takeReapedSession("js-runtime-debugger", "chromium-cdp-19222");
    expect(reaped!.salvage).toContain("no log file held them");
    expect(reaped!.salvage).not.toContain("kept at");
  });

  it("dispose after the CDP socket dropped says how many entries the kept file holds", async () => {
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    for (let id = 0; id < 3; id++) {
      if (id > 0) {
        vi.mocked(fs.writeSync).mockImplementationOnce(() => {
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
            code: "ENOSPC",
          });
        });
      }
      instance.api.logWriter.write({
        id,
        timestamp: new Date(1710000000000).toISOString(),
        level: "error",
        message: `entry ${id}`,
      });
    }
    (fake.api.cdp as { isConnected: () => boolean }).isConnected = () => false;
    await instance.dispose();

    const reaped = takeReapedSession("js-runtime-debugger", "chromium-cdp-19222");
    expect(reaped!.salvage).toContain(
      `The log file with 1 of its 3 captured console entries is kept at ${instance.api.logWriter.getFilePath()}`
    );
  });

  it("dispose leaves NO breadcrumb when there was no history to lose", async () => {
    // A dispose of a session that captured nothing destroyed nothing, and
    // claiming otherwise would make every empty registry look like a lost one.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    await instance.dispose();
    expect(takeReapedSession("js-runtime-debugger", "chromium-cdp-19222")).toBeUndefined();
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

  async function captureLogs() {
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    const received: Array<{ level: string; message: string }> = [];
    instance.api.consoleEvents.on("log", (entry) =>
      received.push({ level: entry.level, message: entry.message })
    );
    return { fake, instance, received };
  }

  it("records a browser Log.entryAdded message with the resource URL", async () => {
    const { fake, instance, received } = await captureLogs();
    try {
      fake.events.emit("event", "Log.entryAdded", {
        entry: {
          source: "network",
          level: "error",
          text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
          url: "http://127.0.0.1/missing.png",
          timestamp: 1710000000000.5,
        },
      });
      expect(received).toEqual([
        {
          level: "error",
          message:
            "Failed to load resource: the server responded with a status of 404 (Not Found) http://127.0.0.1/missing.png",
        },
      ]);
    } finally {
      await instance.dispose();
    }
  });

  it("records uncaught errors and unhandled rejections from Runtime.exceptionThrown", async () => {
    const { fake, instance, received } = await captureLogs();
    try {
      fake.events.emit("event", "Runtime.exceptionThrown", {
        timestamp: 1710000000000.25,
        exceptionDetails: {
          text: "Uncaught",
          exception: { type: "object", description: "Error: boom\n    at http://x/app.js:1:1" },
        },
      });
      fake.events.emit("event", "Runtime.exceptionThrown", {
        timestamp: 1710000000001.25,
        exceptionDetails: {
          text: "Uncaught (in promise)",
          exception: { type: "string", value: "plain reason" },
        },
      });
      expect(received).toEqual([
        { level: "error", message: "Uncaught Error: boom" },
        { level: "error", message: "Uncaught (in promise) plain reason" },
      ]);
    } finally {
      await instance.dispose();
    }
  });

  it("drops a message the tab replays on reselect, but keeps a repeat with its own timestamp", async () => {
    const { fake, instance, received } = await captureLogs();
    try {
      const log = (timestamp: number) =>
        fake.events.emit("consoleAPICalled", {
          type: "log",
          args: [{ type: "string", value: "same" }],
          timestamp,
        });
      log(1710000000000.125);
      log(1710000000000.25);
      log(1710000000000.125);
      expect(received.map((r) => r.message)).toEqual(["same", "same"]);
    } finally {
      await instance.dispose();
    }
  });

  it("keys replays on a short prefix, so long messages sharing it stay apart", async () => {
    const { fake, instance, received } = await captureLogs();
    try {
      const prefix = "x".repeat(20_000);
      const log = (message: string, timestamp: number) =>
        fake.events.emit("consoleAPICalled", {
          type: "log",
          args: [{ type: "string", value: message }],
          timestamp,
        });
      log(`${prefix}a`, 1710000000000.125);
      log(`${prefix}b`, 1710000000000.25);
      log(`${prefix}bc`, 1710000000000.25);
      log(`${prefix}a`, 1710000000000.125);
      expect(received.map((r) => r.message.slice(prefix.length))).toEqual(["a", "b", "bc"]);
    } finally {
      await instance.dispose();
    }
  });

  it("drops replayed Log.entryAdded and Runtime.exceptionThrown messages", async () => {
    const { fake, instance, received } = await captureLogs();
    try {
      const replayBoth = () => {
        fake.events.emit("event", "Log.entryAdded", {
          entry: { level: "error", text: "Failed to load resource", timestamp: 1710000000000.5 },
        });
        fake.events.emit("event", "Runtime.exceptionThrown", {
          timestamp: 1710000000000.75,
          exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom" } },
        });
      };
      replayBoth();
      replayBoth();
      expect(received.map((r) => r.message)).toEqual([
        "Failed to load resource",
        "Uncaught Error: boom",
      ]);
    } finally {
      await instance.dispose();
    }
  });

  it("records every message that has no timestamp", async () => {
    const { fake, instance, received } = await captureLogs();
    try {
      const entry = { entry: { level: "warning", text: "no time" } };
      fake.events.emit("event", "Log.entryAdded", entry);
      fake.events.emit("event", "Log.entryAdded", entry);
      expect(received).toEqual([
        { level: "warning", message: "no time" },
        { level: "warning", message: "no time" },
      ]);
    } finally {
      await instance.dispose();
    }
  });

  it("dispose stops recording browser messages", async () => {
    const { fake, instance, received } = await captureLogs();
    await instance.dispose();
    fake.events.emit("event", "Runtime.exceptionThrown", {
      timestamp: 1710000000000,
      exceptionDetails: { text: "Uncaught" },
    });
    expect(received).toHaveLength(0);
  });
});
