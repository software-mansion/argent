/**
 * The network interceptor lives in the app's JS runtime, so an app restart
 * drops it. Once an agent has watched a device's network, the debugger's next
 * connect (restart-app re-attaches it as the app starts) must install the
 * interceptor before its seconds-long setup, or the relaunched app's first
 * requests go out unseen.
 *
 * Drives the real Registry → JsRuntimeDebugger / NetworkInspector path against
 * a mock Metro and records the CDP messages the debugger sends.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { networkInspectorBlueprint } from "../../src/blueprints/network-inspector";
import { scopeTempHome } from "../helpers/temp-home";

// The debugger builds a real LogFileWriter under os.homedir()/.argent/tmp.
scopeTempHome("argent-network-reconnect-home-");

const WATCHED = "watched-device";
const UNWATCHED = "unwatched-device";

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;
let sent: Array<{ method: string; expression?: string }> = [];

function target(id: string, page: number) {
  return {
    id: `page-${page}`,
    title: `app (${id})`,
    description: "[C++ connection]",
    webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=${id}&page=${page}`,
    deviceName: id,
    reactNative: { logicalDeviceId: id, capabilities: { prefersFuseboxFrontend: true } },
  };
}

function handleCDPMessage(ws: WebSocket, raw: string) {
  const { id, method, params } = JSON.parse(raw) as {
    id: number;
    method: string;
    params?: { expression?: string };
  };
  sent.push({ method, expression: params?.expression });
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
        res.end(JSON.stringify([target(WATCHED, 1), target(UNWATCHED, 2)]));
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });
    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws) => ws.on("message", (raw) => handleCDPMessage(ws, raw.toString())));
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });

  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerBlueprint(networkInspectorBlueprint);
});

afterAll(async () => {
  await registry.dispose();
  await new Promise<void>((resolve) => wss.close(() => mockServer.close(() => resolve())));
});

beforeEach(() => {
  sent = [];
});

const interceptorAt = () =>
  sent.findIndex(
    (m) => m.method === "Runtime.evaluate" && m.expression?.includes("__argent_network_installed")
  );
const setupAt = () => sent.findIndex((m) => m.method === "Runtime.enable");

/** What restart-app does to a debugger session: tear it down, then connect again. */
async function reconnect(deviceId: string): Promise<void> {
  const urn = `JsRuntimeDebugger:${mockPort}:${deviceId}`;
  await registry.disposeService(urn);
  sent = [];
  await registry.resolveService(urn);
}

describe("network capture when the debugger reconnects", () => {
  it("installs the interceptor before the setup for a device whose network was watched", async () => {
    await registry.resolveService(`NetworkInspector:${mockPort}:${WATCHED}`);
    await reconnect(WATCHED);

    expect(interceptorAt()).toBeGreaterThanOrEqual(0);
    expect(interceptorAt()).toBeLessThan(setupAt());
  });

  it("injects nothing for a device nobody watched", async () => {
    await registry.resolveService(`JsRuntimeDebugger:${mockPort}:${UNWATCHED}`);
    await reconnect(UNWATCHED);

    expect(setupAt()).toBeGreaterThanOrEqual(0);
    expect(interceptorAt()).toBe(-1);
  });
});
