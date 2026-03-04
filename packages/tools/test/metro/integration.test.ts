import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@radon-lite/registry";
import { metroDebuggerBlueprint } from "../../src/blueprints/metro-debugger";
import { metroConnectTool } from "../../src/tools/metro-connect";
import { metroStatusTool } from "../../src/tools/metro-status";
import { metroEvaluateTool } from "../../src/tools/metro-evaluate";
import { metroSetBreakpointTool } from "../../src/tools/metro-set-breakpoint";
import { metroRemoveBreakpointTool } from "../../src/tools/metro-remove-breakpoint";
import { metroPauseTool } from "../../src/tools/metro-pause";
import { metroResumeTool } from "../../src/tools/metro-resume";
import { metroStepTool } from "../../src/tools/metro-step";

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
            locations: [
              { scriptId: "1", lineNumber: params.lineNumber, columnNumber: 0 },
            ],
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
  registry.registerBlueprint(metroDebuggerBlueprint);
  registry.registerTool(metroConnectTool);
  registry.registerTool(metroStatusTool);
  registry.registerTool(metroEvaluateTool);
  registry.registerTool(metroSetBreakpointTool);
  registry.registerTool(metroRemoveBreakpointTool);
  registry.registerTool(metroPauseTool);
  registry.registerTool(metroResumeTool);
  registry.registerTool(metroStepTool);
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

describe("MetroDebugger integration (mock server)", () => {
  it("metro-connect discovers, connects, and returns info", async () => {
    const result = (await registry.invokeTool("metro-connect", {
      port: mockPort,
    })) as Record<string, unknown>;

    expect(result.connected).toBe(true);
    expect(result.projectRoot).toBe("/mock/project");
    expect(result.deviceName).toBe("MockDevice");
    expect(result.isNewDebugger).toBe(true);
  });

  it("metro-status returns connection info and loaded scripts", async () => {
    const result = (await registry.invokeTool("metro-status", {
      port: mockPort,
    })) as Record<string, unknown>;

    expect(result.connected).toBe(true);
    expect(result.loadedScripts).toBeGreaterThanOrEqual(1);
    expect(result.enabledDomains).toContain("Runtime");
    expect(result.enabledDomains).toContain("Debugger");
  });

  it("metro-evaluate executes JS and returns result", async () => {
    const result = (await registry.invokeTool("metro-evaluate", {
      port: mockPort,
      expression: "1 + 1",
    })) as { result: unknown };

    expect(result.result).toBe("eval-result-42");
  });

  it("metro-set-breakpoint sets a breakpoint by URL regex", async () => {
    const result = (await registry.invokeTool("metro-set-breakpoint", {
      port: mockPort,
      file: "App.tsx",
      line: 21,
    })) as { breakpointId: string; locations: unknown[] };

    expect(result.breakpointId).toContain("20");
    expect(result.breakpointId).toContain("App\\.tsx");
    expect(result.locations).toHaveLength(1);
  });

  it("metro-remove-breakpoint removes a breakpoint", async () => {
    const result = (await registry.invokeTool("metro-remove-breakpoint", {
      port: mockPort,
      breakpointId: "bp:20:.*App\\.tsx$",
    })) as { removed: boolean };

    expect(result.removed).toBe(true);
  });

  it("metro-pause sends Debugger.pause", async () => {
    const result = (await registry.invokeTool("metro-pause", {
      port: mockPort,
    })) as { paused: boolean };

    expect(result.paused).toBe(true);
  });

  it("metro-resume sends Debugger.resume", async () => {
    const result = (await registry.invokeTool("metro-resume", {
      port: mockPort,
    })) as { resumed: boolean };

    expect(result.resumed).toBe(true);
  });

  it("metro-step sends step command", async () => {
    const result = (await registry.invokeTool("metro-step", {
      port: mockPort,
      action: "stepOver",
    })) as { action: string; sent: boolean };

    expect(result.action).toBe("stepOver");
    expect(result.sent).toBe(true);
  });
});
