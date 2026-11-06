import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import * as http from "node:http";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { CDPClient } from "../../src/utils/debugger/cdp-client";
import { discoverMetro } from "../../src/utils/debugger/discovery";

/**
 * Tolerating a missing X-React-Native-Project-Root header admits the whole legacy
 * inspector — not only Vega, but any older iOS/Android project, where the
 * capability gate does NOT reject the binding-dependent tools. So the legacy
 * runtime's quirks have to be handled at the transport, not just guessed at from
 * the platform:
 *
 *  - Runtime.addBinding is ACKed but never installed (RN <= 0.72), so a tool
 *    waiting on Runtime.bindingCalled would hang for the full 10s timeout, or is
 *    rejected with -32601 (RN 0.73 - 0.75).
 *  - The proxy advertises an unusable `vm: "don't use"` page.
 *  - Anything answering "packager-status:running" now reaches the /json/list parse.
 */

let server: http.Server;
let wss: WebSocketServer;
let port: number;

/** Whether the mock runtime installs the binding it ACKs. */
let installsBinding = true;
/** How the mock runtime answers Runtime.addBinding. */
let addBindingReply: "ack" | "method-not-found" | "close" = "ack";
let listBody: unknown = [];

function handleCDP(ws: WebSocket, raw: string) {
  const { id, method, params } = JSON.parse(raw) as {
    id: number;
    method: string;
    params?: { expression?: string };
  };
  if (method === "Runtime.addBinding") {
    if (addBindingReply === "method-not-found") {
      // RN 0.75's legacy Hermes inspector, as reported in #1836.
      ws.send(
        JSON.stringify({ id, error: { code: -32601, message: "Runtime.addBinding wasn't found" } })
      );
    } else if (addBindingReply === "close") {
      ws.close();
    } else {
      // Legacy Hermes ACKs this happily either way — that is the whole trap.
      ws.send(JSON.stringify({ id, result: {} }));
    }
    return;
  }
  if (method === "Runtime.evaluate") {
    const value = params?.expression?.startsWith("typeof ")
      ? installsBinding
        ? "function"
        : "undefined"
      : undefined;
    ws.send(JSON.stringify({ id, result: { result: { value } } }));
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
        res.end(typeof listBody === "string" ? listBody : JSON.stringify(listBody));
        return;
      }
      res.statusCode = 404;
      res.end("nope");
    });
    wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => ws.on("message", (raw) => handleCDP(ws, raw.toString())));
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

describe("legacy inspector guards", () => {
  let cdp: CDPClient;

  beforeEach(() => {
    installsBinding = true;
    addBindingReply = "ack";
  });

  afterEach(async () => {
    await cdp?.disconnect();
  });

  it("fails fast instead of hanging when the runtime never installs the binding", async () => {
    installsBinding = false;
    cdp = new CDPClient(`ws://localhost:${port}/inspector/debug?device=0&page=1`);
    await cdp.connect();
    await cdp.addBinding("__argent_callback");

    const started = Date.now();
    await expect(cdp.evaluateWithBinding("void 0", "req-1")).rejects.toThrow(
      /never installs the binding/i
    );
    // The point of the probe: not a 10s DEFAULT_TIMEOUT_MS wait.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("marks the binding unavailable when a legacy runtime has no Runtime.addBinding", async () => {
    addBindingReply = "method-not-found";
    cdp = new CDPClient(`ws://localhost:${port}/inspector/debug?device=0&page=1`);
    await cdp.connect();
    await cdp.addBinding("__argent_callback", { legacyInspector: true });

    const started = Date.now();
    const error = await cdp.evaluateWithBinding("void 0", "req-3").catch((e: unknown) => e);
    expect(getFailureSignal(error)?.error_code).toBe(
      FAILURE_CODES.DEBUGGER_CDP_BINDING_UNAVAILABLE
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("still fails addBinding when the connection drops instead of answering", async () => {
    addBindingReply = "close";
    cdp = new CDPClient(`ws://localhost:${port}/inspector/debug?device=0&page=1`);
    await cdp.connect();

    const error = await cdp
      .addBinding("__argent_callback", { legacyInspector: true })
      .catch((e: unknown) => e);
    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED);
  });

  it("fails addBinding on a rejection from a modern target", async () => {
    // A modern host has the method and rejects it only while it has no JS
    // instance; the binding must not be written off for the session.
    addBindingReply = "method-not-found";
    cdp = new CDPClient(`ws://localhost:${port}/inspector/debug?device=0&page=1`);
    await cdp.connect();

    const error = await cdp.addBinding("__argent_callback").catch((e: unknown) => e);
    expect(getFailureSignal(error)?.error_code).toBe(FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR);
  });

  it("still uses the binding when the runtime actually installs it", async () => {
    installsBinding = true;
    cdp = new CDPClient(`ws://localhost:${port}/inspector/debug?device=0&page=1`);
    await cdp.connect();
    await cdp.addBinding("__argent_callback");

    // No fast rejection: it waits for a bindingCalled that this mock never sends,
    // so a short timeout is what times out — proving we did not disable the path.
    await expect(cdp.evaluateWithBinding("void 0", "req-2", { timeout: 150 })).rejects.toThrow(
      /timed out|timeout/i
    );
  });
});

describe("discoverMetro on a legacy/hostile Metro", () => {
  it("reports no targets when only the proxy's `don't use` page is listed", async () => {
    listBody = [
      {
        id: "0--1",
        title: "React Native Experimental (Improved Chrome Reloads)",
        description: "com.example.app",
        webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=0&page=-1`,
        vm: "don't use",
        deviceName: "kepler-device",
      },
    ];
    await expect(discoverMetro(port)).rejects.toThrow(/no CDP targets/i);
  });

  it("reports no targets when /json/list is not an array", async () => {
    // A bare JSON string has a .length, so it used to sail past the emptiness
    // check and blow up later as `candidates.filter is not a function`.
    listBody = '"oops"';
    await expect(discoverMetro(port)).rejects.toThrow(/no CDP targets/i);
  });

  it("reports no targets when /json/list is not JSON at all", async () => {
    listBody = "<html>404</html>";
    await expect(discoverMetro(port)).rejects.toThrow(/no CDP targets/i);
  });

  it("reports Metro-not-running when nothing is listening on the port", async () => {
    // Port 1 is never a Metro; fetch rejects outright.
    await expect(discoverMetro(1)).rejects.toThrow(/is not running/i);
  });
});
