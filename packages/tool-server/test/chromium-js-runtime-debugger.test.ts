import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { debuggerReapedScope } from "../src/tools/debugger/debugger-service-ref";
import { scopeTempHome } from "./helpers/temp-home";

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

const logDir = () => path.join(os.homedir(), ".argent", "tmp");

const DEVICE_ID = "chromium-cdp-19222";

/**
 * Read a breadcrumb the way `debugger-log-registry` and `debugger-connect` do —
 * through the scope those tools compute. The blueprint files this one unscoped
 * because a Chromium device carries its port inside its id; a reader that
 * scoped it by `port` would find nothing, and the kept log file would be named
 * by nobody.
 */
function takeChromiumReaped() {
  return takeReapedSession(
    "js-runtime-debugger",
    DEVICE_ID,
    debuggerReapedScope({ port: 8081, device_id: DEVICE_ID })
  );
}

/** How many listeners the shared client is still carrying for `event`. */
function listenerCount(events: TypedEventEmitter<CDPClientEvents>, event: string): number {
  const registered = (events as unknown as { listeners: Map<string, Set<unknown>> }).listeners.get(
    event
  );
  return registered?.size ?? 0;
}

// One of the factory's hard-failure paths — the console-log server's bind,
// reached through `http.createServer`; the writer's constructor is the other.
// Every other case in this file needs a working one, so the flag is off by
// default.
const httpControl = vi.hoisted(() => ({ failCreateServer: false }));
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    default: actual,
    createServer: (...args: unknown[]) => {
      if (httpControl.failCreateServer) throw new Error("no sockets left");
      return (actual.createServer as (...a: unknown[]) => unknown)(...args);
    },
  };
});

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
    expect(listenerCount(fake.events, "consoleAPICalled")).toBe(1);
    await instance.dispose();
    // On the listener itself, not only on what it delivers: this client belongs
    // to ChromiumCdp and outlives the dispose, so a listener left on it writes
    // to a closed writer for the rest of the browser's life — and `write`
    // throwing is why nothing arrives below either way.
    expect(listenerCount(fake.events, "consoleAPICalled")).toBe(0);
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
    const logPath = instance.api.logWriter.getFilePath();
    expect(fs.existsSync(logPath)).toBe(true);
    await instance.dispose();

    expect(fs.existsSync(logPath)).toBe(false);

    const reaped = takeChromiumReaped();
    expect(reaped).toBeDefined();
    expect(reaped!.salvage).toContain("18 captured console entries");
    // A live socket at dispose is a teardown, and a teardown deletes the file.
    // Both readings are what `describeReapedSession` turns into "another agent
    // may have done this" rather than "your app died", and into a deletion
    // rather than a path.
    expect(reaped!.cause).toBe("teardown");
    expect(reaped!.keptAt).toBeUndefined();
    expect(reaped!.salvage).toContain("no log file was left behind");
  });

  it("keeps the log file and names it in the breadcrumb when the renderer died", async () => {
    // The V8 half of the Hermes crash case: a `disconnected` means the renderer
    // is gone, so dispose keeps the captured log instead of unlinking it — and
    // the breadcrumb must then point at that file rather than report a
    // deletion, which is what the caller reads after the registry restarts
    // empty.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    let socketOpen = true;
    (fake.api.cdp as unknown as { isConnected: () => boolean }).isConnected = () => socketOpen;
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    instance.api.logWriter.write({
      id: 1,
      timestamp: new Date(1710000000000).toISOString(),
      level: "error",
      message: "CRITICAL pre-crash error",
    });
    const logPath = instance.api.logWriter.getFilePath();

    // `CDPClient` nulls its socket in `cleanup()` before it emits, so a
    // `disconnected` with a still-OPEN socket is a state production cannot
    // reach.
    socketOpen = false;
    fake.events.emit("disconnected", new Error("renderer gone"));
    await instance.dispose();

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");

    const reaped = takeChromiumReaped();
    expect(reaped?.salvage).toContain(logPath);
    expect(reaped?.salvage).not.toContain("no log file was left behind");
    // Blaming a stop-all for a renderer that died sends the reader hunting for
    // a tool call that never happened.
    expect(reaped?.cause).toBe("runtime-death");
    expect(reaped?.keptAt).toBe(logPath);

    fs.rmSync(logPath, { force: true });
  });

  it("names no file when the renderer dies and the writer never got one", async () => {
    // `keptAt` is a conjunction with `hasFile()`: `open()` swallows its failure
    // and buffers, so a death in an unwritable ~/.argent/tmp has entries to
    // report and no file to point at. Without that half the breadcrumb names a
    // path that never existed, and — since it is gone by the time anyone reads
    // it — blames the pruner for the loss.
    __resetReapedSessionsForTesting();
    const logs = logDir();
    fs.mkdirSync(logs, { recursive: true });
    fs.chmodSync(logs, 0o555);
    try {
      const fake = makeFakeChromiumCdpApi();
      let socketOpen = true;
      (fake.api.cdp as unknown as { isConnected: () => boolean }).isConnected = () => socketOpen;
      const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
        { chromium: fake.api },
        "chromium-cdp-19222",
        { device: chromiumDevice }
      );
      instance.api.logWriter.write({
        id: 1,
        timestamp: new Date(1710000000000).toISOString(),
        level: "error",
        message: "buffered only",
      });
      expect(instance.api.logWriter.hasFile()).toBe(false);

      socketOpen = false;
      await instance.dispose();

      const reaped = takeChromiumReaped();
      expect(reaped?.cause).toBe("runtime-death");
      expect(reaped?.keptAt).toBeUndefined();
      expect(reaped?.salvage).toContain("no log file was left behind");
    } finally {
      fs.chmodSync(logs, 0o755);
    }
  });

  it("reads the socket before the dispose awaits anything", async () => {
    // A teardown's socket can close while dispose is mid-await — the console
    // server's close yields to I/O — and a read placed after that await would
    // call this teardown a death and keep a file nothing reclaims for a day.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    let socketOpen = true;
    (fake.api.cdp as unknown as { isConnected: () => boolean }).isConnected = () => socketOpen;
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    instance.api.logWriter.write({
      id: 1,
      timestamp: new Date(1710000000000).toISOString(),
      level: "log",
      message: "captured before the teardown",
    });
    const logPath = instance.api.logWriter.getFilePath();

    // Queued before dispose runs, so it lands the moment dispose first gives up
    // the stack — which is its first await, and nothing else.
    process.nextTick(() => {
      socketOpen = false;
    });
    await instance.dispose();

    expect(fs.existsSync(logPath)).toBe(false);
    const reaped = takeChromiumReaped();
    expect(reaped?.cause).toBe("teardown");
  });

  it("keeps the log when the renderer's death cascades a teardown in before our listener runs", async () => {
    // What the direct-dispose case above does not model, and what production
    // actually does: `CDPClient` nulls its socket and then emits `disconnected`;
    // `ChromiumCdp` — registered on that event first, because its service is
    // built first — synchronously cascades a teardown into this service, and
    // this dispose unregisters its own handler while the emit is still walking
    // the listener set. `TypedEventEmitter` iterates the live set, so the
    // handler is skipped and never runs. Reading only the event therefore reads
    // false on exactly the path the keep-the-log rule exists for — closing the
    // connected tab of a real headless Chrome is how that costs the pre-crash
    // log — so the socket has to be the answer.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    let socketOpen = true;
    (fake.api.cdp as unknown as { isConnected: () => boolean }).isConnected = () => socketOpen;

    // Registered BEFORE the factory, as `ChromiumCdp`'s is in production —
    // that ordering is what makes this cascade land mid-emit, ahead of the
    // blueprint's own handler.
    const created: {
      instance?: Awaited<ReturnType<typeof chromiumJsRuntimeDebuggerBlueprint.factory>>;
    } = {};
    fake.events.on("disconnected", () => {
      void created.instance!.dispose();
    });

    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    created.instance = instance;
    instance.api.logWriter.write({
      id: 1,
      timestamp: new Date(1710000000000).toISOString(),
      level: "error",
      message: "CRITICAL pre-crash error",
    });
    const logPath = instance.api.logWriter.getFilePath();

    socketOpen = false;
    fake.events.emit("disconnected", new Error("renderer gone"));
    await new Promise((r) => setImmediate(r));

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.readFileSync(logPath, "utf-8")).toContain("CRITICAL pre-crash error");
    const reaped = takeChromiumReaped();
    expect(reaped?.cause).toBe("runtime-death");
    expect(reaped?.salvage).toContain(logPath);

    fs.rmSync(logPath, { force: true });
  });

  it("closes the log writer when the factory throws before a dispose exists", async () => {
    // The console-log server bind is a documented hard-failure path, and it runs
    // after the writer is open. Nothing else can close that writer — the factory
    // never returns a dispose — so its fd, its file and its keepalive would
    // outlive the failure, and the keepalive holds that file out of the sweep
    // for as long as it runs.
    fs.mkdirSync(logDir(), { recursive: true });
    const before = new Set(fs.readdirSync(logDir()));
    const fake = makeFakeChromiumCdpApi();
    httpControl.failCreateServer = true;
    try {
      await expect(
        chromiumJsRuntimeDebuggerBlueprint.factory({ chromium: fake.api }, "chromium-cdp-19222", {
          device: chromiumDevice,
        })
      ).rejects.toThrow(/no sockets left/);
    } finally {
      httpControl.failCreateServer = false;
    }
    const leaked = fs.readdirSync(logDir()).filter((n) => !before.has(n));
    expect(leaked).toEqual([]);
    // The listeners are the other half: this client belongs to ChromiumCdp and
    // outlives the failure, so a leaked `consoleAPICalled` handler would go on
    // writing into the writer just closed above.
    expect(listenerCount(fake.events, "consoleAPICalled")).toBe(0);
    expect(listenerCount(fake.events, "disconnected")).toBe(0);
  });

  it("leaves no listener on the shared client when the writer cannot be built", async () => {
    // `LogFileWriter`'s constructor mkdir -p's ~/.argent/tmp, which an
    // unwritable home makes throw. This client belongs to `ChromiumCdp` and
    // outlives the failed factory, so a listener attached before that throw
    // would emit into a service that never existed, for the life of the
    // process.
    const argentDir = path.join(os.homedir(), ".argent");
    fs.mkdirSync(argentDir, { recursive: true });
    fs.chmodSync(argentDir, 0o555);
    const fake = makeFakeChromiumCdpApi();
    try {
      await expect(
        chromiumJsRuntimeDebuggerBlueprint.factory({ chromium: fake.api }, "chromium-cdp-19222", {
          device: chromiumDevice,
        })
      ).rejects.toThrow(/EACCES|permission denied/i);
    } finally {
      fs.chmodSync(argentDir, 0o755);
    }

    expect(listenerCount(fake.events, "disconnected")).toBe(0);
    expect(listenerCount(fake.events, "consoleAPICalled")).toBe(0);
  });

  it("keeps nothing when the renderer dies without having logged", async () => {
    // `keepFile` is gated on the same `captured` the breadcrumb is: a death that
    // captured nothing leaves an empty file that no breadcrumb names and that
    // the pruner only reclaims a day later — one per disconnect.
    __resetReapedSessionsForTesting();
    const fake = makeFakeChromiumCdpApi();
    const instance = await chromiumJsRuntimeDebuggerBlueprint.factory(
      { chromium: fake.api },
      "chromium-cdp-19222",
      { device: chromiumDevice }
    );
    const logPath = instance.api.logWriter.getFilePath();

    // `CDPClient` nulls its socket before emitting, so a death is a closed
    // socket. Without that the `runtimeDied` conjunct decides this on its own
    // and the `captured` one is never consulted.
    (fake.api.cdp as unknown as { isConnected: () => boolean }).isConnected = () => false;
    fake.events.emit("disconnected", new Error("renderer gone"));
    await instance.dispose();

    expect(fs.existsSync(logPath)).toBe(false);
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
    expect(takeChromiumReaped()).toBeUndefined();
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
