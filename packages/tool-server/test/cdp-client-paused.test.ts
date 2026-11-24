import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { CDPClient } from "../src/utils/debugger/cdp-client";

/**
 * Argent sets no breakpoints, so a stopped runtime means another debugger
 * sharing it did. That only became reachable once a provider could hand Argent
 * a socket into a session it already owns.
 *
 * Without this, every tool reports `CDP request … timed out`, which reads as a
 * broken app.
 */

interface FakeRuntime {
  close: () => Promise<void>;
  /** Announce a script, so its id can be resolved back to a url. */
  parseScript: (scriptId: string, url: string) => void;
  /** Push a `Debugger.paused` at a fixed location, as a breakpoint would. */
  pause: (reason?: string) => void;
  /** Pause the way Hermes does: a scriptId, and no `url` on the frame. */
  pauseByScriptId: (scriptId: string) => void;
  /**
   * Pause the way an eval'd `debugger` does: a synthetic top frame with an
   * empty url and an unannounced script, above the real frame in the bundle.
   */
  pauseWithSyntheticTopFrame: (appScriptId: string) => void;
  /** Every method the client actually put on the wire. */
  received: string[];
  resume: () => void;
  url: string;
}

function startRuntime(): Promise<FakeRuntime> {
  return new Promise((resolve) => {
    const received: string[] = [];
    let socket: WebSocket | undefined;

    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
      const address = wss.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const emit = (method: string, params: Record<string, unknown>) =>
        socket?.send(JSON.stringify({ method, params }));

      resolve({
        close: () => new Promise<void>((r) => wss.close(() => r())),
        parseScript: (scriptId: string, url: string) =>
          emit("Debugger.scriptParsed", { endLine: 100, scriptId, startLine: 0, url }),
        pause: (reason = "other") =>
          emit("Debugger.paused", {
            callFrames: [{ location: { lineNumber: 41 }, url: "app:///src/App.tsx" }],
            reason,
          }),
        pauseByScriptId: (scriptId: string) =>
          emit("Debugger.paused", {
            callFrames: [{ location: { lineNumber: 41, scriptId } }],
            reason: "other",
          }),
        pauseWithSyntheticTopFrame: (appScriptId: string) =>
          emit("Debugger.paused", {
            callFrames: [
              { location: { columnNumber: 23, lineNumber: 0, scriptId: "41" }, url: "" },
              { location: { columnNumber: 49, lineNumber: 31632, scriptId: appScriptId } },
            ],
            reason: "other",
          }),
        received,
        resume: () => emit("Debugger.resumed", {}),
        url: `ws://127.0.0.1:${port}/devtools/page/1`,
      });
    });

    wss.on("connection", (sock) => {
      socket = sock;

      sock.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        received.push(message.method);
        sock.send(JSON.stringify({ id: message.id, result: {} }));
      });
    });
  });
}

/** Give an emitted event a turn to land before asserting on it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("CDPClient against a runtime someone else paused", () => {
  it("refuses to evaluate, naming the location and who can clear it", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    runtime.pause();
    await settle();

    await expect(cdp.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow(
      /paused at a breakpoint at app:\/\/\/src\/App\.tsx:42.*does not set breakpoints/s
    );

    /** Never reached the wire. A stopped runtime would simply not have answered. */
    expect(runtime.received).not.toContain("Runtime.evaluate");

    await cdp.disconnect();
    await runtime.close();
  });

  /**
   * Hermes leaves `url` off the call frame and identifies the script by id, so
   * reading `url` alone loses the location on the one runtime this is for.
   */
  it("resolves a location from a scriptId when the frame carries no url", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    runtime.parseScript("7", "app:///src/Screen.tsx");
    await settle();

    runtime.pauseByScriptId("7");
    await settle();

    expect(cdp.pausedAt()).toEqual({ location: "app:///src/Screen.tsx:42", reason: "other" });
    await expect(cdp.send("Runtime.evaluate", {})).rejects.toThrow(/app:\/\/\/src\/Screen\.tsx:42/);

    await cdp.disconnect();
    await runtime.close();
  });

  /**
   * Hermes puts the eval'd frame on top, with an empty url and a script
   * nothing announced, above the real frame in the bundle. Reading only the
   * top frame reports no location at all.
   */
  it("skips a synthetic top frame to reach the app's own code", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    runtime.parseScript("6", "http://localhost:8081/index.bundle");
    await settle();

    runtime.pauseWithSyntheticTopFrame("6");
    await settle();

    expect(cdp.pausedAt()).toEqual({
      location: "http://localhost:8081/index.bundle:31633",
      reason: "other",
    });

    await cdp.disconnect();
    await runtime.close();
  });

  /**
   * A provider replaying a pause to a client that attached mid-stop delivers
   * it before `Debugger.enable` has re-announced the scripts. Resolving on
   * arrival would find an empty map and lose the location.
   */
  it("resolves the location against scripts announced after the pause", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    /** Pause first, script afterwards: the order a late-joining client sees. */
    runtime.pauseWithSyntheticTopFrame("6");
    await settle();
    expect(cdp.pausedAt()).toEqual({ reason: "other" });

    runtime.parseScript("6", "http://localhost:8081/index.bundle");
    await settle();

    expect(cdp.pausedAt()).toEqual({
      location: "http://localhost:8081/index.bundle:31633",
      reason: "other",
    });

    await cdp.disconnect();
    await runtime.close();
  });

  /**
   * The url Metro serves a bundle from. Its build configuration is most of the
   * length and none of the meaning.
   */
  it("drops Metro's build configuration from the reported location", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    runtime.parseScript(
      "6",
      "http://localhost:53548/index.bundle//&platform=ios&dev=true&hot=false&lazy=true" +
        "&transform.engine=hermes&transform.bytecode=1&unstable_transformProfile=hermes-stable"
    );
    await settle();

    runtime.pauseWithSyntheticTopFrame("6");
    await settle();

    expect(cdp.pausedAt()).toEqual({
      location: "http://localhost:53548/index.bundle:31633",
      reason: "other",
    });

    await cdp.disconnect();
    await runtime.close();
  });

  it("still refuses when the script behind the frame was never announced", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    runtime.pauseByScriptId("unknown-script");
    await settle();

    /** No location to give, but the refusal itself must not depend on having one. */
    expect(cdp.pausedAt()).toEqual({ reason: "other" });
    await expect(cdp.send("Runtime.evaluate", {})).rejects.toThrow(/paused at a breakpoint/);

    await cdp.disconnect();
    await runtime.close();
  });

  it("says so differently when it stopped on an exception", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    runtime.pause("exception");
    await settle();

    await expect(cdp.send("Runtime.evaluate", {})).rejects.toThrow(/paused on an exception/);

    await cdp.disconnect();
    await runtime.close();
  });

  /** Guarding everything would break the calls that recover the session. */
  it("still passes through the calls a paused runtime does answer", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    runtime.pause();
    await settle();

    await expect(cdp.send("Debugger.resume")).resolves.toEqual({});
    await expect(cdp.send("Debugger.removeBreakpoint", { breakpointId: "1" })).resolves.toEqual({});
    expect(runtime.received).toContain("Debugger.resume");

    await cdp.disconnect();
    await runtime.close();
  });

  it("evaluates again once the runtime resumes", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    runtime.pause();
    await settle();
    expect(cdp.pausedAt()).toEqual({ location: "app:///src/App.tsx:42", reason: "other" });

    runtime.resume();
    await settle();
    expect(cdp.pausedAt()).toBeUndefined();

    await expect(cdp.send("Runtime.evaluate", {})).resolves.toEqual({});

    await cdp.disconnect();
    await runtime.close();
  });

  it("does not carry a stale pause across a reconnect", async () => {
    const first = await startRuntime();
    const second = await startRuntime();
    const cdp = new CDPClient(first.url, { sendOrigin: false });
    await cdp.connect();

    first.pause();
    await settle();
    expect(cdp.pausedAt()).toBeDefined();

    await cdp.reconnect(second.url);

    expect(cdp.pausedAt()).toBeUndefined();
    await expect(cdp.send("Runtime.evaluate", {})).resolves.toEqual({});

    await cdp.disconnect();
    await first.close();
    await second.close();
  });

  it("leaves a running runtime alone", async () => {
    const runtime = await startRuntime();
    const cdp = new CDPClient(runtime.url, { sendOrigin: false });
    await cdp.connect();

    expect(cdp.pausedAt()).toBeUndefined();
    await expect(cdp.send("Runtime.evaluate", {})).resolves.toEqual({});

    await cdp.disconnect();
    await runtime.close();
  });
});
