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
import { pinsOnce, pinsUnqualified } from "../helpers/pins";
import { discoverPrimaryPage, ensureCdpReachable } from "../../src/chromium-server/cdp-session";
import { getCandidateChromiumPorts } from "../../src/utils/chromium-discovery";
import { CDPClient } from "../../src/utils/debugger/cdp-client";
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
    const result = buildNotConnected(
      "cdp_unreachable",
      coded(FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE),
      { port: 8081, device_id: "chromium-cdp-9222" }
    );
    // The Metro phrasing "Verify the app is running (launch-app)" must not
    // appear — following it on Chromium manufactures a guaranteed second
    // failure. What replaces it depends on whether the app is still up, so the
    // override names --remote-debugging-port for the case that does relaunch
    // without letting a relaunch stand as the answer to all of them.
    expect(result.guidance).not.toMatch(/\(launch-app\)/);
    expect(result.guidance).toContain("--remote-debugging-port");
    expect(result.guidance).toContain("launch-app cannot start a Chromium app");
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

  it("runtime_unresponsive guidance warns about the per-attempt timeout on both platforms", () => {
    const metro = buildNotConnected(
      "runtime_unresponsive",
      coded(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT),
      { port: 8081, device_id: "emulator-5554" }
    );
    const chromium = buildNotConnected(
      "runtime_unresponsive",
      coded(FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT),
      { port: 8081, device_id: "chromium-cdp-9222" }
    );
    for (const r of [metro, chromium]) {
      pinsOnce(r.guidance, "Do not retry in a loop");
      expect(r.guidance).toMatch(/timeout/);
      expect(r.guidance, "no instruction to loop anyway").not.toMatch(
        /until it (answers|connects)/
      );
    }
    // Metro cannot be in the paused state here either, and for the same reason as
    // Chromium: test/metro/paused-runtime-resolves.test.ts drives the real connect
    // pipeline against a runtime that never answers an awaited evaluate and gets
    // status "connected" back. So a resume ask here sends the user after a state
    // the result cannot be reporting.
    pinsOnce(
      metro.guidance,
      "A runtime paused at a breakpoint does not reach this reason — every send that can " +
        "time out here is answered by the inspector rather than by the JS thread, and the " +
        "two that do wait on the JS thread are both swallowed, so the session resolves and " +
        "debugger-status reports connected."
    );
    // And what that leaves as the observable. Metro has no un-swallowed send that
    // waits on the JS thread — Chromium's readViewport is the discriminator its
    // twin claims "the renderer is frozen" from — so naming the runtime's state
    // here would be an inference the timeout cannot support.
    pinsOnce(
      metro.guidance,
      "What timed out is one of those inspector-answered sends, so the inspector itself " +
        "has stopped answering."
    );
    // Two of the four un-swallowed connect sends are not enables -
    // Debugger.setPauseOnExceptions and Runtime.addBinding - and the detail beside
    // this guidance names whichever one timed out. Calling them enables contradicts
    // the detail in half the cases.
    expect(metro.guidance, "does not narrow the sends to the enables").not.toMatch(
      /one of those enables/i
    );
    // Frozen is the likeliest cause, not the observable: what timed out is answered
    // by the inspector, so the JS thread's state is an inference this reason cannot
    // support. The hedged form ("it is likely frozen") claims it just as much.
    expect(metro.guidance, "claims only what timed out").not.toMatch(
      /\bis (likely |probably )?frozen\b/i
    );
    expect(metro.guidance, "no resume ask here").not.toMatch(/resume/i);
    pinsOnce(
      metro.guidance,
      "The runtime accepted the debugger connection but did not answer within the timeout."
    );
    pinsOnce(metro.guidance, "(each attempt waits out the full timeout)");
    pinsOnce(metro.guidance, "Restart it (restart-app), then retry once.");
    // The Metro arm may not take up its twin's platform: appended, "The same applies
    // on Chromium" points a Chromium reader at restart-app, which the gate refuses.
    expect(metro.guidance, "the Metro arm names no Chromium remedy").not.toMatch(/chromium/i);
    // The detail beside BOTH of these names a breakpoint; each has to say which
    // half of its own detail applies or it contradicts itself in one response.
    for (const r of [metro, chromium])
      pinsOnce(
        r.guidance,
        'The detail says "frozen, or paused at a breakpoint" because it is the shared ' +
          "request-timeout wording, which also covers debugger-evaluate; only the frozen " +
          "half of it applies here."
      );

    // Chromium cannot be in that state here, so it gets the opposite treatment.
    // Measured on Chrome 151 with a page stopped at a breakpoint (Debugger.paused
    // observed): Page/DOM/Runtime/Accessibility.enable, setFocusEmulationEnabled
    // and readViewport's Runtime.evaluate all answer in under a millisecond, so
    // createChromiumServer resolves and debugger-status reports connected. Only a
    // frozen renderer times out those sends, and a branch for a state that never
    // arrives costs a wasted round-trip through the user.
    pinsOnce(chromium.guidance, "the renderer is frozen");
    // Through the rationale: "does not reach this reason" alone is satisfied by a
    // sentence that goes on to say it times out identically and to branch on it.
    pinsOnce(
      chromium.guidance,
      "A renderer paused at a breakpoint does not reach this reason — it answers the " +
        "viewport read, which is the one send on this path that is not swallowed, so the " +
        "session resolves and debugger-status reports connected."
    );
    // And no resume ask survives on the one state that is never paused, whoever
    // the sentence names as the actor.
    expect(chromium.guidance, "no resume ask here").not.toMatch(/resume/i);
    pinsOnce(chromium.guidance, "(each attempt waits out the full timeout)");
    pinsOnce(chromium.guidance, "Ask the user to quit the app, then relaunch once it has exited");
    // Why absence is not the exit, in the state this reason is actually in: the
    // socket opened, so the app has a page target and stays listed while it hangs.
    // The cdp_unreachable twin states the opposite mechanism for the opposite
    // reason, and a shared needle would let either one take the other's.
    pinsOnce(
      chromium.guidance,
      "a wedged app keeps its page target and stays listed, so when the entry goes it means " +
        "the window was closed just as readily as that the app exited"
    );
  });

  it("gives both Chromium overrides the whole recovery, not half of it each", () => {
    // Both route around restart-app, so each has to carry the whole recovery the
    // skill surfaces carry. Asserted in one loop: a per-reason assertion pins the
    // half it names on one override and leaves the twin free to lose it.
    for (const [reason, code] of [
      ["cdp_unreachable", FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE],
      ["runtime_unresponsive", FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT],
    ] as const) {
      const { guidance } = buildNotConnected(reason, coded(code), {
        port: 8081,
        device_id: "chromium-cdp-9222",
      });
      // The same bar the prose surfaces are held to. These two strings are the
      // highest-traffic copy of the recovery and were outside it.
      expectNoForbiddenAdvice(guidance, `chromium ${reason}`);
      pinsOnce(guidance, "ask the user to start the browser again", reason);
      pinsOnce(guidance, "same CDP port", reason);
      pinsOnce(guidance, "chromium-cdp-<port> id from boot-device / list-devices", reason);
      // boot-device never stops an app, and nothing in the catalogue can tell a
      // broken-but-running one from an exited one, so the user is the only actor
      // that can end it - and the relaunch has to wait for that, or it lands on a
      // single-instance lock.
      pinsOnce(guidance, "then relaunch once it has exited", reason);
      // The order, not the wording: the two overrides phrase the quit differently
      // (one knows the app is up, the other is reached only when nothing answers),
      // and a relaunch-first rewrite keeps every needle above while telling the
      // reader to relaunch into a running app. Positions are what rule that out.
      // Anchored on the instruction, not the word: "quit" also appears in the
      // paused branch's "quitting throws the debug session away", which sits early
      // enough to satisfy an ordering check while the actual quit moves after the
      // relaunch. Case-folded for the same reason - a sentence-initial "Relaunch"
      // is invisible to a case-sensitive search.
      const lower = guidance.toLowerCase();
      const quitAt = lower.indexOf("ask the user to quit");
      expect(quitAt, `${reason}: names the quit as an instruction`).toBeGreaterThan(-1);
      expect(quitAt, `${reason}: quit must precede any relaunch`).toBeLessThan(
        lower.indexOf("relaunch")
      );
      // The one retry-discipline clause each override has. Its twin's 'do not retry
      // in a loop' is pinned above; without this one 'retry once' can become
      // 'retry until it connects' on the reason that waits out a full timeout.
      pinsOnce(guidance, "Then retry once.", reason);
      // The way out of the one state list-devices cannot show: the id carries the
      // port, so a browser the user names is drivable whether or not it is listed.
      pinsOnce(
        guidance,
        "if the user names the port, use chromium-cdp-<that port> directly",
        reason
      );
      // Both dead ends, on both overrides. restart-app is refused by the gate and
      // launch-app is a documented no-op that reports launched: true, so either
      // one named as an action manufactures a guaranteed second failure - and a
      // per-reason negative leaves the twin free to take up the one it was not
      // checked against.
      expect(guidance, reason).not.toContain("restart-app");
      expect(guidance, reason).not.toMatch(/\(launch-app\)/);
      pinsOnce(guidance, "launch-app cannot start a Chromium app", reason);
      pinsOnce(
        guidance,
        "boot-device with electronAppPath relaunches an Electron app, and for a browser, " +
          "ask the user to start the browser again on the same CDP port with " +
          "--remote-debugging-port.",
        reason
      );
      // The premise the manual quit rests on, worded the same way the four prose
      // surfaces word it.
      pinsOnce(guidance, "only starts an app and never stops one", reason);
      // Absence of a list-devices entry is not the exit, on either reason: probePort
      // drops an app that is up with no drivable page exactly as it drops an exited
      // one. The converse reads as the more useful statement - still listed, so
      // still up - and is false in the direction the reader needs, so the claim is
      // pinned together with the mechanism that makes it actionable.
      pinsUnqualified(guidance, "list-devices cannot confirm the exit", reason);
      // The rule needs its consequence: without it a reader takes 'never recovers
      // it' for 'has no effect' and tries the relaunch anyway.
      // Through the lock outcome and what it MEANS: boot-electron keeps none of the
      // child's stderr, so this exit string is the only trace a caller gets that the
      // app survived, and read as a launch failure it invites another relaunch.
      pinsOnce(guidance, "duplicates the app or dies on its single-instance lock", reason);
      pinsOnce(guidance, "child process exited with code N before CDP was ready", reason);
      pinsOnce(
        guidance,
        "a string boot-device also emits for a launch that really failed, so it does not " +
          "tell you which happened",
        reason
      );
      // Its premise. Without it "duplicates or fails" reads as a risk worth taking.
      pinsUnqualified(guidance, "never recovers it", reason);
      // The id is re-readable only where discovery looks: getCandidateChromiumPorts
      // probes 9222, the env list and the ports boot-device opened. Without this the
      // new-port clause reads as an invitation to relaunch anywhere and re-read.
      pinsOnce(guidance, "not listed at all", reason);
      pinsOnce(
        guidance,
        "a boot-device port that has since failed a probe is dropped from that set for " +
          "good, so an id it listed once may not come back when the app does",
        reason
      );
      pinsOnce(
        guidance,
        "since the id carries the port and discovery is only how you find one you were " +
          "not told",
        reason
      );
      // The order the re-read has to happen in: before the relaunch there is no new
      // id to read.
      pinsOnce(guidance, "After a relaunch, re-read", reason);
      // The id tracks the port, so a relaunch returning on the same port keeps it.
      // A negative regex cannot hold this: it passes for every wording that does
      // not spell out the one phrase it names, the false ones included.
      pinsOnce(guidance, "a relaunch on a new port is a new id", reason);
      pinsOnce(guidance, "re-read the chromium-cdp-<port> id", reason);
      expect(guidance, `${reason}: never says to keep the dead id`).not.toMatch(
        /keep (using )?the (old )?chromium-cdp/i
      );
      // Both relaunch mechanisms, on both reasons. An Electron app does not come
      // back by restarting a browser, and a browser restarted without the flag
      // exposes no CDP at all, so a surface carrying one branch strands whoever
      // is on the other.
      pinsOnce(guidance, "boot-device with electronAppPath relaunches an Electron app", reason);
      pinsOnce(guidance, "with --remote-debugging-port", reason);
    }
  });

  it("names the probe set discovery actually has, not a restated one", () => {
    // The closing clause tells the reader where the new id can be read back. A
    // literal that drifts from getCandidateChromiumPorts sends them to look on a
    // port nothing probes, so derive it: with the env list and the persisted file
    // both out of the way, what is left is the default the prose has to name.
    const prevList = process.env.ARGENT_CHROMIUM_PORTS;
    const prevFile = process.env.ARGENT_CHROMIUM_PORTS_FILE;
    delete process.env.ARGENT_CHROMIUM_PORTS;
    process.env.ARGENT_CHROMIUM_PORTS_FILE = path.join(os.tmpdir(), "argent-absent-ports.json");
    try {
      const { guidance } = buildNotConnected(
        "cdp_unreachable",
        coded(FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE),
        { port: 8081, device_id: "chromium-cdp-9222" }
      );
      pinsOnce(
        guidance,
        `only probes ${getCandidateChromiumPorts().join(", ")}, ARGENT_CHROMIUM_PORTS and the ` +
          "ports boot-device opened"
      );
      // And the env var it names is the one discovery reads - the name is prose on
      // both sides, so nothing but a round trip through the function pins it.
      process.env.ARGENT_CHROMIUM_PORTS = "9333";
      expect(getCandidateChromiumPorts()).toContain(9333);
      pinsOnce(guidance, "ARGENT_CHROMIUM_PORTS");
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

    const { guidance } = buildNotConnected(
      "cdp_unreachable",
      coded(FAILURE_CODES.CHROMIUM_CDP_NO_PAGE_TARGET),
      { port: 8081, device_id: "chromium-cdp-9222" }
    );
    // Both variants of this code are routed by the prefix they share, not by their
    // differing tails - a tail the guidance keyed on would leave the other variant
    // matching whichever arm its wording happened to resemble.
    for (const detail of [devtoolsOnly.message, noPages.message]) {
      expect(detail, "the prefix the guidance routes on must be in the detail").toContain(
        "Chromium CDP on port"
      );
    }
    expect(guidance).toContain("Chromium CDP on port");
    // The one narrowing inside that arm, and the only detail that supports it.
    expect(devtoolsOnly.message).toContain("devtools://");
    pinsOnce(guidance, "none at all, or only devtools:// ones");
    pinsOnce(
      guidance,
      "the CDP endpoint was unreachable, answered as something other than CDP, or is up " +
        "with no usable page"
    );
    // The instruction that makes the three arms usable at all. Without it they read
    // as three descriptions and the reader picks by resemblance.
    pinsOnce(
      guidance,
      "Which one is in the detail, and the phrase it carries is the split — a service tag " +
        "opens every detail, so read past it."
    );
    // The clause that routes a live app away from a relaunch - both halves. The
    // diagnosis alone leaves the remedy free to become the relaunch this whole
    // branch exists to prevent.
    pinsOnce(
      guidance,
      "means the app answered and has no drivable page (none at all, or only devtools:// " +
        "ones): it is still running and only lacks a window, so ask the user to bring one " +
        "back — chromium-tabs cannot open one, since its own resolver needs an existing " +
        "page. If the detail carrying that phrase closes by asking about " +
        "--remote-debugging-port, ignore the question: this port answered, so the flag was " +
        "passed."
    );
    // The third state cdp_unreachable covers, and no relaunch is its remedy. Only
    // two of CHROMIUM_CDP_INVALID_RESPONSE's three throw sites can reach a
    // not_connected result - fetchJson's !res.ok and its non-JSON body; the third
    // (browserWebSocketUrl) is called only from chromium-tabs, which throws
    // instead. Naming the unreachable one gives the reader a shape to match that
    // never arrives, so the list has to track the reachable sites, not the file's.
    pinsOnce(
      guidance,
      "'failed (HTTP <status>)' or 'returned a body that is not valid JSON' means something " +
        "answered that is not a CDP endpoint, usually another service holding it"
    );
    expect(guidance, "names a shape no cdp_unreachable detail can carry").not.toContain(
      "browser socket"
    );
    // A named state with no way out is a dead end: there is no port-inspecting
    // tool, so the actor is the user, and the id is gone either way.
    pinsOnce(
      guidance,
      "In that second case pass on what the detail says, since nothing here can free a port"
    );
    // Its remedy. A squatted port named without one leaves the reader holding a
    // diagnosis and no action.
    pinsOnce(guidance, "for an Electron app boot-device takes a free port and returns the new id");
    pinsOnce(guidance, "a browser has to come back on a port nothing else holds");
    // This arm is reached only when nothing answered the port at all, so the quit
    // is a precaution rather than a diagnosis - and it still has to come first,
    // since the one case it guards against is an app that is somehow still up.
    pinsOnce(guidance, "Once the app is gone: ask the user to quit it if it is somehow still up");
    // Which half of arm 1 kills the id. A port that merely stopped answering does
    // not: the id carries the port, so the same app coming back on it resolves again.
    pinsOnce(guidance, "That id stays dead while something else holds the port");
    pinsOnce(
      guidance,
      "After 'could not connect' the port is merely unanswered, so the same id works " +
        "again if the app comes back on it."
    );
    // The precondition on the one tool named after the quit. Without it the clause
    // reads as an alternative to the quit rather than the step that follows it.
    pinsOnce(guidance, "Once it is gone, launch-app cannot start a Chromium app");
    // How the relaunch fails is per-app - a duplicate, an early exit behind
    // Electron's single-instance lock, a refusal behind Chrome's - so the
    // guidance states the rule and failure-scenarios.md carries the shapes.
    pinsOnce(guidance, "relaunching a live app never recovers it");
    // Why absence is not the exit here: nothing answered, so probePort drops this
    // app exactly as it drops a live one with no drivable page.
    pinsOnce(
      guidance,
      "it drops an app that is up with no drivable page exactly as it drops an exited one"
    );

    // Only the devtools:// variant names a window - the asymmetry
    // failure-scenarios.md's "App unreachable" row states, so a window hint added
    // here makes the row stale. Fix it there before relaxing this. (That the other
    // message asks about --remote-debugging-port on a port that just answered is
    // filed as #880.)
    expect(devtoolsOnly.message).toMatch(/window/i);
    expect(noPages.message, "the no-targets message gained a window hint").not.toMatch(/window/i);
  });

  it("splits on a detail prefix each throw site actually produces", async () => {
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
    // neither prefix, which is what puts it in the guidance's third arm.
    const socketLevel = await new CDPClient("ws://127.0.0.1:1").send("Runtime.enable").then(
      () => undefined,
      (e: unknown) => e
    );
    expect(String(getFailureSignal(socketLevel)?.error_code)).toBe(
      FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED
    );

    for (const [what, message, prefix] of [
      ["nothing answered", (unreachable as Error).message, DISCOVERY],
      ["answered, no page", noPages.message, PORT_LEVEL],
    ] as const) {
      expect(message, `${what}: the guidance routes on this phrase`).toContain(prefix);
      // Every one of these is thrown inside the Chromium service factory, so the
      // detail the reader sees is the registry's rewrite of it. Routing worded
      // positionally ("a detail starting X") therefore matches NOTHING, and every
      // state falls into the last arm — which claims the app was up moments ago.
      const detail = new ServiceInitializationError("ChromiumCdp:chromium-cdp-9222", message)
        .message;
      expect(detail.startsWith(prefix), `${what}: service-tagged, so never at the start`).toBe(
        false
      );
      expect(detail, `${what}: still findable as a phrase`).toContain(prefix);
    }
    expect((unreachable as Error).message).toContain("could not connect");
    for (const prefix of [DISCOVERY, PORT_LEVEL]) {
      expect(
        (socketLevel as Error).message,
        "a socket-level detail must fall through both prefixes"
      ).not.toContain(prefix);
    }

    const { guidance } = buildNotConnected(
      "cdp_unreachable",
      coded(FAILURE_CODES.CHROMIUM_CDP_UNREACHABLE),
      { port: 8081, device_id: "chromium-cdp-9222" }
    );
    pinsOnce(guidance, `A detail carrying '${DISCOVERY}' is the discovery request itself`);
    pinsOnce(guidance, `A detail carrying '${PORT_LEVEL}' means the app answered`);
    pinsOnce(
      guidance,
      "'could not connect' means the request never got an answer — nothing listening, or " +
        "something holding the port without answering"
    );
    expect(guidance, "no positional routing — the detail is service-tagged").not.toMatch(
      /detail (starting|beginning|that starts|that begins)|opening words/i
    );
    // The third arm's whole point: discovery had answered, so the app was up, and
    // the guidance may not claim which of the two states it is now in.
    pinsOnce(
      guidance,
      "A detail carrying neither is the CDP socket failing after discovery had already " +
        "answered, so the app was up moments ago."
    );
    // Both halves of the ambiguity, then the refusal to resolve it. Either half
    // alone lets the arm assert the state it is there to say it cannot know.
    pinsOnce(
      guidance,
      "It may have lost only the page it was driving, which the window remedy above fixes, " +
        "or exited since — nothing here tells the two apart, so have the user check."
    );
  });
});
