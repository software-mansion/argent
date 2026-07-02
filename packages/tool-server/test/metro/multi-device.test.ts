import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";

/**
 * End-to-end regression for the "multiple debuggers all resolve to the same
 * device despite being passed different device_id" bug.
 *
 * Stands up a mock Metro whose /json/list reports TWO distinct devices (each
 * with its own logicalDeviceId + deviceName) on a single port, then drives the
 * real Registry → JsRuntimeDebugger blueprint → debugger-connect path.
 */

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;

const DEVICES = [
  { logicalDeviceId: "logical-aaa", deviceName: "iPhone 16 Pro Max" },
  { logicalDeviceId: "logical-bbb", deviceName: "Pixel 9" },
];

function handleCDPMessage(ws: WebSocket, raw: string) {
  const { id, method } = JSON.parse(raw) as { id: number; method: string };
  switch (method) {
    case "Debugger.enable":
      ws.send(JSON.stringify({ id, result: { debuggerId: "mock" } }));
      ws.send(
        JSON.stringify({
          method: "Debugger.scriptParsed",
          params: {
            scriptId: "1",
            url: "http://localhost/index.bundle?platform=ios&dev=true",
            startLine: 0,
            endLine: 1,
            sourceMapURL: "index.bundle.map",
          },
        })
      );
      break;
    default:
      ws.send(JSON.stringify({ id, result: {} }));
  }
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
          JSON.stringify(
            DEVICES.map((d, i) => ({
              id: `page-${i}`,
              title: `app (${d.deviceName})`,
              description: "[C++ connection]",
              webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=${d.logicalDeviceId}&page=1`,
              deviceName: d.deviceName,
              reactNative: {
                logicalDeviceId: d.logicalDeviceId,
                capabilities: { prefersFuseboxFrontend: true },
              },
            }))
          )
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
});

afterAll(async () => {
  await registry.dispose();
  await new Promise<void>((resolve) => wss.close(() => mockServer.close(() => resolve())));
});

describe("multi-device debugger routing (mock Metro, two devices)", () => {
  it("routes each device_id to its own device", async () => {
    const a = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "logical-aaa",
    })) as Record<string, unknown>;
    const b = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "logical-bbb",
    })) as Record<string, unknown>;

    expect(a.deviceName).toBe("iPhone 16 Pro Max");
    expect(b.deviceName).toBe("Pixel 9");
    // The two connections must NOT collapse onto the same device.
    expect(a.logicalDeviceId).not.toBe(b.logicalDeviceId);
  });

  it("rejects an unmatched device_id instead of silently picking the first device", async () => {
    await expect(
      registry.invokeTool("debugger-connect", { port: mockPort, device_id: "not-a-real-device" })
    ).rejects.toThrow(/No debugger target matches device_id "not-a-real-device"/);
  });
});
