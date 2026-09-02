import { describe, it, expect } from "vitest";
import {
  FAILURE_CODES,
  FailureError,
  ServiceInitializationError,
  getFailureSignal,
  type FailureSignal,
} from "@argent/registry";
import { classifyNotConnected, buildNotConnected } from "../../src/tools/debugger/not-connected";
import { expectNoForbiddenAdvice } from "../helpers/forbidden-advice";
import { pinsOnce } from "../helpers/pins";
import { discoverPrimaryPage, ensureCdpReachable } from "../../src/chromium-server/cdp-session";
import { getCandidateChromiumPorts } from "../../src/utils/chromium-discovery";
import { CDPClient } from "../../src/utils/debugger/cdp-client";
import { WebSocketServer } from "ws";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Pins EVERY entry of NOT_CONNECTED_CODE_MAP. The map is the contract that
 * turns a classified resolution failure into a structured not_connected result
 * — deleting any single entry silently reverts that code to a thrown tool
 * failure (the regression the map exists to prevent), so each row is asserted
 * individually here.
 */

function coded(
  error_code: FailureSignal["error_code"],
  message = "x",
  error_kind: FailureSignal["error_kind"] = "network"
) {
  return new FailureError(message, {
    error_code,
    failure_stage: "test_stage",
    failure_area: "tool_server",
    error_kind,
  });
}

function chromium(
  reason: "cdp_unreachable" | "runtime_unresponsive",
  code: FailureSignal["error_code"]
) {
  return buildNotConnected(reason, coded(code), { port: 8081, device_id: "chromium-cdp-9222" });
}

const MAP: Array<[FailureSignal["error_code"], string]> = [
  [FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING, "metro_not_running"],
  [FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS, "no_app_connected"],
  [FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH, "device_mismatch"],
  [FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED, "cdp_unreachable"],
  [FAILURE_CODES.DEBUGGER_CDP_SOCKET_CLOSED_BEFORE_OPEN, "cdp_unreachable"],
  [FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED, "cdp_unreachable"],
  [FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED, "cdp_unreachable"],
  [FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT, "runtime_unresponsive"],
  [FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE, "cdp_unreachable"],
  [FAILURE_CODES.CHROMIUM_CDP_INVALID_RESPONSE, "cdp_unreachable"],
  [FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET, "cdp_unreachable"],
  [FAILURE_CODES.REGISTRY_SERVICE_TERMINATING, "reconnecting"],
];

describe("classifyNotConnected code map", () => {
  it.each(MAP)("%s → %s", (code, reason) => {
    expect(classifyNotConnected(coded(code))).toBe(reason);
  });

  it("an unmapped classified code stays unclassified (rethrow path)", () => {
    expect(
      classifyNotConnected(coded(FAILURE_CODES.REGISTRY_SERVICE_INITIALIZATION_FAILED))
    ).toBeUndefined();
  });

  it("a plain Error stays unclassified (rethrow path)", () => {
    expect(classifyNotConnected(new Error("boom"))).toBeUndefined();
  });
});

describe("guidance platform-correctness", () => {
  it("chromium cdp_unreachable guidance never points at launch-app (a documented no-op on Chromium)", () => {
    const { guidance } = chromium("cdp_unreachable", FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE);
    // The Metro phrasing "Verify the app is running (launch-app)" must not
    // appear — following it on Chromium manufactures a guaranteed second
    // failure. What replaces it depends on whether the app is still up, so the
    // override names --remote-debugging-port for the case that does relaunch
    // without letting a relaunch stand as the answer to all of them.
    expect(guidance).not.toMatch(/\(launch-app\)/);
    expect(guidance).toContain("--remote-debugging-port");
    expect(guidance).toContain("launch-app starts neither");
  });

  it("Metro cdp_unreachable keeps the launch-app guidance (it IS actionable there)", () => {
    const result = buildNotConnected(
      "cdp_unreachable",
      coded(FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED),
      { port: 8081, device_id: "emulator-5554" }
    );
    expect(result.guidance).toContain("launch-app");
    expect(result.guidance).not.toContain("--remote-debugging-port");
  });
});

describe("runtime_unresponsive prices the retry it forbids", () => {
  const metro = () =>
    buildNotConnected("runtime_unresponsive", coded(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT), {
      port: 8081,
      device_id: "emulator-5554",
    });

  it("names a per-attempt cost, not one timeout", () => {
    // Measured against a stub that accepts the socket and never answers: the
    // Chromium connect path issues four enables, setFocusEmulationEnabled and the
    // viewport read in sequence and fails at 60.0s; the Metro path issues
    // FuseboxClient.setClientMetadata, ReactNativeApplication.enable and
    // Runtime.enable and fails at 30.0s. The sentence exists to price a retry, so
    // "the full timeout" — one 10s send — understates it by 3x and 6x.
    for (const { guidance } of [
      metro(),
      chromium("runtime_unresponsive", FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT),
    ]) {
      pinsOnce(guidance, "Do not retry in a loop");
      expect(guidance, "prices the attempt in seconds").toMatch(/costs about (30s|a minute)/);
      expect(guidance, "attributes the cost to the sequence, not to one send").toContain(
        "each waits out its own 10s timeout"
      );
      expect(guidance, "no instruction to loop anyway").not.toMatch(/until it (answers|connects)/);
    }
  });

  /**
   * The real request-timeout message, from a real timeout. A copy would make the
   * premise below a statement about the copy: cdp-client could reword the text
   * this guidance has to reconcile with and nothing here would go red.
   */
  async function realCdpTimeoutDetail(): Promise<string> {
    const wss = new WebSocketServer({ port: 0 });
    try {
      await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
      const { port } = wss.address() as { port: number };
      const client = new CDPClient(`ws://127.0.0.1:${port}`);
      await client.connect();
      try {
        // The server accepts the socket and never answers, so the per-request
        // timer is the only way out.
        await client.send("Runtime.enable", {}, 20);
      } catch (err) {
        return (err as Error).message;
      } finally {
        await client.disconnect();
      }
      throw new Error("expected the send to time out");
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }

  it("retires the paused branch its own detail offers", async () => {
    // The detail is the shared cdp-client timeout message, which offers a resume
    // because debugger-evaluate — awaitPromise: true — really can hang on a
    // breakpoint. The connect pipeline cannot pause, so the two ship contradicting
    // instructions in one payload unless the guidance retires the branch, not just
    // the phrase.
    const detail = await realCdpTimeoutDetail();
    for (const device_id of ["emulator-5554", "chromium-cdp-9222"]) {
      const result = buildNotConnected(
        "runtime_unresponsive",
        new FailureError(detail, {
          error_code: FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
          failure_stage: "debugger_cdp_send",
          failure_area: "tool_server",
          error_kind: "timeout",
        }),
        { port: 8081, device_id }
      );
      // The premise: the detail beside this guidance really does offer a resume.
      expect(result.detail, "the detail offers a resume").toMatch(/ask them to resume it/);
      // So the guidance must say the offer does not apply here — retiring the
      // branch, not only reconciling the "frozen, or paused at a breakpoint" phrase.
      expect(result.guidance, `${device_id}: rules the paused state out`).toMatch(
        /paused at a breakpoint does not reach this reason/
      );
      expect(result.guidance, `${device_id}: retires the detail's resume branch`).toContain(
        "ignore its resume branch"
      );
      // And offers no resume of its own: nothing in the catalogue can resume a
      // paused runtime, so a resume ask here is an instruction with no tool.
      expect(result.guidance, `${device_id}: no resume ask of its own`).not.toMatch(
        /ask (the user|them) to resume/i
      );
    }
  });

  it("claims only what timed out on Metro, and the frozen renderer on Chromium", () => {
    const { guidance } = metro();
    // What timed out on Metro is answered by the inspector, so the JS thread's
    // state is an inference this reason cannot support. The hedged form ("it is
    // likely frozen") claims it just as much.
    expect(guidance, "claims only what timed out").not.toMatch(
      /\bis (likely |probably )?frozen\b/i
    );
    pinsOnce(
      guidance,
      "What timed out is one of those inspector-answered sends, so the inspector itself " +
        "has stopped answering."
    );
    // The Metro arm may not take up its twin's platform: appended, "The same applies
    // on Chromium" points a Chromium reader at restart-app, which the gate refuses.
    expect(guidance, "the Metro arm names no Chromium remedy").not.toMatch(/chromium/i);
    // Chromium may make the stronger claim, because there the discriminator is
    // real: readViewport issues an un-awaited Runtime.evaluate, which a paused V8
    // answers and a frozen one does not (measured on Chrome 152, Debugger.paused
    // observed: every connect send answers in under 4ms).
    const { guidance: chromiumGuidance } = chromium(
      "runtime_unresponsive",
      FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT
    );
    pinsOnce(chromiumGuidance, "the renderer is frozen");
    expect(chromiumGuidance).toContain("it answers the viewport read");
  });
});

describe("both Chromium overrides carry the whole recovery", () => {
  it.each(["cdp_unreachable", "runtime_unresponsive"] as const)("%s", (reason) => {
    const code =
      reason === "cdp_unreachable"
        ? FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE
        : FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT;
    const { guidance } = chromium(reason, code);

    // The same bar the prose surfaces are held to, so a rewrite fails on the
    // advice rather than on a needle. This is where restart-app is policed: a
    // blunt substring ban would reject the negated mention the shared list
    // permits, and the cdp-client message that ships as this result's own detail
    // names the tool exactly that way.
    expectNoForbiddenAdvice(guidance, `chromium ${reason}`);

    // Both relaunch branches. An Electron app does not come back by restarting a
    // browser, and a browser restarted without the flag exposes no CDP, so a
    // surface carrying one of them strands whoever is on the other.
    pinsOnce(guidance, "boot-device with electronAppPath for an Electron app", reason);
    pinsOnce(
      guidance,
      "ask the user to start the browser again with --remote-debugging-port",
      reason
    );
    // Why the recovery is manual at all, and the instrument that cannot confirm it.
    pinsOnce(guidance, "boot-device only starts an app and never stops one", reason);
    pinsOnce(guidance, "list-devices cannot confirm the exit", reason);
    // The id churn a relaunch causes, and the escape from the one state discovery
    // cannot show: parseChromiumCdpPort reads the port straight out of the id, so a
    // browser on an unprobed port is drivable whether or not it is listed.
    pinsOnce(guidance, "A relaunch on a new port is a new id", reason);
    pinsOnce(guidance, "use chromium-cdp-<that port> straight off if the user names it", reason);
    pinsOnce(guidance, "Then retry once.", reason);

    // The order, not the wording: a relaunch-first rewrite keeps every needle
    // above while telling the reader to relaunch into a running app.
    const lower = guidance.toLowerCase();
    const quitAt = lower.indexOf("ask the user to quit it and wait for the exit");
    expect(quitAt, `${reason}: names the quit as an instruction`).toBeGreaterThan(-1);
    expect(quitAt, `${reason}: quit must precede any relaunch`).toBeLessThan(
      lower.indexOf("then boot-device with electronapppath")
    );
  });

  it("names the probe set discovery actually has, not a restated one", () => {
    // The closing clause tells the reader where the new id can be read back. A
    // literal that drifts from getCandidateChromiumPorts sends them to look on a
    // port nothing probes, so derive it: with the env list and the persisted file
    // both out of the way, what is left is the default the prose has to name.
    const prevList = process.env.ARGENT_CHROMIUM_PORTS;
    const prevFile = process.env.ARGENT_CHROMIUM_PORTS_FILE;
    delete process.env.ARGENT_CHROMIUM_PORTS;
    // Per-process: os.tmpdir() is shared across every checkout and agent on this
    // machine, so a fixed name lets someone else's leftover ports land in the
    // derived string and fail this as if the prose had drifted.
    process.env.ARGENT_CHROMIUM_PORTS_FILE = path.join(
      os.tmpdir(),
      `argent-absent-ports-${process.pid}.json`
    );
    try {
      const { guidance } = chromium("cdp_unreachable", FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE);
      pinsOnce(
        guidance,
        `list-devices probes only ${getCandidateChromiumPorts().join(", ")}, ` +
          "ARGENT_CHROMIUM_PORTS and the ports boot-device opened"
      );
      // And the env var it names is the one discovery reads - the name is prose on
      // both sides, so nothing but a round trip through the function pins it.
      process.env.ARGENT_CHROMIUM_PORTS = "9333";
      expect(getCandidateChromiumPorts()).toContain(9333);
    } finally {
      if (prevList === undefined) delete process.env.ARGENT_CHROMIUM_PORTS;
      else process.env.ARGENT_CHROMIUM_PORTS = prevList;
      if (prevFile === undefined) delete process.env.ARGENT_CHROMIUM_PORTS_FILE;
      else process.env.ARGENT_CHROMIUM_PORTS_FILE = prevFile;
    }
  });
});

describe("cdp_unreachable guidance vs the live-app codes behind it", () => {
  /** Serve one /json/list body from a throwaway CDP endpoint. */
  async function detailFor(targets: unknown[]): Promise<{ message: string; code: string }> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(targets));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const caught = await discoverPrimaryPage(port).then(
        () => undefined,
        (err: unknown) => err
      );
      // Returning the resolved case as a detail would let a throw site that
      // stopped throwing pass as one that throws something else.
      expect(caught, "expected discoverPrimaryPage to reject").toBeDefined();
      return {
        message: (caught as Error).message,
        code: String(getFailureSignal(caught)?.error_code),
      };
    } finally {
      server.close();
    }
  }

  it("routes both CHROMIUM_CDP_NO_PAGE_TARGET details away from a relaunch", async () => {
    // This code maps to cdp_unreachable, but the endpoint answered — the app is
    // alive and only lacks a window, where a relaunch adds a second copy rather
    // than recovering. It has two messages and the guidance has to catch both,
    // so drive them out of the real throw sites instead of restating them.
    const devtoolsOnly = await detailFor([
      {
        id: "1",
        type: "page",
        title: "DevTools",
        url: "devtools://devtools/bundled/inspector.html",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1",
      },
    ]);
    const noPages = await detailFor([{ id: "2", type: "service_worker", title: "sw", url: "x" }]);
    // The message and the code are one pairing: routing is keyed off the code and
    // the wording off the message, so a throw site that re-codes keeps its prose
    // while landing on a different reason.
    for (const d of [devtoolsOnly, noPages]) {
      expect(d.code).toBe(FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET);
    }

    const { guidance } = chromium("cdp_unreachable", FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET);
    // Both variants of this code are routed by the phrase they share, not by their
    // differing tails - a tail the guidance keyed on would leave the other variant
    // matching whichever arm its wording happened to resemble.
    for (const detail of [devtoolsOnly.message, noPages.message]) {
      expect(detail, "the phrase the guidance routes on must be in the detail").toContain(
        "Chromium CDP on port"
      );
    }
    // The clause that routes a live app away from a relaunch — both halves. The
    // diagnosis alone leaves the remedy free to become the relaunch this whole
    // branch exists to prevent.
    pinsOnce(
      guidance,
      "'Chromium CDP on port': the app answered and has no drivable page, so it is up and " +
        "only lacks a window. Ask the user to bring one back — chromium-tabs cannot open one " +
        "— and do not relaunch, which recovers nothing here."
    );
    // #880: that message asks about --remote-debugging-port on the port that just
    // answered the request it reports on, which is one plausible step from a
    // relaunch with a flag the app already has.
    expect(noPages.message).toMatch(/--remote-debugging-port/);
    pinsOnce(
      guidance,
      "If that detail closes by asking about --remote-debugging-port, ignore it: this port " +
        "answered, so the flag was passed."
    );

    // Only the devtools:// variant names a window - so the guidance may not tell
    // the reader to recognise the state by a window hint.
    expect(devtoolsOnly.message).toMatch(/window/i);
    expect(noPages.message, "the no-targets message gained a window hint").not.toMatch(/window/i);
  });

  it("splits on a detail phrase each throw site actually produces", async () => {
    // The reader is told to route on a phrase the detail carries, so the phrases
    // have to be the ones the throw sites emit. Restating them here would let a
    // reworded message and the guidance drift apart with the suite green, and the
    // guidance sends a whole branch to the wrong remedy when they do: the
    // DEBUGGER_CDP_* codes forward a raw ws message, so a live app whose page
    // closed mid-dial reaches the reader as "Unexpected server response: 500" -
    // a non-2xx status, and a relaunch on that id is a duplicate.
    const DISCOVERY = "Chromium CDP discovery: GET";
    const PORT_LEVEL = "Chromium CDP on port";

    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const { port: deadPort } = dead.address() as { port: number };
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const unreachable = await ensureCdpReachable(deadPort).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(unreachable, "expected a closed port to reject").toBeDefined();
    expect(String(getFailureSignal(unreachable)?.error_code)).toBe(
      FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE
    );

    const noPages = await detailFor([{ id: "1", type: "worker", title: "w", url: "x" }]);
    // A socket-level detail: reached only after discovery answered, and it names
    // neither phrase, which is what puts it in the guidance's third arm.
    const socketLevel = await new CDPClient("ws://127.0.0.1:1").send("Runtime.enable").then(
      () => undefined,
      (e: unknown) => e
    );
    expect(String(getFailureSignal(socketLevel)?.error_code)).toBe(
      FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED
    );

    for (const [what, message, phrase] of [
      ["nothing answered", (unreachable as Error).message, DISCOVERY],
      ["answered, no page", noPages.message, PORT_LEVEL],
    ] as const) {
      expect(message, `${what}: the guidance routes on this phrase`).toContain(phrase);
      // Every one of these is thrown inside the Chromium service factory, so the
      // detail the reader sees is the registry's rewrite of it. Routing worded
      // positionally ("a detail starting X") therefore matches NOTHING, and every
      // state falls into the last arm — which claims the app was up moments ago.
      const detail = new ServiceInitializationError("ChromiumCdp:chromium-cdp-9222", message)
        .message;
      expect(detail.startsWith(phrase), `${what}: service-tagged, so never at the start`).toBe(
        false
      );
      expect(detail, `${what}: still findable as a phrase`).toContain(phrase);
    }
    expect((unreachable as Error).message).toContain("could not connect");
    for (const phrase of [DISCOVERY, PORT_LEVEL]) {
      expect(
        (socketLevel as Error).message,
        "a socket-level detail must fall through both phrases"
      ).not.toContain(phrase);
    }

    const { guidance } = chromium("cdp_unreachable", FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE);
    // The three arms, each keyed on what the detail carries rather than on where
    // it carries it, and the instruction that makes them usable at all.
    pinsOnce(
      guidance,
      "Which state it is is in the detail, in a phrase it carries — a service tag opens " +
        "every detail, so read past that."
    );
    pinsOnce(guidance, `'${DISCOVERY}': the discovery request itself.`);
    pinsOnce(guidance, `'${PORT_LEVEL}': the app answered`);
    pinsOnce(
      guidance,
      "'could not connect' means nothing answered that port — consistent with an exit, not " +
        "proof of one."
    );
    // The squatter half, and its remedy: there is no port-inspecting tool, so the
    // actor is the user, and no relaunch on that port clears it.
    pinsOnce(
      guidance,
      "means something that is not CDP holds the port, which no relaunch on that port " +
        "clears: pass that on, and relaunch onto a free one."
    );
    expect(guidance, "no positional routing — the detail is service-tagged").not.toMatch(
      /detail (starting|beginning|that starts|that begins)|opening words/i
    );
    // The third arm's whole point: discovery had answered, so the app was up, and
    // the guidance may not claim which of the two states it is now in.
    pinsOnce(
      guidance,
      "Neither phrase: the socket failed after discovery had answered, so the app was up " +
        "moments ago and may have lost only the page it was driving. Have the user check it."
    );
  });
});
