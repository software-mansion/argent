import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import { createRestartAppTool } from "../../src/tools/restart-app";
import { createDebuggerStatusTool } from "../../src/tools/debugger/debugger-status";
import { expectNoForbiddenAdvice } from "../helpers/forbidden-advice";
import { pinsOnce } from "../helpers/pins";
import { platformTag } from "../helpers/platform-tag";
import { CDPClient } from "../../src/utils/debugger/cdp-client";

const debuggerStatusTool = createDebuggerStatusTool({} as unknown as Registry);

let wss: WebSocketServer;
let port: number;
let serverWs: WebSocket | null = null;

beforeEach(async () => {
  serverWs = null;
  await new Promise<void>((resolve) => {
    wss = new WebSocketServer({ port: 0 }, () => {
      port = (wss.address() as { port: number }).port;
      resolve();
    });
  });
  wss.on("connection", (ws) => {
    serverWs = ws;
  });
});

afterEach(async () => {
  if (serverWs) serverWs.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

function waitForServer(): Promise<WebSocket> {
  return new Promise((resolve) => {
    if (serverWs) return resolve(serverWs);
    wss.once("connection", (ws) => resolve(ws));
  });
}

describe("CDPClient", () => {
  it("reports the pause it was told about when a send times out", async () => {
    // The send-time guard covers Runtime.evaluate and Runtime.callFunctionOn
    // only, and on a shared session the pause can arrive after the send — so the
    // message has to read pausedAt() when it is built, not when the send was
    // queued. Runtime.enable is deliberately outside the guard.
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connected = client.connect();
    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(String(raw)) as { id: number; method: string };
      if (method !== "Runtime.enable") ws.send(JSON.stringify({ id, result: {} }));
    });
    await connected;

    const pending = rejection(client.send("Runtime.enable", {}, 300));
    // The user's own debugger stops the runtime after the send is on the wire.
    ws.send(
      JSON.stringify({
        method: "Debugger.paused",
        params: {
          reason: "other",
          callFrames: [{ url: "http://localhost:8081/index.bundle", location: { lineNumber: 41 } }],
        },
      })
    );
    const err = (await pending) as Error;

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
    });
    expect(err.message, "names the pause and where").toContain(
      "The session reported a pause at a breakpoint at http://localhost:8081/index.bundle:42"
    );
    // Runtime.enable is answered by the inspector, so the pause is real and is
    // still not the explanation. Claiming it is sends the reader to a resume that
    // changes nothing while the inspector stays silent.
    expect(err.message, "does not blame the pause for an inspector-answered send").toContain(
      "Runtime.enable is answered by the inspector rather than that thread, so the pause " +
        "does not explain this one"
    );
    expect(err.message, "and does not deny the pause it was told about").not.toContain(
      "Debugger is not enabled on this session"
    );
    // The remedy the pause makes wrong. The bar is the whole message, not this
    // sentence: an unconditional "if it is hung, restart it" appended after the
    // branch is the last instruction a reader acts on, and it undoes the branch.
    expect(err.message, "does not send a paused runtime to a restart").toContain(
      "Do not restart the app: that throws away the debug session they are stopped in."
    );
    expect(err.message, "and offers no restart anywhere on this branch").not.toMatch(
      /get the app restarted|restart-app/i
    );
    await client.disconnect();
  });

  it("blames the pause for a send that does run on the stopped thread", async () => {
    // The other arm of the same sentence. The send-time guard misses exactly this
    // case - the pause lands after the send is on the wire - so a blocked method
    // does reach the timeout, and there the pause IS the explanation.
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connected = client.connect();
    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(String(raw)) as { id: number; method: string };
      if (method !== "Runtime.evaluate") ws.send(JSON.stringify({ id, result: {} }));
    });
    await connected;

    const pending = rejection(client.send("Runtime.evaluate", { expression: "1" }, 300));
    ws.send(
      JSON.stringify({
        method: "Debugger.paused",
        params: { reason: "exception", callFrames: [{ url: "http://a/b.js" }] },
      })
    );
    const err = (await pending) as Error;

    expect(err.message, "names the pause and its reason").toContain(
      "The session reported a pause on an exception at http://a/b.js"
    );
    expect(err.message, "and blames it, because this send needs that thread").toContain(
      "Runtime.evaluate runs on the thread it stopped, so that is what this is."
    );
    expect(err.message, "so it does not hand back the inspector wording").not.toContain(
      "answered by the inspector"
    );
    await client.disconnect();
  });

  it("appends no line when the frame's is out of range", async () => {
    // JSON has no Infinity literal but it has 1e400, which parses to one - so a
    // number that is not a line is what a peer can put on the wire, and it is the
    // only shape of it that survives JSON.stringify to get here.
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connected = client.connect();
    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(String(raw)) as { id: number; method: string };
      if (method !== "Runtime.enable") ws.send(JSON.stringify({ id, result: {} }));
    });
    await connected;

    const pending = rejection(client.send("Runtime.enable", {}, 300));
    ws.send(
      '{"method":"Debugger.paused","params":{"reason":"other","callFrames":' +
        '[{"url":"http://a/b","location":{"lineNumber":1e400}}]}}'
    );
    const err = (await pending) as Error;

    expect(err.message, "names the file").toContain("pause at a breakpoint at http://a/b,");
    expect(err.message, "and no line").not.toMatch(/http:\/\/a\/b:/);
    await client.disconnect();
  });

  it("files no script under an id it could not read", async () => {
    // Both consumers of the map key on the id, so a placeholder for the ones that
    // have none makes every such script the same script - and a frame carrying
    // that placeholder reads back whichever landed last, naming a file the pause
    // is not in.
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connected = client.connect();
    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(String(raw)) as { id: number; method: string };
      if (method !== "Runtime.enable") ws.send(JSON.stringify({ id, result: {} }));
    });
    await connected;
    ws.send(
      JSON.stringify({
        method: "Debugger.scriptParsed",
        params: { scriptId: 7, url: "http://a/unrelated.js" },
      })
    );

    const pending = rejection(client.send("Runtime.enable", {}, 300));
    ws.send(
      JSON.stringify({
        method: "Debugger.paused",
        params: { reason: "other", callFrames: [{ location: { scriptId: "", lineNumber: 3 } }] },
      })
    );
    const err = (await pending) as Error;

    expect(err.message, "reports the pause with no place").toContain(
      "The session reported a pause at a breakpoint,"
    );
    expect(err.message, "and never the file it is not in").not.toContain("unrelated.js");
    expect(client.getLoadedScripts().size, "and nothing was filed").toBe(0);
    await client.disconnect();
  });

  // The payload is another debugger's, and pausedAt() walks it from the request
  // timer - where a throw is an uncaught exception rather than one rejected send,
  // so a malformed frame list takes the process down instead of one call. A
  // number is not iterable; a null element is iterable and then dereferenced.
  it.each([
    ["a non-iterable callFrames", 42, ""],
    ["a null frame", [null], ""],
    ["a non-string url", [{ url: 42 }], ""],
    ["an object url", [{ url: {} }], ""],
    // The one shape that still yields a place: the url is a string, so it is
    // named - and the line is not a number, so no line is appended to it. The
    // un-checked form reads "http://a/b:71", a line that is not in the file.
    [
      "a non-numeric lineNumber",
      [{ url: "http://a/b", location: { lineNumber: "7" } }],
      " at http://a/b",
    ],
  ])("survives %s on Debugger.paused", async (_what, callFrames, where) => {
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connected = client.connect();
    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(String(raw)) as { id: number; method: string };
      if (method !== "Runtime.enable") ws.send(JSON.stringify({ id, result: {} }));
    });
    await connected;

    const pending = rejection(client.send("Runtime.enable", {}, 300));
    ws.send(JSON.stringify({ method: "Debugger.paused", params: { reason: "other", callFrames } }));
    const err = (await pending) as Error;

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
    });
    // Still reports the pause, and offers exactly the part of the location every
    // field it is built from was the type it is read as.
    expect(err.message, "names the pause").toContain(
      `The session reported a pause at a breakpoint${where},`
    );
    expect(err.message, "and appends no line it could not read").not.toMatch(/http:\/\/a\/b:/);
    await client.disconnect();
  });

  it("survives a scriptParsed url that is not a string", async () => {
    // The frame walk's other input: Hermes leaves the frame's own url empty and
    // names the script by id, so the map is what gets split - and it is filled
    // from the same shared socket as the pause.
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connected = client.connect();
    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(String(raw)) as { id: number; method: string };
      if (method !== "Runtime.enable") ws.send(JSON.stringify({ id, result: {} }));
    });
    await connected;
    ws.send(
      JSON.stringify({
        method: "Debugger.scriptParsed",
        params: { scriptId: "7", url: 42, sourceMapURL: 5, startLine: "x", endLine: "y" },
      })
    );

    const pending = rejection(client.send("Runtime.enable", {}, 300));
    ws.send(
      JSON.stringify({
        method: "Debugger.paused",
        params: { reason: "other", callFrames: [{ location: { scriptId: "7", lineNumber: 0 } }] },
      })
    );
    const err = (await pending) as Error;

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
    });
    expect(err.message, "names the pause, with no place it could not read").toContain(
      "The session reported a pause at a breakpoint,"
    );
    // And the map holds what its type says for every field, not just the one the
    // walk reads: registerFromScriptParsed takes sourceMapURL as a string it
    // never checks, and ScriptInfo's line numbers are declared numbers.
    const stored = client.getLoadedScripts().get("7")!;
    expect(stored, "the script was stored under its id").toBeDefined();
    for (const [field, type] of [
      ["scriptId", "string"],
      ["url", "string"],
      ["startLine", "number"],
      ["endLine", "number"],
    ] as const)
      expect(typeof stored[field], `${field} is stored as a ${type}`).toBe(type);
    expect(stored.sourceMapURL, "a non-string sourceMapURL is dropped").toBeUndefined();
    await client.disconnect();
  });

  it("reads the enables that were answered, not the platform, when nothing paused", async () => {
    // Debugger.enable is sent late in the Metro connect and never on Chromium, so
    // "Metro enables it" is not true of a connect that is timing out. What the
    // hedge turns on is whether a pause WOULD have been announced, which is
    // exactly the set of enables that came back.
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connected = client.connect();
    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const { id, method } = JSON.parse(String(raw)) as { id: number; method: string };
      if (method !== "Runtime.enable") ws.send(JSON.stringify({ id, result: {} }));
    });
    await connected;
    await client.send("Debugger.enable", {}, 300);

    const err = (await rejection(client.send("Runtime.enable", {}, 300))) as Error;

    expect(err.message, "the absence of a pause is evidence here").toContain(
      "Debugger is enabled on this session, so a pause would have been announced and none " +
        "was: it is frozen, not stopped."
    );
    expect(err.message, "so it does not hedge").not.toContain(
      "Debugger is not enabled on this session"
    );
    await client.disconnect();
  });

  /**
   * The other half of the pause handling: what send() refuses up front. The two
   * are one contract - a method inside BLOCKED_WHILE_PAUSED never reaches the
   * timer, so every paused timeout is a method outside it - and the timeout
   * message states that split, so both are held behaviourally.
   */
  it("refuses Runtime.evaluate while paused instead of timing it out", async () => {
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    const connected = client.connect();
    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const { id } = JSON.parse(String(raw)) as { id: number };
      ws.send(JSON.stringify({ id, result: {} }));
    });
    await connected;

    ws.send(
      JSON.stringify({
        method: "Debugger.paused",
        params: {
          reason: "other",
          callFrames: [{ url: "http://localhost:8081/index.bundle", location: { lineNumber: 41 } }],
        },
      })
    );
    await new Promise<void>((resolve) => client.events.on("paused", () => resolve()));

    // The mock answers everything, so with the guard gone this send RESOLVES:
    // the discriminator is reject-vs-resolve, and the generous timeout only
    // keeps a slow machine from turning a pass into a timeout.
    const err = await rejection(client.send("Runtime.evaluate", { expression: "1" }, 5_000));
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.JS_RUNTIME_PAUSED,
    });
    expect((err as Error).message).toContain(
      "paused at a breakpoint at http://localhost:8081/index.bundle:42"
    );
    await client.disconnect();
  });

  it("connects and disconnects", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it("sends a command and receives response", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          id: msg.id,
          result: { debuggerId: "test-id" },
        })
      );
    });

    const result = await client.send("Runtime.enable");
    expect(result).toEqual({ debuggerId: "test-id" });
    expect(client.getEnabledDomains().has("Runtime")).toBe(true);
    await client.disconnect();
  });

  it("tracks enabled domains", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
    });

    await client.send("Debugger.enable");
    expect(client.getEnabledDomains().has("Debugger")).toBe(true);

    await client.send("Debugger.disable");
    expect(client.getEnabledDomains().has("Debugger")).toBe(false);

    await client.disconnect();
  });

  it("accumulates scriptParsed events", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ id: msg.id, result: {} }));
      ws.send(
        JSON.stringify({
          method: "Debugger.scriptParsed",
          params: {
            scriptId: "42",
            url: "http://localhost:8081/index.bundle",
            startLine: 0,
            endLine: 9999,
          },
        })
      );
    });

    await client.send("Debugger.enable");
    await new Promise((r) => setTimeout(r, 50));

    const scripts = client.getLoadedScripts();
    expect(scripts.has("42")).toBe(true);
    expect(scripts.get("42")!.url).toContain("index.bundle");

    await client.disconnect();
  });

  it("handles CDP errors", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      ws.send(
        JSON.stringify({
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        })
      );
    });

    await expect(client.send("Nonexistent.method")).rejects.toThrow("Method not found");
    await client.disconnect();
  });

  it("emits disconnected on server close", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const disconnected = new Promise<void>((resolve) => {
      client.events.on("disconnected", () => resolve());
    });

    const ws = await waitForServer();
    ws.close();

    await disconnected;
    expect(client.isConnected()).toBe(false);
  });

  it("evaluateWithBinding matches by requestId", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.evaluate") {
        ws.send(JSON.stringify({ id: msg.id, result: { result: { value: "ok" } } }));
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              method: "Runtime.bindingCalled",
              params: {
                name: "__argent_callback",
                payload: JSON.stringify({
                  requestId: "req-123",
                  type: "inspect_result",
                  data: "test",
                }),
              },
            })
          );
        }, 10);
      }
    });

    const result = await client.evaluateWithBinding("someScript()", "req-123", { timeout: 5000 });

    expect(result.requestId).toBe("req-123");
    expect(result.type).toBe("inspect_result");
    expect(result.data).toBe("test");

    await client.disconnect();
  });

  it("evaluate requests returnByValue + awaitPromise and returns object results", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    let evalParams: Record<string, unknown> | undefined;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.evaluate") {
        evalParams = msg.params;
        // A returnByValue response carries the deep-serialized value. Without
        // returnByValue, Hermes/V8 return a RemoteObject ref with no `value`,
        // which is exactly the dropped-object bug this guards against.
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: { result: { type: "object", value: { a: 1, b: [2, 3] } } },
          })
        );
      }
    });

    const value = await client.evaluate("({ a: 1, b: [2, 3] })");

    expect(evalParams?.returnByValue).toBe(true);
    expect(evalParams?.awaitPromise).toBe(true);
    expect(value).toEqual({ a: 1, b: [2, 3] });

    await client.disconnect();
  });

  it("evaluateWithBinding drives the script with returnByValue + awaitPromise off", async () => {
    const client = new CDPClient(`ws://localhost:${port}`);
    await client.connect();

    const ws = await waitForServer();
    let evalParams: Record<string, unknown> | undefined;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Runtime.evaluate") {
        evalParams = msg.params;
        ws.send(JSON.stringify({ id: msg.id, result: { result: { value: "ok" } } }));
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              method: "Runtime.bindingCalled",
              params: {
                name: "__argent_callback",
                payload: JSON.stringify({ requestId: "req-1", data: "x" }),
              },
            })
          );
        }, 10);
      }
    });

    await client.evaluateWithBinding("someScript()", "req-1", { timeout: 5000 });

    // The binding delivers the payload; the script's own return must not be
    // serialized or awaited, or fire-and-forget binding scripts would hang.
    expect(evalParams?.returnByValue).toBe(false);
    expect(evalParams?.awaitPromise).toBe(false);

    await client.disconnect();
  });

  // Failure-signal classification: each CDP transport fault must carry its own
  // precise code instead of surfacing as an unclassified plain Error (which
  // telemetry buckets under REGISTRY_SERVICE_INITIALIZATION_FAILED / unknown).
  describe("failure signal classification", () => {
    it("send before connect rejects with DEBUGGER_CDP_NOT_CONNECTED", async () => {
      const client = new CDPClient(`ws://localhost:${port}`);
      // never connect()ed
      const err = await rejection(client.send("Runtime.enable"));
      expect((err as Error).message).toBe("CDP not connected");
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED,
        failure_stage: "debugger_cdp_send",
        error_kind: "network",
      });
    });

    it("an unanswered request rejects with DEBUGGER_CDP_REQUEST_TIMEOUT", async () => {
      const client = new CDPClient(`ws://localhost:${port}`);
      await client.connect();
      // The server never replies — the per-request timer must fire.
      const err = await rejection(client.send("Runtime.enable", {}, 50));
      expect((err as Error).message).toMatch(/CDP request Runtime\.enable \(id=\d+\) timed out/);
      const message = (err as Error).message;
      // The third runtime string, held to the same bar as the two
      // CHROMIUM_GUIDANCE ones. It is the only text a paused Chromium renderer
      // ever reaches: the socket stays OPEN, so debugger-status answers
      // "connected" and the branching guidance is never emitted.
      expectNoForbiddenAdvice(message, "the CDP request-timeout message");
      // The diagnosis itself. Both remedies below are chosen off "reachable but not
      // answering"; a message that instead reports the runtime as gone sends the
      // reader straight past them to a relaunch.
      pinsOnce(
        message,
        "the runtime accepted the connection but did not answer. Do not retry in a loop."
      );
      // This mock answers nothing, so no enable was ever acknowledged. That is the
      // branch that has to hedge: with Debugger off, no pause would have been
      // announced whether or not there is one, so the absence is not evidence.
      pinsOnce(
        message,
        "Debugger is not enabled on this session, so nothing here would have announced a " +
          "pause and its absence rules nothing out."
      );
      pinsOnce(
        message,
        "if it is paused, ask them to resume it, because quitting throws the debug session away."
      );
      // Wording the branch above disproves: pausedError names the breakpoint and
      // its location, and the paused branch of this same message names it too.
      expect(message, "does not deny that pausedness is ever reported").not.toMatch(
        /no tool reports pausedness/i
      );
      // The connect surface carries this message as the detail of a not_connected
      // result, so a claim that debugger-status would answer "connected" is
      // contradicted by the payload carrying it. Both verbs, because only one of
      // them ever shipped and a pin on that one moves with a reword.
      expect(message, "does not promise connected on the connect surface").not.toMatch(
        /debugger-status (says|reports) "connected" either way/i
      );
      expect(message, "states no unscoped debugger-status claim").not.toMatch(
        /debugger-status can still report "connected" in this state/
      );
      // The fact itself is still true of the OTHER timeout this message serves -
      // one on an established session, where nothing says not_connected - so it
      // has to be somewhere. Its home is the tool whose answer misleads, where it
      // reads correctly on both surfaces.
      pinsOnce(
        debuggerStatusTool.description,
        `A ${FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT} from another debugger tool does not ` +
          `move this answer: the check is the socket, and a runtime that hangs behind an open ` +
          `one still reports "connected".`
      );
      // Both ends of the retry discipline. Each attempt waits out this full timeout,
      // so a loosened "unless it looks slow" at one end or a "retry until it answers"
      // at the other undoes the reason the guidance is in the message at all.
      pinsOnce(message, "Do not retry in a loop. Debugger is not enabled on this session");
      // Where the Chromium recovery lives. This message states the two facts an
      // agent acts on from here - restart-app is refused, and the quit is the
      // user's - rather than a relaunch procedure that has to stay in step with
      // two guidance strings and four prose surfaces.
      const restartApp = createRestartAppTool({} as unknown as Registry).capability;
      // Derived from restart-app's own capability, not restated: the same tag on the
      // skill rows is built this way, and a literal here drifts off it silently.
      pinsOnce(
        message,
        `If it is hung, get the app restarted: restart-app on ${platformTag(restartApp)}.`
      );
      // Both relaunch branches and the id churn, the three facts CHROMIUM_GUIDANCE
      // carries: boot-device's Chromium branch dispatches on electronAppPath, so
      // it cannot bring a browser back; and the id follows the port, which the
      // relaunch may or may not change - electronPort pins it when passed, and a
      // browser's is whatever the user types.
      pinsOnce(
        message,
        "On Chromium restart-app is refused, so the quit is the user's and the relaunch " +
          "waits for the exit: boot-device with electronAppPath brings an Electron app " +
          "back, a browser only comes back if the user starts it again with " +
          "--remote-debugging-port."
      );
      // Conditional, the way the guidance beside it states it: an unconditional
      // "it comes back on a new port" sends the reader to discard an id that is
      // still right, and to hunt for one on a port list-devices does not probe.
      pinsOnce(message, "A relaunch on a new port is a new id");
      // And the way out of the set it just named: a browser the user restarts
      // themselves is never tracked - trackChromiumPort has one caller, the
      // Electron boot - so on that branch the port only ever comes from them.
      pinsOnce(message, "take the port from the user if they name one");
      expect(message, "claims no new port it cannot know about").not.toMatch(
        /either way it is on a new port|comes back on a new port/i
      );
      // And does not hand the recovery to debugger-status, which is the one tool
      // that cannot give it: a post-connect hang leaves the socket OPEN, so it
      // returns status "connected" with no guidance field at all.
      expect(message, "does not route the recovery through debugger-status").not.toMatch(
        /debugger-status for the recovery/i
      );
      pinsOnce(message, "Then reconnect and retry once.");
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
        failure_stage: "debugger_cdp_send",
        error_kind: "timeout",
      });
      await client.disconnect();
    });

    it("server close mid-request rejects the pending send with DEBUGGER_CDP_CONNECTION_CLOSED", async () => {
      const client = new CDPClient(`ws://localhost:${port}`);
      await client.connect();
      const ws = await waitForServer();
      ws.on("message", () => ws.close());
      const err = await rejection(client.send("Runtime.enable"));
      expect((err as Error).message).toBe("CDP connection closed");
      expect(getFailureSignal(err)).toMatchObject({
        error_code: FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED,
        failure_stage: "debugger_cdp_lifecycle",
        error_kind: "network",
      });
    });

    it("connect to a dead port rejects with a classified connect-stage code", async () => {
      // Grab a port nothing listens on: bind an ephemeral server, then close it.
      const deadPort = await new Promise<number>((resolve) => {
        const probe = new WebSocketServer({ port: 0 }, () => {
          const p = (probe.address() as { port: number }).port;
          probe.close(() => resolve(p));
        });
      });
      const client = new CDPClient(`ws://localhost:${deadPort}`);
      const err = await rejection(client.connect());
      const signal = getFailureSignal(err);
      // ECONNREFUSED surfaces via the error handler (CONNECT_FAILED); some
      // stacks deliver only a close (SOCKET_CLOSED_BEFORE_OPEN). Either way the
      // stage must be the connect stage and the kind network.
      expect([
        FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED,
        FAILURE_CODES.DEBUGGER_CDP_SOCKET_CLOSED_BEFORE_OPEN,
      ]).toContain(signal?.error_code);
      expect(signal).toMatchObject({
        failure_stage: "debugger_cdp_connect",
        error_kind: "network",
      });
    });
  });
});
