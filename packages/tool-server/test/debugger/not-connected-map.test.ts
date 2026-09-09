import { describe, it, expect } from "vitest";
import {
  FAILURE_CODES,
  FailureError,
  ServiceInitializationError,
  getFailureSignal,
  type FailureSignal,
} from "@argent/registry";
import type { Registry } from "@argent/registry";
import { classifyNotConnected, buildNotConnected } from "../../src/tools/debugger/not-connected";
import { createRestartAppTool } from "../../src/tools/restart-app";
import { expectNoForbiddenAdvice } from "../helpers/forbidden-advice";
import { pinsOnce } from "../helpers/pins";
import {
  discoverPrimaryPage,
  ensureCdpReachable,
  listPageTargets,
} from "../../src/chromium-server/cdp-session";
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
  // readViewport runs inside createChromiumServer, so this one is thrown on the
  // ChromiumCdp resolve like the three above it - unmapped, debugger-status
  // rethrows it instead of reporting the state its description promises.
  [FAILURE_CODES.CHROMIUM_VIEWPORT_READ_FAILED, "cdp_unreachable"],
  [FAILURE_CODES.REGISTRY_SERVICE_TERMINATING, "reconnecting"],
];

/**
 * The real request-timeout message, from a real timeout. A copy would make the
 * premise below a statement about the copy: cdp-client could reword the text
 * this guidance has to reconcile with and nothing here would go red.
 */
async function realCdpTimeoutDetail(announcePause = false): Promise<string> {
  const wss = new WebSocketServer({ port: 0 });
  try {
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const { port } = wss.address() as { port: number };
    if (announcePause)
      wss.on("connection", (ws) =>
        ws.send(
          JSON.stringify({
            method: "Debugger.paused",
            params: {
              reason: "other",
              callFrames: [
                { url: "http://localhost:8081/index.bundle", location: { lineNumber: 41 } },
              ],
            },
          })
        )
      );
    const client = new CDPClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    try {
      if (announcePause) {
        // The event has to land before the timer, or this builds the other
        // branch and the assertions below pass against the wrong string.
        const deadline = Date.now() + 2_000;
        while (!client.pausedAt() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 5));
        expect(client.pausedAt(), "the mock's Debugger.paused reached the client").toBeDefined();
      }
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
    // Runtime.enable and fails at 30.0s — 20s on a proxied session, where the
    // first of those is skipped. The sentence exists to price a retry, so "the
    // full timeout" — one 10s send — understates it by 2-3x and 6x.
    // Each path runs a different number of 10s sends (Metro 3, Chromium 6), so
    // each states its own figure; one OR-regex over both let the two swap.
    for (const { guidance, cost } of [
      { guidance: metro().guidance, cost: "costs 20-30s" },
      {
        guidance: chromium("runtime_unresponsive", FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT)
          .guidance,
        cost: "costs about a minute",
      },
    ]) {
      pinsOnce(guidance, "Do not retry in a loop");
      expect(guidance, `prices this platform's attempt: ${cost}`).toContain(cost);
      expect(guidance, "attributes the cost to the sequence, not to one send").toContain(
        "each waits out its own 10s timeout"
      );
      expect(guidance, "no instruction to loop anyway").not.toMatch(/until it (answers|connects)/);
    }
    // And that each arm still ends at a remedy. Pricing the retry is only half of
    // it: with the remedy gone the reader is told what not to do and nothing to
    // do, and the Metro arm's was held by nothing.
    pinsOnce(
      metro().guidance,
      `restart it (${createRestartAppTool({} as unknown as Registry).id}) only if it is not. ` +
        `Then retry once.`
    );
    pinsOnce(
      chromium("runtime_unresponsive", FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT).guidance,
      "To relaunch: restart-app is refused on Chromium"
    );
  });

  it("answers the detail beside it, one arm per shape that detail can take", async () => {
    // buildNotConnected picks the guidance by (reason, platform) alone - it never
    // reads the error - so the two fields are reconciled by what each STRING says,
    // and the premises have to be read off the real detail rather than assumed.
    const [unpaused, paused] = await Promise.all([
      realCdpTimeoutDetail(),
      realCdpTimeoutDetail(true),
    ]);
    expect(unpaused, "the no-pause branch asks the user to choose").toMatch(
      /if it is paused, ask them to resume it/
    );
    expect(paused, "the other branch names a located pause").toContain(
      "The session reported a pause at a breakpoint at"
    );

    const metroGuidance = metro().guidance;
    const chromiumGuidance = chromium(
      "runtime_unresponsive",
      FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT
    ).guidance;

    for (const [where, guidance] of [
      ["metro", metroGuidance],
      ["chromium", chromiumGuidance],
    ] as const) {
      // Neither raises a resume of its own: nothing in the catalogue can resume a
      // paused runtime, so a resume ask here has no tool behind it.
      expect(guidance, `${where}: no resume ask of its own`).not.toMatch(
        /ask (the user|them) to resume/i
      );
    }

    // Neither arm may close that ask. On Metro it decides the restart-app; on
    // Chromium it decides the quit. Both destroy a session another debugger is
    // stopped in, and in neither arm does anything above the ask settle whether
    // the app is in one - so the sentence that told the reader to skip it is in
    // neither, and its absence is what each arm's own check below rests on.
    for (const [where, guidance] of [
      ["metro", metroGuidance],
      ["chromium", chromiumGuidance],
    ] as const)
      expect(guidance, `${where}: does not close an ask that still decides`).not.toContain(
        "so skip that"
      );

    // Only the Metro connect sends Debugger.enable, so only its detail can report
    // a pause - and there the restart has to yield to it. One restart sentence,
    // carrying the condition: a second, unconditional one appended after it is
    // the last thing a reader acts on.
    expect(metroGuidance, "the restart yields to a reported pause").toContain(
      "get it resumed and retry once before restarting anything"
    );
    expect(
      metroGuidance.match(/restart it \(restart-app\)/gi) ?? [],
      "exactly one restart instruction, and it is the conditioned one"
    ).toEqual(["restart it (restart-app)"]);
    // Conditioned on the app, not on the detail: in the branch that reaches here
    // the detail reports no pause precisely because nothing would have announced
    // one, so reading that as "not paused" is what sends the restart through.
    expect(metroGuidance, "reads the detail's silence as silence").toContain(
      "Where the detail says a pause would not have been announced, its silence is not a no"
    );
    expect(metroGuidance, "and restarts only on the answer").toContain(
      "restart it (restart-app) only if it is not"
    );

    // The Chromium arm states no pause conditional at all: its own first sentence
    // rules the state out, so a conditional on it reads as a state the reader
    // should look for.
    expect(chromiumGuidance, "no pause conditional on the arm that cannot pause").not.toMatch(
      /if the detail reports|get it resumed/i
    );
  });

  it("keeps the timeout message's Chromium sentence in step with the guidance", async () => {
    // Both ship in one not_connected payload - this message is the detail beside
    // that guidance - so a Chromium fact stated in one and contradicted or
    // dropped in the other is two procedures in one result. Held as facts rather
    // than as a shared string, because the two are written to different lengths.
    const detail = await realCdpTimeoutDetail();
    const { guidance } = chromium(
      "runtime_unresponsive",
      FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT
    );
    for (const [what, fact] of [
      // boot-device's Chromium branch dispatches on electronAppPath...
      ["the Electron branch", "boot-device with electronAppPath"],
      // ...so a browser found by port probing has no path and only the user can
      // bring it back.
      ["the browser branch", "--remote-debugging-port"],
      // The id follows the port, and neither branch guarantees a new one:
      // electronPort pins it when passed, pickFreePort may hand back the port
      // that just freed, and a browser's is whatever the user types. So the
      // sentence is conditional in both, to the word - matching on "new port"
      // alone passes an unconditional claim against a conditional one.
      ["the id churn", "A relaunch on a new port is a new id"],
    ] as const) {
      expect(detail, `the detail names ${what}`).toContain(fact);
      expect(guidance, `the guidance names ${what}`).toContain(fact);
    }
    for (const [where, text] of [
      ["detail", detail],
      ["guidance", guidance],
    ] as const)
      expect(text, `the ${where} promises no port it cannot know`).not.toMatch(
        /either way it is on a new port|(?:comes|come) back on a new port/i
      );
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
    // Chromium's discriminator is real but partial: readViewport's Runtime.evaluate
    // is answered by the inspector while the JS thread is held, so a renderer
    // ALREADY stopped resolves the session (measured on Chrome 152, Debugger.paused
    // observed: every connect send answers in under 4ms). An armed-but-unlanded
    // Debugger.pause is the exception - it lands on that same read, and the read
    // waits it out (measured, same Chrome: 10001ms). So the arm may claim the
    // first and must not turn it into a blanket "not paused": the quit it routes
    // to is what destroys the session.
    const { guidance: chromiumGuidance } = chromium(
      "runtime_unresponsive",
      FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT
    );
    pinsOnce(chromiumGuidance, "the renderer is frozen");
    expect(chromiumGuidance, "keeps the discriminator").toContain(
      "A renderer already stopped at a breakpoint answers that read"
    );
    expect(chromiumGuidance, "and names the shape it does not cover").toContain(
      "A pause another debugger armed but that has not landed yet is the exception"
    );
    expect(chromiumGuidance, "so the check happens before the quit").toContain(
      "do the detail's check before quitting anything"
    );
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
    // above while telling the reader to relaunch into a running app. Both
    // branches, or the rewrite just moves whichever one is unpinned.
    const lower = guidance.toLowerCase();
    const quitAt = lower.indexOf("ask the user to quit it and wait for the exit");
    expect(quitAt, `${reason}: names the quit as an instruction`).toBeGreaterThan(-1);
    for (const relaunch of [
      "then boot-device with electronapppath",
      "start the browser again with --remote-debugging-port",
    ]) {
      const at = lower.indexOf(relaunch);
      expect(at, `${reason}: names the relaunch "${relaunch}"`).toBeGreaterThan(-1);
      expect(quitAt, `${reason}: quit must precede "${relaunch}"`).toBeLessThan(at);
    }
  });

  it("names the probe set discovery actually has, not a restated one", async () => {
    // The closing clause tells the reader where the new id can be read back. A
    // literal that drifts from getCandidateChromiumPorts sends them to look on a
    // port nothing probes, so derive it: with the env list and the persisted file
    // both out of the way, what is left is the default the prose has to name.
    // Both copies, because they ship in one payload: the guidance and the
    // request-timeout message that is its detail.
    const detail = await realCdpTimeoutDetail();
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
      const probes =
        `list-devices probes only ${getCandidateChromiumPorts().join(", ")}, ` +
        "ARGENT_CHROMIUM_PORTS and the ports boot-device opened";
      pinsOnce(guidance, probes);
      pinsOnce(detail, probes);
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
        "— and do not relaunch onto a live app: it comes up as a second copy with a window of " +
        "its own on a different port, or dies on the single-instance lock, and neither gives " +
        "this id a page."
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
    // A socket-level detail: discovery answered and named a page, then the socket
    // to it failed - so it names neither phrase, which is what puts it in the
    // guidance's third arm. It has to come from a real failed upgrade: the ws
    // library forwards the server's own words, and that forwarded text is the
    // whole detail the reader routes on.
    const squatter = http.createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    const { port: squatterPort } = squatter.address() as { port: number };
    const socketLevel = await new CDPClient(`ws://127.0.0.1:${squatterPort}`).connect().then(
      () => undefined,
      (e: unknown) => e
    );
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
    expect(socketLevel, "expected the upgrade to be refused").toBeDefined();
    expect(
      (socketLevel as Error).message,
      "the detail is the server's own words, forwarded"
    ).toContain("Unexpected server response: 500");

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

    // The three INVALID_RESPONSE sub-phrases the same arm routes on: a reachable
    // port answering non-2xx, 200 with a body that is not JSON, and 200 with JSON
    // that is not a target list. Driven from real servers so a reword of any
    // throw site strands the guidance's squatter routing, exactly as the two
    // phrases above are guarded - and so that a throw site added without a phrase
    // is caught here rather than by a reader who gets no state at all.
    const HTTP_STATUS = "failed (HTTP";
    const NOT_JSON = "returned a body that is not valid JSON";
    const NOT_A_LIST = "did not return a target list";
    async function discoveryError(
      onVersion: (res: http.ServerResponse) => void,
      onList?: (res: http.ServerResponse) => void
    ): Promise<string> {
      const server = http.createServer((req, res) => {
        if (req.url === "/json/version") return onVersion(res);
        if (req.url === "/json/list" && onList) return onList(res);
        res.statusCode = 404;
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      const err = await (onList ? listPageTargets(port) : ensureCdpReachable(port)).then(
        () => undefined,
        (e: unknown) => e
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      expect(err, "expected the discovery probe to reject").toBeDefined();
      return (err as Error).message;
    }
    const httpFail = await discoveryError((res) => {
      res.statusCode = 500;
      res.end("boom");
    });
    const notJson = await discoveryError((res) => {
      res.setHeader("Content-Type", "application/json");
      res.end("this is not json");
    });
    expect(httpFail, "non-2xx discovery carries the sub-phrase the guidance routes on").toContain(
      HTTP_STATUS
    );
    expect(notJson, "non-JSON discovery carries the sub-phrase the guidance routes on").toContain(
      NOT_JSON
    );
    const notAList = await discoveryError(
      (res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ Browser: "SomeApi/1" }));
      },
      (res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
      }
    );
    expect(
      notAList,
      "a target list of the wrong shape carries the sub-phrase the guidance routes on"
    ).toContain(NOT_A_LIST);
    expect(classifyNotConnected(new Error(notAList)), "and it is the squatter class").toBe(
      undefined
    );

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
    pinsOnce(guidance, `'${HTTP_STATUS} <status>)'`);
    pinsOnce(guidance, `'${NOT_JSON}'`);
    pinsOnce(guidance, `'${NOT_A_LIST}'`);
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
