import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { debuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";

/**
 * Integration test using a mock Metro HTTP + CDP WebSocket server.
 * Verifies the full flow: discovery → target selection → CDP connect → tool execution.
 */

let mockServer: http.Server;
let wss: WebSocketServer;
let cdpConn: WebSocket | null = null;
let mockPort: number;
let registry: Registry;

function handleCDPMessage(ws: WebSocket, raw: string) {
  const msg = JSON.parse(raw);
  const { id, method, params } = msg;

  switch (method) {
    case "FuseboxClient.setClientMetadata":
    case "ReactNativeApplication.enable":
    case "Runtime.runIfWaitingForDebugger":
      ws.send(JSON.stringify({ id, result: {} }));
      break;

    case "Runtime.enable":
      ws.send(JSON.stringify({ id, result: {} }));
      break;

    case "Debugger.enable":
      ws.send(JSON.stringify({ id, result: { debuggerId: "mock-debugger" } }));
      ws.send(
        JSON.stringify({
          method: "Debugger.scriptParsed",
          params: {
            scriptId: "1",
            url: "http://localhost/index.bundle?platform=ios&dev=true",
            startLine: 0,
            endLine: 50000,
            sourceMapURL: "index.bundle.map",
          },
        })
      );
      break;

    case "Debugger.setPauseOnExceptions":
    case "Debugger.setAsyncCallStackDepth":
      ws.send(JSON.stringify({ id, result: {} }));
      break;

    case "Runtime.addBinding":
      ws.send(JSON.stringify({ id, result: {} }));
      break;

    case "Runtime.evaluate":
      ws.send(
        JSON.stringify({
          id,
          result: {
            result: { type: "string", value: "eval-result-42" },
          },
        })
      );
      break;

    case "Debugger.setBreakpointByUrl":
      ws.send(
        JSON.stringify({
          id,
          result: {
            breakpointId: `bp:${params.lineNumber}:${params.urlRegex}`,
            locations: [{ scriptId: "1", lineNumber: params.lineNumber, columnNumber: 0 }],
          },
        })
      );
      break;

    case "Debugger.removeBreakpoint":
      ws.send(JSON.stringify({ id, result: {} }));
      break;

    case "Debugger.pause":
      ws.send(JSON.stringify({ id, result: {} }));
      break;

    case "Debugger.resume":
      ws.send(JSON.stringify({ id, result: {} }));
      break;

    case "Debugger.stepOver":
    case "Debugger.stepInto":
    case "Debugger.stepOut":
      ws.send(JSON.stringify({ id, result: {} }));
      break;

    default:
      ws.send(
        JSON.stringify({
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        })
      );
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
          JSON.stringify([
            {
              id: "page-1",
              title: "React Native (mock)",
              description: "[C++ connection]",
              webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=0&page=1`,
              deviceName: "MockDevice",
              reactNative: {
                logicalDeviceId: "MOCK-DEVICE-ID",
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
    wss.on("connection", (ws) => {
      cdpConn = ws;
      ws.on("message", (raw) => handleCDPMessage(ws, raw.toString()));
    });

    mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });

  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
  registry.registerTool(debuggerStatusTool);
  registry.registerTool(debuggerEvaluateTool);
});

afterAll(async () => {
  await registry.dispose();
  cdpConn?.close();
  await new Promise<void>((resolve) => {
    wss.close(() => {
      mockServer.close(() => resolve());
    });
  });
});

describe("JsRuntimeDebugger integration (mock server)", () => {
  it("debugger-connect discovers, connects, and returns info", async () => {
    const result = (await registry.invokeTool("debugger-connect", {
      port: mockPort,
      device_id: "MOCK-DEVICE-ID",
    })) as Record<string, unknown>;

    expect(result.connected).toBe(true);
    expect(result.projectRoot).toBe("/mock/project");
    expect(result.deviceName).toBe("MockDevice");
    expect(result.isNewDebugger).toBe(true);
  });

  it("debugger-status returns connection info and loaded scripts", async () => {
    const result = (await registry.invokeTool("debugger-status", {
      port: mockPort,
      device_id: "MOCK-DEVICE-ID",
    })) as Record<string, unknown>;

    expect(result.connected).toBe(true);
    expect(result.loadedScripts).toBeGreaterThanOrEqual(1);
    expect(result.enabledDomains).toContain("Runtime");
    expect(result.enabledDomains).toContain("Debugger");
  });

  it("debugger-evaluate executes JS and returns result", async () => {
    const result = (await registry.invokeTool("debugger-evaluate", {
      port: mockPort,
      device_id: "MOCK-DEVICE-ID",
      expression: "1 + 1",
    })) as { result: unknown };

    expect(result.result).toBe("eval-result-42");
  });
});
