import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { networkInspectorBlueprint } from "../../src/blueprints/network-inspector";
import { networkLogsTool } from "../../src/tools/network/network-logs";
import { networkRequestTool } from "../../src/tools/network/network-request";

/**
 * Integration test using a mock Metro HTTP + CDP WebSocket server.
 * Verifies the network inspector blueprint depends on JsRuntimeDebugger
 * (sharing the same CDP connection) and that network tools work end-to-end.
 */

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;

/**
 * Track how many WebSocket connections the mock server receives.
 * The key assertion: only ONE CDP connection should be opened even when
 * both JsRuntimeDebugger and NetworkInspector are resolved.
 */
let wsConnectionCount = 0;

/**
 * Simulated network log state stored in the "JS runtime" (mock).
 * When Runtime.evaluate runs the interceptor or log-read scripts,
 * we return responses matching what the real runtime would produce.
 */
let interceptorInstalled = false;
const networkLog: Array<{
  id: number;
  requestId: string;
  state: string;
  request: { url: string; method: string; headers: Record<string, string> };
  response?: {
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    mimeType: string;
  };
  resourceType: string;
  encodedDataLength?: number;
  timestamp: number;
  durationMs?: number;
  responseBody?: string;
}> = [];

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

    case "Runtime.evaluate": {
      const expr = params.expression as string;

      // The interceptor script contains "globalThis.fetch =" (monkey-patching),
      // while the log-read scripts never do.
      if (expr.includes("globalThis.fetch =")) {
        // This is the network interceptor installation script
        interceptorInstalled = true;
        ws.send(
          JSON.stringify({
            id,
            result: {
              result: {
                type: "string",
                value: JSON.stringify({ installed: true }),
              },
            },
          })
        );
      } else if (expr.includes("__argent_network_log") || expr.includes("__argent_network_by_id")) {
        handleLogReadScript(ws, id, expr);
      } else {
        // Generic evaluate
        ws.send(
          JSON.stringify({
            id,
            result: {
              result: { type: "string", value: "eval-result" },
            },
          })
        );
      }
      break;
    }

    default:
      ws.send(
        JSON.stringify({
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        })
      );
  }
}

function handleLogReadScript(ws: WebSocket, id: number, expr: string) {
  if (expr.includes("__argent_network_by_id")) {
    // Detail read script — extract the requestId
    const match = expr.match(/byId\['([^']+)'\]/);
    const requestId = match ? match[1] : null;
    const entry = networkLog.find((e) => e.requestId === requestId);

    if (!interceptorInstalled) {
      ws.send(
        JSON.stringify({
          id,
          result: {
            result: {
              type: "string",
              value: JSON.stringify({
                error: "Network interceptor not installed",
              }),
            },
          },
        })
      );
    } else if (!entry) {
      ws.send(
        JSON.stringify({
          id,
          result: {
            result: {
              type: "string",
              value: JSON.stringify({ error: "Request not found" }),
            },
          },
        })
      );
    } else {
      ws.send(
        JSON.stringify({
          id,
          result: {
            result: {
              type: "string",
              value: JSON.stringify(entry),
            },
          },
        })
      );
    }
    return;
  }

  // List read script — extract start and limit from the script
  const startMatch = expr.match(/var start = (\d+)/);
  const limitMatch = expr.match(/var limit = (\d+)/);
  const start = startMatch ? parseInt(startMatch[1], 10) : 0;
  const limit = limitMatch ? parseInt(limitMatch[1], 10) : 50;

  // Filter out Metro server requests (like the real interceptor does)
  const filtered = networkLog.filter(
    (e) =>
      !e.request.url.includes(`localhost:${mockPort}`) &&
      !e.request.url.includes(`127.0.0.1:${mockPort}`)
  );

  const slice = filtered.slice(start, limit > 0 ? start + limit : start);
  const entries = slice.map((e) => ({
    id: e.id,
    requestId: e.requestId,
    state: e.state,
    request: { url: e.request.url, method: e.request.method },
    response: e.response
      ? {
          status: e.response.status,
          statusText: e.response.statusText,
          mimeType: e.response.mimeType,
        }
      : undefined,
    resourceType: e.resourceType,
    encodedDataLength: e.encodedDataLength,
    timestamp: e.timestamp,
    durationMs: e.durationMs,
  }));

  ws.send(
    JSON.stringify({
      id,
      result: {
        result: {
          type: "string",
          value: JSON.stringify({
            entries,
            total: filtered.length,
            interceptorInstalled,
          }),
        },
      },
    })
  );
}

beforeAll(async () => {
  // Seed mock network log with test data
  networkLog.push(
    {
      id: 0,
      requestId: "rn-net-1",
      state: "finished",
      request: {
        url: "https://api.example.com/users",
        method: "GET",
        headers: { "content-type": "application/json" },
      },
      response: {
        url: "https://api.example.com/users",
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer secret-token",
        },
        mimeType: "application/json",
      },
      resourceType: "Fetch",
      encodedDataLength: 1234,
      timestamp: Date.now() / 1000,
      durationMs: 150,
      responseBody: JSON.stringify([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]),
    },
    {
      id: 1,
      requestId: "rn-net-2",
      state: "failed",
      request: {
        url: "https://api.example.com/broken",
        method: "POST",
        headers: {},
      },
      resourceType: "Fetch",
      timestamp: Date.now() / 1000,
      durationMs: 50,
    }
  );

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
      wsConnectionCount++;
      ws.on("message", (raw) => handleCDPMessage(ws, raw.toString()));
    });

    mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });

  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerBlueprint(networkInspectorBlueprint);
  registry.registerTool(networkLogsTool);
  registry.registerTool(networkRequestTool);
});

afterAll(async () => {
  await registry.dispose();
  await new Promise<void>((resolve) => {
    wss.close(() => {
      mockServer.close(() => resolve());
    });
  });
});

describe("NetworkInspector integration (mock server)", () => {
  it("shares the same CDP connection with JsRuntimeDebugger (only 1 WS connection)", async () => {
    // Reset counter before this test group starts.
    // The beforeAll already sets up the server but doesn't create any services yet.
    wsConnectionCount = 0;

    // Resolve the network inspector, which should trigger JsRuntimeDebugger first
    await registry.resolveService(`NetworkInspector:${mockPort}`);

    // Only ONE WebSocket connection should have been opened
    expect(wsConnectionCount).toBe(1);

    // Verify both services are running
    expect(registry.getServiceState(`JsRuntimeDebugger:${mockPort}`)).toBe("RUNNING");
    expect(registry.getServiceState(`NetworkInspector:${mockPort}`)).toBe("RUNNING");
  });

  it("view-network-logs returns paginated network entries", async () => {
    const result = (await registry.invokeTool("view-network-logs", {
      port: mockPort,
    })) as string;

    expect(result).toContain("NETWORK LOGS");
    expect(result).toContain("rn-net-1");
    expect(result).toContain("GET");
    expect(result).toContain("/users");
    expect(result).toContain("200 OK");
    expect(result).toContain("rn-net-2");
  });

  it("view-network-logs returns 'no traffic' for empty log", async () => {
    // Temporarily clear the log
    const savedLog = networkLog.splice(0);
    try {
      const result = (await registry.invokeTool("view-network-logs", {
        port: mockPort,
      })) as string;

      expect(result).toContain("No network traffic captured");
    } finally {
      // Restore the log
      networkLog.push(...savedLog);
    }
  });

  it("view-network-request-details returns full details for a known requestId", async () => {
    const result = (await registry.invokeTool("view-network-request-details", {
      port: mockPort,
      requestId: "rn-net-1",
    })) as Record<string, unknown>;

    expect(result.requestId).toBe("rn-net-1");
    expect(result.state).toBe("finished");

    const req = result.request as Record<string, unknown>;
    expect(req.url).toBe("https://api.example.com/users");
    expect(req.method).toBe("GET");

    const resp = result.response as Record<string, unknown>;
    expect(resp.status).toBe(200);
    expect(resp.statusText).toBe("OK");

    // Verify sensitive headers are redacted
    const respHeaders = resp.headers as Record<string, string>;
    expect(respHeaders.authorization).toBe("[REDACTED]");
    expect(respHeaders["content-type"]).toBe("application/json");
  });

  it("view-network-request-details returns response body when includeBody is true", async () => {
    const result = (await registry.invokeTool("view-network-request-details", {
      port: mockPort,
      requestId: "rn-net-1",
      includeBody: true,
    })) as Record<string, unknown>;

    const resp = result.response as Record<string, unknown>;
    expect(resp.body).toBeDefined();
    expect(resp.body).toContain("Alice");
    expect(resp.body).toContain("Bob");
  });

  it("view-network-request-details returns error for unknown requestId", async () => {
    const result = (await registry.invokeTool("view-network-request-details", {
      port: mockPort,
      requestId: "rn-net-999",
    })) as string;

    expect(result).toContain("Request not found");
  });

  it("still only 1 WS connection when JsRuntimeDebugger is resolved before NetworkInspector", async () => {
    // Dispose everything first so we can start fresh
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}`).catch(() => {});
    wsConnectionCount = 0;

    // Explicitly resolve JsRuntimeDebugger first
    await registry.resolveService(`JsRuntimeDebugger:${mockPort}`);
    expect(wsConnectionCount).toBe(1);

    // Now resolve NetworkInspector — should NOT open a second connection
    await registry.resolveService(`NetworkInspector:${mockPort}`);
    expect(wsConnectionCount).toBe(1);
  });

  it("view-network-logs filters out requests to the Metro server port", async () => {
    // Add a request that targets the Metro server itself
    const metroEntry = {
      id: networkLog.length,
      requestId: "rn-net-metro",
      state: "finished" as const,
      request: {
        url: `http://localhost:${mockPort}/symbolicate`,
        method: "POST",
        headers: {},
      },
      response: {
        url: `http://localhost:${mockPort}/symbolicate`,
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "application/json",
      },
      resourceType: "Fetch",
      encodedDataLength: 100,
      timestamp: Date.now() / 1000,
      durationMs: 10,
    };
    networkLog.push(metroEntry);

    try {
      const result = (await registry.invokeTool("view-network-logs", {
        port: mockPort,
      })) as string;

      // The Metro request should be filtered out
      expect(result).not.toContain("rn-net-metro");
      expect(result).not.toContain("/symbolicate");
      // But non-Metro requests should still be present
      expect(result).toContain("rn-net-1");
    } finally {
      // Remove the test entry
      const idx = networkLog.findIndex((e) => e.requestId === "rn-net-metro");
      if (idx >= 0) networkLog.splice(idx, 1);
    }
  });

  it("view-network-logs returns page index out-of-range error", async () => {
    const result = (await registry.invokeTool("view-network-logs", {
      port: mockPort,
      pageIndex: 999,
    })) as string;

    expect(result).toContain("Page index out of range");
  });

  it("view-network-request-details omits body when includeBody is false", async () => {
    const result = (await registry.invokeTool("view-network-request-details", {
      port: mockPort,
      requestId: "rn-net-1",
      includeBody: false,
    })) as Record<string, unknown>;

    const resp = result.response as Record<string, unknown>;
    expect(resp).toBeDefined();
    expect(resp.status).toBe(200);
    // Body should NOT be included
    expect(resp.body).toBeUndefined();
  });

  it("view-network-request-details truncates large response bodies", async () => {
    // Add a request with a very large body (> 1000 chars)
    const largeBody = "x".repeat(2000);
    const largeEntry = {
      id: networkLog.length,
      requestId: "rn-net-large",
      state: "finished" as const,
      request: {
        url: "https://api.example.com/large",
        method: "GET",
        headers: {},
      },
      response: {
        url: "https://api.example.com/large",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
      resourceType: "Fetch",
      encodedDataLength: 2000,
      timestamp: Date.now() / 1000,
      durationMs: 100,
      responseBody: largeBody,
    };
    networkLog.push(largeEntry);

    try {
      const result = (await registry.invokeTool("view-network-request-details", {
        port: mockPort,
        requestId: "rn-net-large",
        includeBody: true,
      })) as Record<string, unknown>;

      const resp = result.response as Record<string, unknown>;
      expect(resp.body).toBeDefined();
      const body = resp.body as string;
      expect(body).toContain("TRUNCATED");
      expect(body).toContain("2000 chars");
      // Body should be shorter than original
      expect(body.length).toBeLessThan(2000);
    } finally {
      const idx = networkLog.findIndex((e) => e.requestId === "rn-net-large");
      if (idx >= 0) networkLog.splice(idx, 1);
    }
  });

  it("NetworkInspector cascades teardown when JsRuntimeDebugger is disposed", async () => {
    // Dispose JsRuntimeDebugger — NetworkInspector should also be torn down
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}`);

    expect(registry.getServiceState(`JsRuntimeDebugger:${mockPort}`)).toBe("IDLE");
    expect(registry.getServiceState(`NetworkInspector:${mockPort}`)).toBe("IDLE");
  });
});
