/**
 * Hermes replays its buffered console messages to a new client before it
 * answers `Runtime.enable`. Drives the real Registry → JsRuntimeDebugger path
 * against a mock Metro.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { Registry } from "@argent/registry";
import {
  jsRuntimeDebuggerBlueprint,
  type JsRuntimeDebuggerApi,
} from "../../src/blueprints/js-runtime-debugger";
import {
  __resetReapedSessionsForTesting,
  takeReapedSession,
} from "../../src/utils/reaped-sessions";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-startup-log-home-");

const DEVICE = "startup-device";

let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;
let failSetup = false;
let dropOnSetup = false;
let dropOnEnable = false;

function handleCDPMessage(ws: WebSocket, raw: string) {
  const { id, method } = JSON.parse(raw) as { id: number; method: string };
  if (method === "Runtime.enable") {
    ws.send(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "log",
          args: [{ type: "string", value: "printed at startup" }],
          executionContextId: 1,
          timestamp: 1710000000000,
        },
      })
    );
    if (dropOnEnable) {
      ws.terminate();
      return;
    }
  }
  if (method === "Runtime.addBinding" && dropOnSetup) {
    ws.terminate();
    return;
  }
  if (method === "Runtime.addBinding" && failSetup) {
    ws.send(JSON.stringify({ id, error: { code: -32000, message: "Runtime.addBinding failed" } }));
    return;
  }
  if (method === "Runtime.evaluate") {
    ws.send(JSON.stringify({ id, result: { result: { type: "string", value: "ok" } } }));
    return;
  }
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
              id: "page-1",
              title: "app (Test Device)",
              description: "[C++ connection]",
              webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=${DEVICE}&page=1`,
              deviceName: "Test Device",
              reactNative: {
                logicalDeviceId: DEVICE,
                capabilities: { prefersFuseboxFrontend: true },
              },
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws) => ws.on("message", (raw) => handleCDPMessage(ws, raw.toString())));
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await registry?.dispose();
  failSetup = false;
  dropOnSetup = false;
  dropOnEnable = false;
  __resetReapedSessionsForTesting();
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => mockServer.close(() => resolve())));
});

function connect() {
  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  return registry.resolveService<JsRuntimeDebuggerApi>(`JsRuntimeDebugger:${mockPort}:${DEVICE}`);
}

const logFiles = () => {
  const dir = path.join(process.env.HOME!, ".argent", "tmp");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("argent-logs-")) : [];
};

describe("JsRuntimeDebugger startup log capture", () => {
  it("records the console messages the runtime replays on Runtime.enable", async () => {
    const api = await connect();
    expect(api.logWriter.getStats().totalEntries).toBe(1);
  });

  it("closes the socket and removes the log file when the setup fails", async () => {
    failSetup = true;
    await expect(connect()).rejects.toThrow();
    await vi.waitFor(() => expect(wss.clients.size).toBe(0));
    expect(logFiles()).toEqual([]);
    expect(takeReapedSession("js-runtime-debugger", DEVICE)).toBeUndefined();
  });

  it("keeps the replayed logs and names the file when the app dies during the setup", async () => {
    dropOnSetup = true;
    await expect(connect()).rejects.toThrow();
    const files = logFiles();
    expect(files).toHaveLength(1);
    const file = path.join(process.env.HOME!, ".argent", "tmp", files[0]!);
    expect(fs.readFileSync(file, "utf-8")).toContain("printed at startup");
    const reaped = takeReapedSession("js-runtime-debugger", DEVICE);
    expect(reaped?.connectionLost).toBe(true);
    expect(reaped?.salvage).toContain(`kept at ${file}`);
  });

  it("keeps the replayed logs when the app dies before answering Runtime.enable", async () => {
    dropOnEnable = true;
    await expect(connect()).rejects.toThrow();
    const files = logFiles();
    expect(files).toHaveLength(1);
    const file = path.join(process.env.HOME!, ".argent", "tmp", files[0]!);
    const reaped = takeReapedSession("js-runtime-debugger", DEVICE);
    expect(reaped?.connectionLost).toBe(true);
    expect(reaped?.salvage).toContain(`kept at ${file}`);
  });
});
