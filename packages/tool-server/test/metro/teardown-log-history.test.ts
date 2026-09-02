/**
 * `stop-all-simulator-servers` reaps every device-owned service, and since the
 * `devices` scope landed that set includes `JsRuntimeDebugger`. Its dispose
 * calls `logWriter.close()`, which unlinks the console-log file — up to 50,000
 * captured entries.
 *
 * The deletion itself is fine: the next resolve builds a new writer over a new
 * path, so nothing could ever read the old file again. What was not fine is
 * that the victim's `debugger-log-registry` transparently reconnected and
 * reported `totalEntries: 0` with no error and no warning — indistinguishable
 * from an app that has logged nothing, which is the opposite conclusion.
 *
 * Drives the real Registry → JsRuntimeDebugger → debugger-log-registry path
 * against a mock Metro, disposing the service exactly as the teardown does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import {
  jsRuntimeDebuggerBlueprint,
  type JsRuntimeDebuggerApi,
} from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { createDebuggerLogRegistryTool } from "../../src/tools/debugger/debugger-log-registry";
import { __resetReapedSessionsForTesting } from "../../src/utils/reaped-sessions";
import { scopeTempHome } from "../helpers/temp-home";

// The JS-runtime-debugger / network blueprints build a real LogFileWriter,
// whose constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-metro-teardown-log-home-");

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;

const LOGICAL_ID = "logical-only-device";

function handleCDPMessage(ws: WebSocket, raw: string) {
  const { id } = JSON.parse(raw) as { id: number; method: string };
  ws.send(JSON.stringify({ id, result: {} }));
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (req.url === "/status") {
        res.setHeader("X-React-Native-Project-Root", "/mock/project");
        res.end("packager-status:running");
        return;
      }
      if (req.url === "/json/list") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify([
            {
              id: "page-0",
              title: "app (Test Device)",
              description: "[C++ connection]",
              webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=${LOGICAL_ID}&page=1`,
              deviceName: "Test Device",
              reactNative: {
                logicalDeviceId: LOGICAL_ID,
                capabilities: { prefersFuseboxFrontend: true },
              },
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });

    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws) => ws.on("message", (raw) => handleCDPMessage(ws, raw.toString())));

    mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });

  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
  registry.registerTool(createDebuggerLogRegistryTool(registry));
});

afterAll(async () => {
  await registry.dispose();
  await new Promise<void>((resolve) => wss.close(() => mockServer.close(() => resolve())));
});

beforeEach(async () => {
  // The registry caches the service, so a session a previous case left
  // connected would be reused — carrying its entry count into the next case.
  await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${LOGICAL_ID}`).catch(() => {});
  __resetReapedSessionsForTesting();
});

async function connectAndCapture(deviceId: string, entries: number): Promise<string> {
  await registry.invokeTool("debugger-connect", { port: mockPort, device_id: deviceId });
  const urn = `JsRuntimeDebugger:${mockPort}:${deviceId}`;
  const api = await registry.resolveService<JsRuntimeDebuggerApi>(urn);
  for (let i = 0; i < entries; i++) {
    api.logWriter.write({
      id: i,
      timestamp: new Date(1710000000000 + i * 1000).toISOString(),
      level: "log",
      message: `captured ${i}`,
    });
  }
  expect(api.logWriter.getStats().totalEntries).toBe(entries);
  return urn;
}

describe("a debugger session reaped by stop-all-simulator-servers", () => {
  it("says the console history was deleted rather than reporting a silent app", async () => {
    const urn = await connectAndCapture(LOGICAL_ID, 60);

    // Exactly what the teardown does to this device's debugger.
    await registry.disposeService(urn);

    // The registry reconnects transparently — a brand new writer over a new
    // file. The count really is 0; the question is whether anything says why.
    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { totalEntries: number; note?: string };

    expect(result.totalEntries).toBe(0);
    expect(result.note).toBeDefined();
    expect(result.note).toContain("60 captured console entries");
    expect(result.note).toContain("stop-all-simulator-servers");
    expect(result.note).toContain("torn down");
  });

  it("stays silent when the previous session had captured nothing", async () => {
    // A teardown that destroyed no history has nothing to explain, and saying
    // otherwise would make every empty registry look like a lost one.
    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: LOGICAL_ID });
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${LOGICAL_ID}`);

    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { totalEntries: number; note?: string };

    expect(result.totalEntries).toBe(0);
    expect(result.note).toBeUndefined();
  });

  it("does not attach the explanation to a registry that has its own entries", async () => {
    const urn = await connectAndCapture(LOGICAL_ID, 5);
    await registry.disposeService(urn);
    // Reconnect and capture fresh history before reading.
    await connectAndCapture(LOGICAL_ID, 3);

    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { totalEntries: number; note?: string };

    expect(result.totalEntries).toBe(3);
    expect(result.note).toBeUndefined();
  });

  it("reports the loss once, not on every later empty read", async () => {
    const urn = await connectAndCapture(LOGICAL_ID, 12);
    await registry.disposeService(urn);

    const first = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { note?: string };
    const second = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { note?: string };

    expect(first.note).toBeDefined();
    expect(second.note).toBeUndefined();
  });

  it("is dropped by an explicit debugger-connect, which starts a capture of its own", async () => {
    // The consumer is gated on an EMPTY registry, so a breadcrumb survives every
    // read that finds entries — and would then attach "a teardown ate your logs"
    // to some later, unrelated empty read. An explicit connect makes it wrong
    // anyway: from there the capture is this session's own, so empty honestly
    // means nothing has been logged since. Same discipline as the
    // screen-recording and native-profiler starts.
    const urn = await connectAndCapture(LOGICAL_ID, 40);
    await registry.disposeService(urn);

    await registry.invokeTool("debugger-connect", { port: mockPort, device_id: LOGICAL_ID });

    const result = (await registry.invokeTool("debugger-log-registry", {
      port: mockPort,
      device_id: LOGICAL_ID,
    })) as { totalEntries: number; note?: string };

    expect(result.totalEntries).toBe(0);
    expect(result.note).toBeUndefined();
  });

  describe("when the connect id and the logicalDeviceId differ", () => {
    // Every case above connects with LOGICAL_ID, so `api.logicalDeviceId ===
    // deviceId` and the disposer's SECOND recordReapedSession never fires —
    // that is the Chromium/Vega shape. On iOS/Android the caller connects with
    // a udid/serial and Metro echoes its own logical id, so one teardown writes
    // two breadcrumbs. They describe one event and must be spent as one.
    const CONNECT_ID = "00000000-0000-0000-0000-0000000000ab";

    beforeEach(async () => {
      await registry.disposeService(`JsRuntimeDebugger:${mockPort}:${CONNECT_ID}`).catch(() => {});
      __resetReapedSessionsForTesting();
    });

    it("explains the loss whichever of the two ids the read uses", async () => {
      const urn = await connectAndCapture(CONNECT_ID, 29);
      const api = await registry.resolveService<JsRuntimeDebuggerApi>(urn);
      // The premise: this really is the two-id shape, so both keys get written.
      expect(api.logicalDeviceId).toBe(LOGICAL_ID);
      expect(api.logicalDeviceId).not.toBe(CONNECT_ID);
      await registry.disposeService(urn);

      const viaConnectId = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: CONNECT_ID,
      })) as { totalEntries: number; note?: string };

      expect(viaConnectId.totalEntries).toBe(0);
      expect(viaConnectId.note).toContain("29 captured console entries");
    });

    it("spends BOTH breadcrumbs on that one read, so no copy outlives the event", async () => {
      // The read consumed one key and left the other, so a later unrelated
      // empty read — a fresh session that genuinely logged nothing — collected
      // the leftover and blamed a teardown that had already been explained.
      const urn = await connectAndCapture(CONNECT_ID, 7);
      await registry.disposeService(urn);

      const first = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: CONNECT_ID,
      })) as { note?: string };
      expect(first.note).toBeDefined();

      // The other spelling of the same device, and the same spelling again:
      // neither may still be holding a copy of that one teardown.
      const viaLogicalId = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: LOGICAL_ID,
      })) as { note?: string };
      const again = (await registry.invokeTool("debugger-log-registry", {
        port: mockPort,
        device_id: CONNECT_ID,
      })) as { note?: string };

      expect(viaLogicalId.note).toBeUndefined();
      expect(again.note).toBeUndefined();
    });

    it("drops BOTH breadcrumbs on an explicit connect, under either spelling", async () => {
      const urn = await connectAndCapture(CONNECT_ID, 11);
      await registry.disposeService(urn);

      await registry.invokeTool("debugger-connect", { port: mockPort, device_id: CONNECT_ID });

      for (const device_id of [CONNECT_ID, LOGICAL_ID]) {
        const result = (await registry.invokeTool("debugger-log-registry", {
          port: mockPort,
          device_id,
        })) as { note?: string };
        expect(result.note).toBeUndefined();
      }
    });
  });
});
