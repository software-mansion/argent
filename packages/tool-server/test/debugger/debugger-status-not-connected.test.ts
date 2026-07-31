import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  Registry,
  ServiceState,
  TypedEventEmitter,
  getFailureSignal,
  FAILURE_CODES,
  type ServiceBlueprint,
  type ServiceEvents,
} from "@argent/registry";

// Capture telemetry without touching PostHog: keep every real export and spy
// only `track` (same pattern as preview-opened-telemetry.test.ts).
vi.mock("@argent/telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/telemetry")>();
  return { ...actual, track: vi.fn() };
});

import { track } from "@argent/telemetry";
import {
  jsRuntimeDebuggerBlueprint,
  JS_RUNTIME_DEBUGGER_NAMESPACE,
  type JsRuntimeDebuggerApi,
} from "../../src/blueprints/js-runtime-debugger";
import { chromiumCdpBlueprint } from "../../src/blueprints/chromium-cdp";
import {
  chromiumJsRuntimeDebuggerBlueprint,
  chromiumJsRuntimeDebuggerRef,
} from "../../src/blueprints/chromium-js-runtime-debugger";
import { resolveDevice } from "../../src/utils/device-info";
import { createDebuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import type { DebuggerNotConnectedResult } from "../../src/tools/debugger/not-connected";
import { freePort, startMockMetroCdp } from "./metro-cdp-harness";

const mockTrack = vi.mocked(track);
const outcomeCalls = () =>
  mockTrack.mock.calls.filter(([event]) => event === "debugger:tool_outcome");

const INVOCATION_ID = "11111111-2222-4333-8444-555555555555";

// ── Harnesses ────────────────────────────────────────────────────────────────
// freePort / startMockMetroCdp live in ./metro-cdp-harness (shared with the
// log-registry and recovery-reachability suites).

interface MockMetro {
  port: number;
  close: () => Promise<void>;
}

/** Metro that answers packager-status:running but exposes no CDP targets. */
async function startEmptyMetro(): Promise<MockMetro> {
  const server = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.end("packager-status:running");
      return;
    }
    if (req.url === "/json/list") {
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Fake Chromium CDP endpoint: /json/version + /json/list + a page WS target. */
async function startFakeChromiumCdp(): Promise<MockMetro> {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/json/version") {
      res.end(JSON.stringify({ "Browser": "Chrome/Test", "Protocol-Version": "1.3" }));
      return;
    }
    if (req.url === "/json/list") {
      const port = (server.address() as AddressInfo).port;
      res.end(
        JSON.stringify([
          {
            id: "page1",
            type: "page",
            title: "T",
            url: "about:blank",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page1`,
          },
        ])
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      let result: unknown;
      switch (msg.method) {
        case "Runtime.evaluate":
          // The ChromiumServer viewport probe expects a JSON string back.
          result = {
            result: { type: "string", value: JSON.stringify({ w: 800, h: 600, dpr: 1 }) },
          };
          break;
        case "DOM.getDocument":
          result = { root: { nodeId: 1, backendNodeId: 100 } };
          break;
        default:
          result = {};
      }
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.close();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

// ── Per-test wiring ──────────────────────────────────────────────────────────

interface Setup {
  registry: Registry;
  completed: string[];
  failed: string[];
  invoke: (params: Record<string, unknown>) => Promise<unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSetup(...blueprints: ServiceBlueprint<any, any>[]): Setup {
  const registry = new Registry();
  for (const bp of blueprints) registry.registerBlueprint(bp);
  registry.registerTool(createDebuggerStatusTool(registry));
  const completed: string[] = [];
  const failed: string[] = [];
  registry.events.on("toolCompleted", (id) => completed.push(id));
  registry.events.on("toolFailed", (id) => failed.push(id));
  return {
    registry,
    completed,
    failed,
    invoke: (params) =>
      registry.invokeTool("debugger-status", params, { toolInvocationId: INVOCATION_ID }),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  mockTrack.mockClear();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("debugger-status not-connected results", () => {
  it("(a) nothing listening → not_connected/metro_not_running as a SUCCESS, with tool_outcome", async () => {
    const port = await freePort();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(() => setup.registry.dispose());

    const result = (await setup.invoke({
      port,
      device_id: "mock-device",
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.connected).toBe(false);
    expect(result.reason).toBe("metro_not_running");
    expect(result.port).toBe(port);
    expect(result.detail).toContain("is not running");
    expect(result.guidance).toContain("Do not retry in a loop");

    // Precondition, not malfunction: completes, never fails.
    expect(setup.completed).toEqual(["debugger-status"]);
    expect(setup.failed).toEqual([]);

    // Exactly one debugger:tool_outcome, joining tool:invoke via the id.
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({
      tool: "debugger-status",
      outcome: "metro_not_running",
      tool_invocation_id: INVOCATION_ID,
    });
  });

  it("(b) Metro running with no targets → not_connected/no_app_connected", async () => {
    const metro = await startEmptyMetro();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    const result = (await setup.invoke({
      port: metro.port,
      device_id: "mock-device",
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.reason).toBe("no_app_connected");
    expect(result.guidance).toContain("launch-app / restart-app");
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({ outcome: "no_app_connected" });
  });

  it("(c) happy path → status:connected with the legacy field superset and a connected outcome", async () => {
    const metro = await startMockMetroCdp();
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    const result = (await setup.invoke({
      port: metro.port,
      device_id: "mock-device",
    })) as Record<string, unknown>;

    expect(result.status).toBe("connected");
    expect(result.connected).toBe(true);
    expect(result.port).toBe(metro.port);
    expect(result.projectRoot).toBe("/mock/project");
    expect(result.deviceName).toBe("MockDevice");
    expect(result.appName).toBe("React Native (mock)");
    expect(result.isNewDebugger).toBe(true);
    expect(result.loadedScripts).toBeGreaterThanOrEqual(1);
    expect(result.enabledDomains).toContain("Runtime");
    expect(result.sourceMapReady).toBe(true);

    expect(setup.completed).toEqual(["debugger-status"]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({
      tool: "debugger-status",
      outcome: "connected",
      tool_invocation_id: INVOCATION_ID,
    });
  });

  it("(d) unexpected errors fall through and REJECT — plain factory Error", async () => {
    // Guard against over-mapping: a genuine fault must keep failing loudly.
    const events = new TypedEventEmitter<ServiceEvents>();
    void events;
    const brokenBlueprint: ServiceBlueprint<JsRuntimeDebuggerApi, string> = {
      namespace: JS_RUNTIME_DEBUGGER_NAMESPACE,
      getURN: (payload) => `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`,
      factory: async () => {
        throw new Error("boom: something unrelated to connectivity");
      },
    };
    const setup = makeSetup(brokenBlueprint);
    cleanups.push(() => setup.registry.dispose());

    await expect(setup.invoke({ port: 8081, device_id: "mock-device" })).rejects.toThrow(
      /boom: something unrelated to connectivity/
    );
    expect(setup.failed).toEqual(["debugger-status"]);
    expect(setup.completed).toEqual([]);
    // No outcome event on the rethrow path.
    expect(outcomeCalls()).toHaveLength(0);
  });

  it("(d) unexpected errors fall through and REJECT — JS_RUNTIME_PAYLOAD_* keeps its code", async () => {
    const setup = makeSetup(jsRuntimeDebuggerBlueprint);
    cleanups.push(() => setup.registry.dispose());

    // Empty device_id passes zod but produces an invalid service payload —
    // a caller bug, not a connectivity precondition. Must reject, not map.
    let thrown: unknown;
    try {
      await setup.invoke({ port: 8081, device_id: "" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(getFailureSignal(thrown)?.error_code).toBe(
      FAILURE_CODES.JS_RUNTIME_PAYLOAD_DEVICE_MISSING
    );
    expect(setup.failed).toEqual(["debugger-status"]);
    expect(outcomeCalls()).toHaveLength(0);
  });

  it("(e) socket-state gate (Metro): stale_connection disposes the node and the next call reconnects", async () => {
    const metro = await startMockMetroCdp();
    const factorySpy = vi.fn(jsRuntimeDebuggerBlueprint.factory);
    const spiedBlueprint: typeof jsRuntimeDebuggerBlueprint = {
      ...jsRuntimeDebuggerBlueprint,
      factory: factorySpy,
    };
    const setup = makeSetup(spiedBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await metro.close();
    });

    // Happy connect first.
    const first = (await setup.invoke({ port: metro.port, device_id: "mock-device" })) as Record<
      string,
      unknown
    >;
    expect(first.status).toBe("connected");
    expect(factorySpy).toHaveBeenCalledTimes(1);

    // Force the gate: the cached client reports its socket is no longer OPEN
    // while the node is still RUNNING (no terminated cascade fires).
    const urn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${metro.port}:mock-device`;
    const api = await setup.registry.resolveService<JsRuntimeDebuggerApi>(urn);
    vi.spyOn(api.cdp, "isConnected").mockReturnValue(false);

    const stale = (await setup.invoke({
      port: metro.port,
      device_id: "mock-device",
    })) as DebuggerNotConnectedResult;
    expect(stale.status).toBe("not_connected");
    expect(stale.reason).toBe("stale_connection");
    expect(stale.port).toBe(metro.port);
    expect(stale.guidance).toContain("restart-app");
    expect(setup.failed).toEqual([]);

    // The dispose side effect is real: the next call re-runs the factory and
    // comes back connected on a fresh socket.
    const second = (await setup.invoke({ port: metro.port, device_id: "mock-device" })) as Record<
      string,
      unknown
    >;
    expect(second.status).toBe("connected");
    expect(factorySpy).toHaveBeenCalledTimes(2);

    const outcomes = outcomeCalls().map(([, props]) => (props as { outcome: string }).outcome);
    expect(outcomes).toEqual(["connected", "stale_connection", "connected"]);
  });

  it("(f) chromium unreachable → not_connected/cdp_unreachable with NO port field", async () => {
    const deadPort = await freePort();
    const setup = makeSetup(chromiumCdpBlueprint, chromiumJsRuntimeDebuggerBlueprint);
    cleanups.push(() => setup.registry.dispose());

    const result = (await setup.invoke({
      port: 8081,
      device_id: `chromium-cdp-${deadPort}`,
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.reason).toBe("cdp_unreachable");
    // Claiming port 8081 on a chromium id would misdirect agents — the CDP
    // port lives inside the device id and the Metro `port` param is ignored.
    expect("port" in result).toBe(false);
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({ outcome: "cdp_unreachable" });
  });

  it("(g) chromium happy path → status:connected (proves ref.options is passed through)", async () => {
    const fake = await startFakeChromiumCdp();
    const setup = makeSetup(chromiumCdpBlueprint, chromiumJsRuntimeDebuggerBlueprint);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await fake.close();
    });

    // An implementation that drops ref.options fails here: the wrapper factory
    // hard-requires options.device once its ChromiumCdp dependency resolves.
    const result = (await setup.invoke({
      port: 8081,
      device_id: `chromium-cdp-${fake.port}`,
    })) as Record<string, unknown>;

    expect(result.status).toBe("connected");
    expect(result.connected).toBe(true);
    expect(result.port).toBe(fake.port);
    expect(result.isNewDebugger).toBe(true);
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({ outcome: "connected" });
  });

  it("(i) chromium socket-state gate: reconnecting, NO dispose, no restart-app guidance", async () => {
    const fake = await startFakeChromiumCdp();
    const wrapperFactorySpy = vi.fn(chromiumJsRuntimeDebuggerBlueprint.factory);
    const spiedWrapper: typeof chromiumJsRuntimeDebuggerBlueprint = {
      ...chromiumJsRuntimeDebuggerBlueprint,
      factory: wrapperFactorySpy,
    };
    const setup = makeSetup(chromiumCdpBlueprint, spiedWrapper);
    cleanups.push(async () => {
      await setup.registry.dispose();
      await fake.close();
    });

    const deviceId = `chromium-cdp-${fake.port}`;
    const first = (await setup.invoke({ port: 8081, device_id: deviceId })) as Record<
      string,
      unknown
    >;
    expect(first.status).toBe("connected");
    expect(wrapperFactorySpy).toHaveBeenCalledTimes(1);

    // Force isConnected() === false while BOTH nodes stay RUNNING — the
    // tab-switch reconnect window.
    const ref = chromiumJsRuntimeDebuggerRef(resolveDevice(deviceId));
    const api = await setup.registry.resolveService<JsRuntimeDebuggerApi>(ref.urn, ref.options);
    vi.spyOn(api.cdp, "isConnected").mockReturnValue(false);

    const result = (await setup.invoke({
      port: 8081,
      device_id: deviceId,
    })) as DebuggerNotConnectedResult;
    expect(result.status).toBe("not_connected");
    expect(result.reason).toBe("reconnecting");
    expect("port" in result).toBe(false);
    expect(result.guidance).not.toMatch(/restart-app/);
    expect(result.guidance).toMatch(/retry/i);

    // No dispose happened: both nodes are still RUNNING and a subsequent
    // resolve reuses the cached instance (factory count unchanged).
    expect(setup.registry.getServiceState(ref.urn)).toBe(ServiceState.RUNNING);
    expect(setup.registry.getServiceState(`ChromiumCdp:${deviceId}`)).toBe(ServiceState.RUNNING);
    await setup.registry.resolveService(ref.urn, ref.options);
    expect(wrapperFactorySpy).toHaveBeenCalledTimes(1);

    expect(outcomeCalls().map(([, p]) => (p as { outcome: string }).outcome)).toEqual([
      "connected",
      "reconnecting",
    ]);
  });

  it("(h) terminating window: a resolve racing an in-flight teardown maps to reconnecting", async () => {
    // Fake JsRuntimeDebugger whose dispose blocks until released, holding the
    // node in TERMINATING while the status call lands.
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    const slowDisposeBlueprint: ServiceBlueprint<Record<string, never>, string> = {
      namespace: JS_RUNTIME_DEBUGGER_NAMESPACE,
      getURN: (payload) => `${JS_RUNTIME_DEBUGGER_NAMESPACE}:${payload}`,
      factory: async () => ({
        api: {},
        dispose: () => disposeGate,
        events: new TypedEventEmitter<ServiceEvents>(),
      }),
    };
    const setup = makeSetup(slowDisposeBlueprint);

    const urn = `${JS_RUNTIME_DEBUGGER_NAMESPACE}:8081:dev1`;
    await setup.registry.resolveService(urn);
    const disposing = setup.registry.disposeService(urn); // held open by the gate
    cleanups.push(async () => {
      releaseDispose();
      await disposing;
      await setup.registry.dispose();
    });

    const result = (await setup.invoke({
      port: 8081,
      device_id: "dev1",
    })) as DebuggerNotConnectedResult;

    expect(result.status).toBe("not_connected");
    expect(result.reason).toBe("reconnecting");
    expect(result.detail).toContain("terminating");
    expect(result.guidance).toContain("retry once");
    expect(setup.failed).toEqual([]);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0][1]).toMatchObject({
      tool: "debugger-status",
      outcome: "reconnecting",
      tool_invocation_id: INVOCATION_ID,
    });
  });
});
