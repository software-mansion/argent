import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import {
  jsRuntimeDebuggerBlueprint,
  type JsRuntimeDebuggerApi,
} from "../../src/blueprints/js-runtime-debugger";
import {
  forgetJsCapturesOf,
  installNetworkInterceptor,
  jsCapture,
  networkInspectorBlueprint,
  setJsCapture,
  type JsCapture,
} from "../../src/blueprints/network-inspector";
import { isRedirect, networkLogsTool } from "../../src/tools/network/network-logs";
import { networkRequestTool } from "../../src/tools/network/network-request";
import { scopeTempHome } from "../helpers/temp-home";

// The JS-runtime-debugger / network blueprints build a real LogFileWriter,
// whose constructor mkdir -p's os.homedir()/.argent/tmp. Keep that out of the
// developer's real home.
scopeTempHome("argent-network-integration-home-");

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
/** How many times the interceptor script ran in the "runtime". */
let installs = 0;
/** The app id the runtime names in `ReactNativeApplication.metadataUpdated`, sent at connect. */
let runtimeAppId: string | undefined;
const networkLog: Array<{
  id: number;
  requestId: string;
  state: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
    postDataTruncated?: boolean;
  };
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
  bodyTruncated?: boolean;
  bodyLength?: number;
  bodyOmitted?: boolean;
}> = [];

function handleCDPMessage(ws: WebSocket, raw: string) {
  const msg = JSON.parse(raw);
  const { id, method, params } = msg;

  switch (method) {
    case "ReactNativeApplication.enable":
      if (runtimeAppId !== undefined) {
        ws.send(
          JSON.stringify({
            method: "ReactNativeApplication.metadataUpdated",
            params: { appIdentifier: runtimeAppId, platform: "android" },
          })
        );
      }
      ws.send(JSON.stringify({ id, result: {} }));
      break;

    case "FuseboxClient.setClientMetadata":
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

      // The interceptor script sets its install guard, while the log-read
      // scripts never mention it.
      if (expr.includes("__argent_network_v3")) {
        // This is the network interceptor installation script
        installs++;
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
    // Detail read script — extract the requestId. The script embeds it as a
    // JSON string literal (`byId["..."]`), so parse that literal back.
    const match = expr.match(/byId\[("(?:[^"\\]|\\.)*")\]/);
    const requestId = match ? (JSON.parse(match[1]) as string) : null;
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
                installed: false,
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

  // List read script. Like the real one, it finds no log in a runtime without the interceptor.
  if (!interceptorInstalled) {
    ws.send(
      JSON.stringify({
        id,
        result: {
          result: {
            type: "string",
            value: JSON.stringify({ entries: [], total: 0, interceptorInstalled: false }),
          },
        },
      })
    );
    return;
  }

  // Extract start and limit from the script
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
          url: e.response.url,
          status: e.response.status,
          statusText: e.response.statusText,
          mimeType: e.response.mimeType,
        }
      : undefined,
    resourceType: e.resourceType,
    encodedDataLength: e.encodedDataLength,
    bodyLength: e.bodyLength,
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

    mockServer.listen(0, "127.0.0.1", () => {
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

const APP = "com.example.app";

function startedCapture(fields: Partial<JsCapture> = {}): JsCapture {
  return { bundleId: APP, intent: "started", mark: { install: null }, installed: true, ...fields };
}

describe("NetworkInspector integration (mock server)", () => {
  // As network-capture-start leaves it: the reads below only read.
  beforeEach(() => {
    setJsCapture(`${mockPort}:mock-device`, startedCapture());
  });

  it("shares the same CDP connection with JsRuntimeDebugger (only 1 WS connection)", async () => {
    // Reset counter before this test group starts.
    // The beforeAll already sets up the server but doesn't create any services yet.
    wsConnectionCount = 0;

    // Resolve the network inspector, which should trigger JsRuntimeDebugger first
    await registry.resolveService(`NetworkInspector:${mockPort}:mock-device`);

    // Only ONE WebSocket connection should have been opened
    expect(wsConnectionCount).toBe(1);

    // Verify both services are running
    expect(registry.getServiceState(`JsRuntimeDebugger:${mockPort}:mock-device`)).toBe("RUNNING");
    expect(registry.getServiceState(`NetworkInspector:${mockPort}:mock-device`)).toBe("RUNNING");
  });

  it("view-network-logs returns paginated network entries", async () => {
    const result = (await registry.invokeTool("view-network-logs", {
      port: mockPort,
      device_id: "mock-device",
    })) as string;

    expect(result).toContain("NETWORK LOGS");
    expect(result).toContain("rn-net-1");
    expect(result).toContain("GET");
    expect(result).toContain("/users");
    expect(result).toContain("200 OK");
    expect(result).toContain("rn-net-2");
  });

  it("view-network-logs gives the length of a cut body without a byte size as an approximate size", async () => {
    networkLog.push({
      id: networkLog.length,
      requestId: "rn-net-cut-list",
      state: "finished" as const,
      request: { url: "https://api.example.com/cut-list", method: "GET", headers: {} },
      response: {
        url: "https://api.example.com/cut-list",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
      resourceType: "XHR",
      timestamp: Date.now() / 1000,
      durationMs: 100,
      responseBody: "x".repeat(1_048_576),
      bodyTruncated: true,
      bodyLength: 2_097_152,
    });

    try {
      const result = (await registry.invokeTool("view-network-logs", {
        port: mockPort,
        device_id: "mock-device",
      })) as string;

      expect(result).toMatch(/\{id: rn-net-cut-list\} "GET \/cut-list" 200 OK XHR ~2 MB 100 ms/);
    } finally {
      const idx = networkLog.findIndex((e) => e.requestId === "rn-net-cut-list");
      if (idx >= 0) networkLog.splice(idx, 1);
    }
  });

  it("view-network-logs returns 'no traffic' for empty log", async () => {
    // Temporarily clear the log
    const savedLog = networkLog.splice(0);
    try {
      const result = (await registry.invokeTool("view-network-logs", {
        port: mockPort,
        device_id: "mock-device",
      })) as string;

      expect(result).toContain("No network traffic captured");
      expect(result).not.toContain("\u2014");
    } finally {
      // Restore the log
      networkLog.push(...savedLog);
    }
  });

  it("view-network-request-details returns full details for a known requestId", async () => {
    const result = (await registry.invokeTool("view-network-request-details", {
      port: mockPort,
      device_id: "mock-device",
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

  it("redacts a header that whatwg-fetch sent as a numbered [name, value] pair", async () => {
    networkLog.push({
      id: networkLog.length,
      requestId: "rn-net-pairs",
      state: "finished",
      request: {
        url: "https://api.example.com/me",
        method: "GET",
        headers: { "0": "Authorization,Bearer tok", "1": "Accept,application/json" },
      },
      resourceType: "Fetch",
      timestamp: Date.now() / 1000,
    });
    try {
      const result = (await registry.invokeTool("view-network-request-details", {
        port: mockPort,
        device_id: "mock-device",
        requestId: "rn-net-pairs",
      })) as { request: { headers: Record<string, string> } };
      expect(result.request.headers).toEqual({
        "0": "[REDACTED]",
        "1": "Accept,application/json",
      });
    } finally {
      networkLog.splice(
        networkLog.findIndex((e) => e.requestId === "rn-net-pairs"),
        1
      );
    }
  });

  it("view-network-request-details returns response body when includeBody is true", async () => {
    const result = (await registry.invokeTool("view-network-request-details", {
      port: mockPort,
      device_id: "mock-device",
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
      device_id: "mock-device",
      requestId: "rn-net-999",
    })) as string;

    expect(result).toContain("Request not found");
  });

  it("still only 1 WS connection when JsRuntimeDebugger is resolved before NetworkInspector", async () => {
    // Dispose everything first so we can start fresh
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:mock-device`).catch(() => {});
    wsConnectionCount = 0;

    // Explicitly resolve JsRuntimeDebugger first
    await registry.resolveService(`JsRuntimeDebugger:${mockPort}:mock-device`);
    expect(wsConnectionCount).toBe(1);

    // Now resolve NetworkInspector — should NOT open a second connection
    await registry.resolveService(`NetworkInspector:${mockPort}:mock-device`);
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
        device_id: "mock-device",
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

  it.each([
    {
      says: "that capture stopped recording at a reload",
      installed: true,
      text: "Network capture for this app stopped recording at a JavaScript reload; requests since the reload are not recorded. Call network-capture-start again, repeat the action, then read again.",
    },
    {
      says: "that the app's JS runtime was not ready at the start",
      installed: false,
      text: "Network capture for this app is started, but the app's JavaScript runtime was not ready at the start, so no requests are recorded. Call network-capture-start again, repeat the action, then read again.",
    },
  ])(
    "view-network-logs of a context without the interceptor says $says and installs nothing",
    async ({ installed, text }) => {
      setJsCapture(`${mockPort}:mock-device`, startedCapture({ installed }));
      interceptorInstalled = false;
      const before = installs;
      try {
        const read = () =>
          registry.invokeTool("view-network-logs", { port: mockPort, device_id: "mock-device" });
        expect(await read()).toBe(text);
        // A second read changes nothing either.
        expect(await read()).toBe(text);
        expect(
          await registry.invokeTool("view-network-request-details", {
            port: mockPort,
            device_id: "mock-device",
            requestId: "rn-net-1",
          })
        ).toBe(`Request rn-net-1 not found. ${text}`);
        expect(installs).toBe(before);
        expect(interceptorInstalled).toBe(false);
      } finally {
        interceptorInstalled = true;
      }
    }
  );

  it("view-network-logs marks a request whose response came but whose body did not complete as pending", async () => {
    networkLog.push({
      id: networkLog.length,
      requestId: "rn-net-dropped",
      state: "pending",
      request: { url: "https://api.example.com/dropped", method: "GET", headers: {} },
      response: {
        url: "https://api.example.com/dropped",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "application/json",
      },
      resourceType: "Fetch",
      timestamp: Date.now() / 1000,
    });
    try {
      const result = (await registry.invokeTool("view-network-logs", {
        port: mockPort,
        device_id: "mock-device",
      })) as string;

      expect(result).toContain('{id: rn-net-dropped} "GET /dropped" 200 OK (pending) Fetch');
      expect(result).toMatch(/\{id: rn-net-1\} "GET \/users" 200 OK Fetch/);
    } finally {
      networkLog.splice(
        networkLog.findIndex((e) => e.requestId === "rn-net-dropped"),
        1
      );
    }
  });

  it("shows the final URL of a redirected request", async () => {
    const redirected = (requestId: string, url: string, finalUrl: string) => ({
      id: networkLog.length,
      requestId,
      state: "finished",
      request: { url, method: "GET", headers: {} },
      response: {
        url: finalUrl,
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
      resourceType: "XHR",
      timestamp: Date.now() / 1000,
      durationMs: 5,
    });
    networkLog.push(
      redirected("rn-net-moved", "https://api.example.com/old", "https://api.example.com/new"),
      redirected("rn-net-cdn", "https://api.example.com/file", "https://cdn.example.com/f/1"),
      // The same URL written differently is no redirect.
      redirected("rn-net-same", "https://api.example.com", "https://api.example.com/")
    );
    try {
      const result = (await registry.invokeTool("view-network-logs", {
        port: mockPort,
        device_id: "mock-device",
      })) as string;
      expect(result).toContain('{id: rn-net-moved} "GET /old" 200 OK XHR 5 ms → /new');
      expect(result).toContain(
        '{id: rn-net-cdn} "GET /file" 200 OK XHR 5 ms → cdn.example.com/f/1'
      );
      expect(result).toMatch(/\{id: rn-net-same\} "GET api\.example\.com" 200 OK XHR 5 ms$/m);

      const details = (await registry.invokeTool("view-network-request-details", {
        port: mockPort,
        device_id: "mock-device",
        requestId: "rn-net-moved",
      })) as { request: { url: string }; response: { redirectedTo?: string } };
      expect(details.request.url).toBe("https://api.example.com/old");
      expect(details.response.redirectedTo).toBe("https://api.example.com/new");

      const same = (await registry.invokeTool("view-network-request-details", {
        port: mockPort,
        device_id: "mock-device",
        requestId: "rn-net-same",
      })) as { response: Record<string, unknown> };
      expect(same.response).not.toHaveProperty("redirectedTo");

      const plain = (await registry.invokeTool("view-network-request-details", {
        port: mockPort,
        device_id: "mock-device",
        requestId: "rn-net-1",
      })) as { response: Record<string, unknown> };
      expect(plain.response).not.toHaveProperty("redirectedTo");
    } finally {
      networkLog.splice(
        networkLog.findIndex((e) => e.requestId === "rn-net-moved"),
        3
      );
    }
  });

  it("shows the standard reason phrase of each status, whatever text the platform gave", async () => {
    const record = (
      requestId: string,
      status: number,
      statusText: string,
      resourceType: string
    ) => ({
      id: networkLog.length,
      requestId,
      state: "finished",
      request: { url: `https://api.example.com/${requestId}`, method: "GET", headers: {} },
      response: {
        url: `https://api.example.com/${requestId}`,
        status,
        statusText,
        headers: {},
        mimeType: "text/plain",
      },
      resourceType,
      timestamp: Date.now() / 1000,
    });
    // Expo on iOS gives localised descriptions, React Native's XHR and fetch give none.
    networkLog.push(
      record("expo-ok", 200, "no error", "Fetch"),
      record("expo-500", 500, "internal server error", "Fetch"),
      record("xhr-404", 404, "", "XHR"),
      record("xhr-299", 299, "", "XHR")
    );
    try {
      const result = (await registry.invokeTool("view-network-logs", {
        port: mockPort,
        device_id: "mock-device",
      })) as string;
      expect(result).toContain('{id: expo-ok} "GET /expo-ok" 200 OK Fetch\n');
      expect(result).toContain('{id: expo-500} "GET /expo-500" 500 Internal Server Error Fetch\n');
      expect(result).toContain('{id: xhr-404} "GET /xhr-404" 404 Not Found XHR\n');
      expect(result).toMatch(/\{id: xhr-299\} "GET \/xhr-299" 299 XHR$/m);

      for (const [requestId, statusText] of [
        ["expo-ok", "OK"],
        ["xhr-404", "Not Found"],
        ["xhr-299", ""],
      ]) {
        const details = (await registry.invokeTool("view-network-request-details", {
          port: mockPort,
          device_id: "mock-device",
          requestId,
        })) as { response: { statusText: string } };
        expect(details.response.statusText).toBe(statusText);
      }
    } finally {
      networkLog.splice(
        networkLog.findIndex((e) => e.requestId === "expo-ok"),
        4
      );
    }
  });

  it("view-network-logs returns page index out-of-range error", async () => {
    const result = (await registry.invokeTool("view-network-logs", {
      port: mockPort,
      device_id: "mock-device",
      pageIndex: 999,
    })) as string;

    expect(result).toContain("Page index out of range");
  });

  it("view-network-request-details omits body when includeBody is false", async () => {
    const result = (await registry.invokeTool("view-network-request-details", {
      port: mockPort,
      device_id: "mock-device",
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
        device_id: "mock-device",
        requestId: "rn-net-large",
        includeBody: true,
      })) as Record<string, unknown>;

      const resp = result.response as Record<string, unknown>;
      expect(resp.body).toBeDefined();
      const body = resp.body as string;
      expect(body).toBe(
        `[TRUNCATED: first 1000 chars shown, full size: 2000 chars, MIME: text/plain]\n${"x".repeat(1000)}...`
      );
      // Body should be shorter than original
      expect(body.length).toBeLessThan(2000);
    } finally {
      const idx = networkLog.findIndex((e) => e.requestId === "rn-net-large");
      if (idx >= 0) networkLog.splice(idx, 1);
    }
  });

  it("view-network-request-details reports the full size of a body the interceptor cut", async () => {
    const cutEntry = {
      id: networkLog.length,
      requestId: "rn-net-cut",
      state: "finished" as const,
      request: { url: "https://api.example.com/huge", method: "GET", headers: {} },
      response: {
        url: "https://api.example.com/huge",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "text/plain",
      },
      resourceType: "XHR",
      encodedDataLength: 1_500_000,
      timestamp: Date.now() / 1000,
      durationMs: 100,
      responseBody: "x".repeat(1_048_576),
      bodyTruncated: true,
    };
    networkLog.push(cutEntry);

    try {
      const result = (await registry.invokeTool("view-network-request-details", {
        port: mockPort,
        device_id: "mock-device",
        requestId: "rn-net-cut",
        includeBody: true,
      })) as Record<string, unknown>;

      const body = (result.response as Record<string, unknown>).body as string;
      expect(body).toContain("full size: 1500000 bytes");
    } finally {
      const idx = networkLog.findIndex((e) => e.requestId === "rn-net-cut");
      if (idx >= 0) networkLog.splice(idx, 1);
    }
  });

  it("view-network-request-details says a cut body of unknown size is larger than its cap", async () => {
    const cutEntry = {
      id: networkLog.length,
      requestId: "rn-net-cut-json",
      state: "finished" as const,
      request: { url: "https://api.example.com/huge.json", method: "GET", headers: {} },
      response: {
        url: "https://api.example.com/huge.json",
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "application/json",
      },
      resourceType: "XHR",
      timestamp: Date.now() / 1000,
      durationMs: 100,
      responseBody: "x".repeat(1_048_576),
      bodyTruncated: true,
    };
    networkLog.push(cutEntry);

    try {
      const result = (await registry.invokeTool("view-network-request-details", {
        port: mockPort,
        device_id: "mock-device",
        requestId: "rn-net-cut-json",
        includeBody: true,
      })) as Record<string, unknown>;

      const body = (result.response as Record<string, unknown>).body as string;
      expect(body).toContain("full size: more than 1048576 chars");
    } finally {
      const idx = networkLog.findIndex((e) => e.requestId === "rn-net-cut-json");
      if (idx >= 0) networkLog.splice(idx, 1);
    }
  });

  it.each([
    {
      requestId: "rn-net-cut-text",
      mimeType: "text/plain",
      fields: { responseBody: "x".repeat(1_048_576), bodyTruncated: true, bodyLength: 9_000_000 },
      says: "the full length of a cut text body",
      message: "full size: 9000000 chars",
    },
    {
      requestId: "rn-net-png",
      mimeType: "image/png",
      fields: { encodedDataLength: 300_000, bodyOmitted: true },
      says: "that it did not read a binary body",
      message: "[body omitted: binary image/png, 300000 bytes]",
    },
    {
      requestId: "rn-net-png-text",
      mimeType: "image/png",
      fields: { bodyLength: 4096, bodyOmitted: true },
      says: "the estimated size of a binary body read as text",
      message: "[body omitted: binary image/png, ~4096 bytes]",
    },
  ])(
    "view-network-request-details gives $says",
    async ({ requestId, mimeType, fields, message }) => {
      networkLog.push({
        id: networkLog.length,
        requestId,
        state: "finished" as const,
        request: { url: "https://api.example.com/x", method: "GET", headers: {} },
        response: {
          url: "https://api.example.com/x",
          status: 200,
          statusText: "OK",
          headers: {},
          mimeType,
        },
        resourceType: "XHR",
        timestamp: Date.now() / 1000,
        durationMs: 100,
        ...fields,
      });

      try {
        const result = (await registry.invokeTool("view-network-request-details", {
          port: mockPort,
          device_id: "mock-device",
          requestId,
          includeBody: true,
        })) as Record<string, unknown>;

        expect((result.response as Record<string, unknown>).body).toContain(message);
      } finally {
        const idx = networkLog.findIndex((e) => e.requestId === requestId);
        if (idx >= 0) networkLog.splice(idx, 1);
      }
    }
  );

  it.each([
    {
      size: 1500,
      truncated: false,
      says: "gives its size",
      message: "full size: 1500 chars",
    },
    {
      size: 1_048_576,
      truncated: true,
      says: "says the interceptor had already cut it at 1 MiB",
      message: "full size: more than 1048576 chars",
    },
  ])(
    "view-network-request-details shortens a request body of $size chars and $says",
    async ({ size, truncated, message }) => {
      const requestId = `rn-net-post-${size}`;
      networkLog.push({
        id: networkLog.length,
        requestId,
        state: "finished" as const,
        request: {
          url: "https://api.example.com/upload",
          method: "POST",
          headers: {},
          postData: "p".repeat(size),
          ...(truncated ? { postDataTruncated: true } : {}),
        },
        resourceType: "XHR",
        timestamp: Date.now() / 1000,
        durationMs: 100,
      });

      try {
        const result = (await registry.invokeTool("view-network-request-details", {
          port: mockPort,
          device_id: "mock-device",
          requestId,
        })) as Record<string, unknown>;

        const postData = (result.request as Record<string, unknown>).postData as string;
        expect(postData).toContain(message);
        expect(postData.length).toBeLessThan(1200);
      } finally {
        const idx = networkLog.findIndex((e) => e.requestId === requestId);
        if (idx >= 0) networkLog.splice(idx, 1);
      }
    }
  );

  it("NetworkInspector cascades teardown when JsRuntimeDebugger is disposed", async () => {
    // Dispose JsRuntimeDebugger — NetworkInspector should also be torn down
    await registry.disposeService(`JsRuntimeDebugger:${mockPort}:mock-device`);

    expect(registry.getServiceState(`JsRuntimeDebugger:${mockPort}:mock-device`)).toBe("IDLE");
    expect(registry.getServiceState(`NetworkInspector:${mockPort}:mock-device`)).toBe("IDLE");
  });
});

describe("JS network reads follow the capture intent (mock server)", () => {
  const NOT_STARTED =
    "Network capture is not started for this app, so no requests are recorded. Call network-capture-start with udid and bundleId, repeat the action, then";

  let nextDevice = 1;
  /** A device id no earlier case touched, so its services start from nothing. */
  function freshDevice(): string {
    return `capture-device-${nextDevice++}`;
  }

  beforeEach(() => {
    forgetJsCapturesOf();
    interceptorInstalled = true;
  });

  afterAll(() => {
    forgetJsCapturesOf();
    runtimeAppId = undefined;
  });

  function logs(device: string, port = mockPort): Promise<unknown> {
    return registry.invokeTool("view-network-logs", { port, device_id: device });
  }

  function details(device: string, requestId = "rn-net-1"): Promise<unknown> {
    return registry.invokeTool("view-network-request-details", {
      port: mockPort,
      device_id: device,
      requestId,
    });
  }

  /** The device's services in the registry, of any state. */
  function servicesOf(device: string): string[] {
    return [...registry.getSnapshot().services.keys()].filter((urn) => urn.endsWith(`:${device}`));
  }

  it.each([
    { platform: "Android", device: "emulator-5570" },
    { platform: "iOS", device: "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC" },
  ])(
    "before any start, both reads on $platform reach nothing in the app and say capture is not started",
    async ({ device }) => {
      const connections = wsConnectionCount;
      const before = installs;

      expect(await logs(device)).toBe(`${NOT_STARTED} call view-network-logs again.`);
      expect(await details(device)).toBe(
        `Request rn-net-1 not found. ${NOT_STARTED} list the requests with view-network-logs.`
      );

      expect(servicesOf(device)).toEqual([]);
      expect(wsConnectionCount).toBe(connections);
      expect(installs).toBe(before);
    }
  );

  it("names the Metro port the device's capture is on", async () => {
    const device = freshDevice();
    setJsCapture(`8190:${device}`, startedCapture());
    setJsCapture(`8191:${device}`, startedCapture({ bundleId: "com.other.app" }));
    const hint =
      " This device has network capture for com.example.app on Metro port 8190: pass port 8190 to read it." +
      " This device has network capture for com.other.app on Metro port 8191: pass port 8191 to read it.";

    expect(await logs(device)).toBe(`${NOT_STARTED} call view-network-logs again.${hint}`);
    expect(await details(device)).toBe(
      `Request rn-net-1 not found. ${NOT_STARTED} list the requests with view-network-logs.${hint}`
    );
    expect(servicesOf(device)).toEqual([]);
  });

  it("after a start, lists through the debugger and installs nothing", async () => {
    const device = freshDevice();
    setJsCapture(`${mockPort}:${device}`, startedCapture());
    const before = installs;

    const result = (await logs(device)) as string;
    expect(result).toMatch(/^=== NETWORK LOGS \(page 1\/1, \d+ total\) ===/);
    expect(result).toContain("rn-net-1");
    expect(await details(device)).toMatchObject({ requestId: "rn-net-1" });

    expect(installs).toBe(before);
    expect(servicesOf(device)).toEqual([`JsRuntimeDebugger:${mockPort}:${device}`]);
  });

  it("says a started capture has nothing yet, but not requests sent before the start", async () => {
    const device = freshDevice();
    setJsCapture(`${mockPort}:${device}`, startedCapture());
    const saved = networkLog.splice(0);
    try {
      expect(await logs(device)).toBe(
        "No network traffic captured. Make sure the app is running and making HTTP requests. Network interception is active: it records XMLHttpRequest (axios included), React Native's fetch, Expo's fetch, and a fetch library that sends through React Native's network module, but not requests sent before network-capture-start."
      );
    } finally {
      networkLog.push(...saved);
    }
  });

  it("lists a context that an install after a reload reached, as a later start makes", async () => {
    const device = freshDevice();
    const payload = `${mockPort}:${device}`;
    setJsCapture(payload, startedCapture());
    interceptorInstalled = false;

    expect(await logs(device)).toContain("stopped recording at a JavaScript reload");

    const dbg = await registry.resolveService<JsRuntimeDebuggerApi>(`JsRuntimeDebugger:${payload}`);
    expect(await installNetworkInterceptor(dbg.cdp, payload, dbg.runtimeApp)).toEqual({
      installed: true,
    });
    expect(await logs(device)).toContain("rn-net-1");
  });

  it("lists what a stopped capture recorded, with the stop in its header", async () => {
    const device = freshDevice();
    setJsCapture(`${mockPort}:${device}`, startedCapture({ intent: "stopped" }));
    const before = installs;

    const result = (await logs(device)) as string;
    expect(result).toMatch(/^=== NETWORK LOGS \(page 1\/1, \d+ total; capture stopped\) ===/);
    expect(result).toContain("rn-net-1");
    // Its ids keep working.
    expect(await details(device)).toMatchObject({ requestId: "rn-net-1", state: "finished" });
    expect(installs).toBe(before);
  });

  it("says a stopped capture recorded nothing", async () => {
    const device = freshDevice();
    setJsCapture(`${mockPort}:${device}`, startedCapture({ intent: "stopped" }));
    const saved = networkLog.splice(0);
    try {
      expect(await logs(device)).toBe(
        "No network traffic captured: network capture is stopped for com.example.app (network-capture-stop). Call network-capture-start to capture again, then repeat the action."
      );
    } finally {
      networkLog.push(...saved);
    }
  });

  it.each([
    {
      since: "a reload cleared what it recorded",
      installed: true,
      text: "Network capture is stopped for com.example.app (network-capture-stop), and the app's JS runtime reloaded since, which cleared its requests. Call network-capture-start to capture again, then repeat the action.",
    },
    {
      since: "nothing was recorded in the current runtime",
      installed: false,
      text: "Network capture is stopped for com.example.app (network-capture-stop), and nothing was recorded in the app's current JS runtime. Call network-capture-start to capture again, then repeat the action.",
    },
  ])(
    "says a stopped capture has no log when $since, and installs nothing",
    async ({ installed, text }) => {
      const device = freshDevice();
      setJsCapture(`${mockPort}:${device}`, startedCapture({ intent: "stopped", installed }));
      interceptorInstalled = false;
      const before = installs;

      expect(await logs(device)).toBe(text);
      expect(await details(device)).toBe(`Request rn-net-1 not found. ${text}`);
      expect(installs).toBe(before);
      expect(servicesOf(device)).toEqual([`JsRuntimeDebugger:${mockPort}:${device}`]);
    }
  );

  it("says capture is not started for a runtime of another app than the capture's", async () => {
    const device = freshDevice();
    setJsCapture(`${mockPort}:${device}`, startedCapture());
    runtimeAppId = "com.other.app";
    const before = installs;
    try {
      expect(await logs(device)).toBe(`${NOT_STARTED} call view-network-logs again.`);
      expect(await details(device)).toBe(
        `Request rn-net-1 not found. ${NOT_STARTED} list the requests with view-network-logs.`
      );
      expect(installs).toBe(before);
      // The capture's entry stays as it was.
      expect(jsCapture(`${mockPort}:${device}`)).toEqual(startedCapture());
    } finally {
      runtimeAppId = undefined;
    }
  });
});

describe("isRedirect", () => {
  it.each([
    ["the same URL", "https://api.test/a?q=1", "https://api.test/a?q=1"],
    [
      "a space the native layer encoded",
      "https://api.test/a b?q=x y",
      "https://api.test/a%20b?q=x%20y",
    ],
    ["a URL iOS encoded again", "https://api.test/a b?q=%20", "https://api.test/a%20b?q=%2520"],
    ["an app that encoded twice", "https://api.test/q=%2520", "https://api.test/q=%20"],
    ["+ for a space in a query", "https://api.test/s?q=a%20b", "https://api.test/s?q=a+b"],
    ["escapes OkHttp adds", "https://api.test/a|b^c", "https://api.test/a%7Cb%5Ec"],
    ["lower-case escapes", "https://api.test/a%2fb", "https://api.test/a%2Fb"],
    ["a fragment, which is never sent", "https://api.test/a#top", "https://api.test/a"],
    ["an empty query", "https://api.test/a?", "https://api.test/a"],
    ["a trailing slash on the root", "https://API.test", "https://api.test/"],
  ])("is false for %s", (_, requestUrl, finalUrl) => {
    expect(isRedirect(requestUrl, finalUrl)).toBe(false);
  });

  it.each([
    ["another path", "https://api.test/old", "https://api.test/new"],
    ["another host", "https://api.test/f", "https://cdn.test/f"],
    ["http to https", "http://api.test/a", "https://api.test/a"],
    ["an escaped slash decoded", "https://api.test/a%2Fb", "https://api.test/a/b"],
    ["an escaped & decoded", "https://api.test/s?q=a%26b", "https://api.test/s?q=a&b"],
    ["another query", "https://api.test/s?q=1", "https://api.test/s?q=2"],
  ])("is true for %s", (_, requestUrl, finalUrl) => {
    expect(isRedirect(requestUrl, finalUrl)).toBe(true);
  });
});
