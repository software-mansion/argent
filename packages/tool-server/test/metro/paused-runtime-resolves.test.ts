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
 * and both guidance strings say so. What this test proves is the half of that
 * argument the code decides: the connect pipeline's only sends that wait on the
 * JS thread — `addBinding`'s probe and DISABLE_LOGBOX_SCRIPT — are swallowed, so
 * an unanswered awaited evaluate still resolves the session and `debugger-status`
 * says "connected".
 *
 * It does NOT prove that a paused inspector answers its enables: the mock answers
 * them by construction. That half is a fact about V8 and Chrome, measured rather
 * than tested (Chrome 152, `Debugger.paused` observed: every connect send,
 * `readViewport`'s un-awaited `Runtime.evaluate` included, answers in under 4 ms).
 *
 * The mock models the JS thread only: every inspector method answers, and every
 * `Runtime.evaluate` that awaits a promise never does.
 */
let mockServer: http.Server;
let wss: WebSocketServer;
let mockPort: number;
let registry: Registry;
const seen: string[] = [];
/** Request ids of the awaited evaluates — the sends the paused model withholds. */
const awaited = new Set<number>();
/** Request ids the mock answered, recorded at the one place it can answer. */
const answered = new Set<number>();

/**
 * The only path that replies. Recording here rather than beside each caller is
 * what makes `answered` observe the mock instead of restating it: a reply added
 * anywhere in `handle` goes through this and shows up in the disjointness check.
 */
function reply(ws: WebSocket, id: number, result: unknown) {
  answered.add(id);
  ws.send(JSON.stringify({ id, result }));
}

function handle(ws: WebSocket, raw: string) {
  const { id, method, params } = JSON.parse(raw) as {
    id: number;
    method: string;
    params?: { awaitPromise?: boolean };
  };
  seen.push(method);
  if (method === "Runtime.evaluate" && params?.awaitPromise) {
    awaited.add(id); // paused: never answers
    return;
  }
  if (method === "Debugger.enable") {
    reply(ws, id, { debuggerId: "paused-mock" });
    return;
  }
  reply(ws, id, {});
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
    const startedAt = Date.now();
    const result = (await registry.invokeTool("debugger-status", {
      port: mockPort,
      device_id: "mock-device",
    })) as Record<string, unknown>;
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe("connected");
    expect(result.reason, "no not-connected reason at all").toBeUndefined();
    // The pipeline really did reach the JS-dependent sends and eat their
    // timeouts; without these the test would pass on a mock that never got
    // that far.
    expect(seen).toContain("Runtime.addBinding");
    // The two the pipeline aims at the JS thread, and the whole of them:
    // addBinding's probe and DISABLE_LOGBOX_SCRIPT, both through cdp.evaluate,
    // which defaults awaitPromise: true. A third would mean the pipeline grew a
    // JS-thread send this model does not cover.
    expect(seen.filter((m) => m === "Runtime.evaluate").length).toBe(2);
    expect(awaited.size, "both of them await their promise").toBe(2);
    // And that the mock WITHHELD them. Reaching the sends is not the input under
    // test: a mock that answers everything reaches them identically. So this is
    // asserted against what the mock actually put on the wire — `answered` is
    // written only by `reply` — and not against a second list written beside the
    // first, which holds under any mock behaviour and proves nothing.
    for (const id of awaited) {
      expect(answered, `the mock answered awaited evaluate id=${id}`).not.toContain(id);
    }
    expect(answered.size, "the rest of the pipeline was answered").toBeGreaterThan(0);
    // The one signal a softened mock cannot fake: withholding both awaited sends
    // costs two real DEFAULT_TIMEOUT_MS expiries. A mock that answers them
    // finishes in well under a second, and the bookkeeping above is written
    // beside the send rather than read off the wire.
    expect(elapsed, "the two withheld sends were really waited out").toBeGreaterThan(15_000);
  }, 40_000);
});
