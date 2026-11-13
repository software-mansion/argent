import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import { debuggerConnectTool } from "../../src/tools/debugger/debugger-connect";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-legacy-worklet-home-");

/**
 * An RN 0.75 legacy-inspector app using Reanimated (#1836). Metro lists the
 * Reanimated UI runtime first; it is idle, so it accepts the socket and never
 * answers. The app's Hermes runtime answers -32601 for methods it lacks,
 * Runtime.addBinding among them.
 */
const TARGETS = [
  { id: "0-2", page: 2, title: "Reanimated UI runtime", vm: "Hermes" },
  { id: "0-1", page: 1, title: "Hermes React Native", vm: "Hermes" },
  {
    id: "0--1",
    page: -1,
    title: "React Native Experimental (Improved Chrome Reloads)",
    vm: "don't use",
  },
];

const SUPPORTED = new Set([
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.runIfWaitingForDebugger",
  "Debugger.enable",
  "Debugger.setPauseOnExceptions",
  "Debugger.setAsyncCallStackDepth",
]);

let server: http.Server;
let wss: WebSocketServer;
let port: number;
let registry: Registry;

function handleCDP(ws: WebSocket, page: string | null, raw: string) {
  const { id, method } = JSON.parse(raw) as { id: number; method: string };
  if (page !== "1") return;
  if (!SUPPORTED.has(method)) {
    ws.send(JSON.stringify({ id, error: { code: -32601, message: `${method} wasn't found` } }));
    return;
  }
  if (method === "Runtime.evaluate") {
    ws.send(JSON.stringify({ id, result: { result: { type: "number", value: 2 } } }));
    return;
  }
  ws.send(JSON.stringify({ id, result: {} }));
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/status") {
        res.end("packager-status:running");
        return;
      }
      if (req.url === "/json/list") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            TARGETS.map(({ page, ...t }) => ({
              ...t,
              description: "com.example.app",
              type: "node",
              deviceName: "sdk_google_atv64_arm64",
              webSocketDebuggerUrl: `ws://10.0.2.2:${port}/inspector/debug?device=0&page=${page}`,
            }))
          )
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    wss = new WebSocketServer({ server });
    wss.on("connection", (ws, req) => {
      const page = new URL(req.url ?? "", "http://localhost").searchParams.get("page");
      ws.on("message", (raw) => handleCDP(ws, page, raw.toString()));
    });
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
});

beforeEach(() => {
  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(debuggerConnectTool);
  registry.registerTool(debuggerEvaluateTool);
});

afterEach(async () => {
  await registry.dispose();
});

describe("legacy inspector with a Reanimated worklet runtime", () => {
  it("connects to the app's Hermes runtime and evaluates there", async () => {
    const connected = await registry.invokeTool("debugger-connect", {
      port,
      device_id: "emulator-5554",
    });
    expect(connected).toMatchObject({ appName: "Hermes React Native", connected: true });

    const evaluated = await registry.invokeTool("debugger-evaluate", {
      port,
      device_id: "emulator-5554",
      expression: "1 + 1",
    });
    expect(evaluated).toMatchObject({ result: 2 });
  });
});
