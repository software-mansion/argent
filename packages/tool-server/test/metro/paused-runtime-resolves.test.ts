import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { Registry } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { createDebuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import { scopeTempHome } from "../helpers/temp-home";

scopeTempHome("argent-paused-runtime-home-");

/**
 * A runtime stopped at a breakpoint is NOT what `runtime_unresponsive` reports,
 * and both guidance strings say so. The distinction is in which sends the
 * connect pipeline makes: the inspector answers its enables while paused (a
 * paused V8 answers `Runtime.evaluate` with `awaitPromise` off in under a
 * millisecond), and the only sends that wait on the JS thread — `addBinding`'s
 * probe and DISABLE_LOGBOX_SCRIPT — are both swallowed. So the session resolves
 * and `debugger-status` says "connected".
 *
 * The mock here is that runtime: every inspector method answers, and every
 * `Runtime.evaluate` that awaits a promise never does.
 */
let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;
const seen: string[] = [];
const withheld: string[] = [];

function handle(ws: WebSocket, raw: string) {
  const { id, method, params } = JSON.parse(raw) as {
    id: number;
    method: string;
    params?: { awaitPromise?: boolean };
  };
  seen.push(method);
  if (method === "Runtime.evaluate" && params?.awaitPromise) {
    withheld.push(method); // paused: never answers
    return;
  }
  if (method === "Debugger.enable") {
    ws.send(JSON.stringify({ id, result: { debuggerId: "paused-mock" } }));
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
              title: "React Native (paused mock)",
              description: "[C++ connection]",
              webSocketDebuggerUrl: `ws://localhost:${mockPort}/inspector/debug?device=0&page=1`,
              deviceName: "MockDevice",
              reactNative: { capabilities: { prefersFuseboxFrontend: true } },
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
    });
    wss = new WebSocketServer({ server: mockServer });
    wss.on("connection", (ws) => ws.on("message", (raw) => handle(ws, raw.toString())));
    mockServer.listen(0, () => {
      mockPort = (mockServer.address() as { port: number }).port;
      resolve();
    });
  });
  registry = new Registry();
  registry.registerBlueprint(jsRuntimeDebuggerBlueprint);
  registry.registerTool(createDebuggerStatusTool(registry));
});

afterAll(async () => {
  await registry.dispose();
  await new Promise<void>((resolve) => {
    wss.close(() => mockServer.close(() => resolve()));
  });
});

describe("a JS runtime that never answers an awaited evaluate", () => {
  it("still resolves, so debugger-status reports connected rather than runtime_unresponsive", async () => {
    const result = (await registry.invokeTool("debugger-status", {
      port: mockPort,
      device_id: "mock-device",
    })) as Record<string, unknown>;

    expect(result.status).toBe("connected");
    expect(result.reason, "no not-connected reason at all").toBeUndefined();
    // The pipeline really did reach the JS-dependent sends and eat their
    // timeouts; without these the test would pass on a mock that never got
    // that far.
    expect(seen).toContain("Runtime.addBinding");
    expect(seen.filter((m) => m === "Runtime.evaluate").length).toBeGreaterThanOrEqual(2);
    // And that the mock WITHHELD them. Reaching the sends is not the input under
    // test: a mock that answers everything reaches them identically, so without
    // this the paused model can be softened away and the test still passes.
    expect(withheld.length, "the mock must leave every awaited evaluate unanswered").toBe(
      seen.filter((m) => m === "Runtime.evaluate").length
    );
  }, 40_000);
});
