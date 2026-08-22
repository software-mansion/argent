import { describe, it, expect } from "vitest";
import { FAILURE_CODES, FailureError, type FailureSignal } from "@argent/registry";
import { classifyNotConnected, buildNotConnected } from "../../src/tools/debugger/not-connected";

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
    // failure. The actionable path is a relaunch with --remote-debugging-port.
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
      expect(r.guidance).toMatch(/Do not retry in a loop/);
      expect(r.guidance).toMatch(/timeout/);
    }
    expect(metro.guidance).toContain("restart-app");
    expect(chromium.guidance).not.toContain("restart-app");
    expect(chromium.guidance).toContain("electronAppPath");
  });
});

describe("guidance content", () => {
  // A crashed session's console log is reachable only through the note
  // debugger-log-registry and debugger-connect hand out, and these two strings
  // are how the answers that carry none — debugger-status', above all — send
  // the agent to the one that does.
  // Lose the clause and the answer that reports the app is gone says nothing
  // about the one artifact the crash left behind, and the agent relaunches over
  // it. An answer that IS carrying the note says so itself; that is pinned in
  // log-registry-not-connected.test.ts.
  it.each(["no_app_connected", "stale_connection"] as const)(
    "%s guidance points at the note that names the kept log",
    (reason) => {
      const { guidance } = buildNotConnected(
        reason,
        coded(FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS),
        {
          port: 8081,
          device_id: "emulator-5554",
        }
      );
      expect(guidance).toContain("debugger-log-registry");
      // Hedged, because a session that captured nothing keeps no file: guidance
      // that promises one unconditionally sends readers after a path that will
      // not be in the note.
      expect(guidance).toContain("when there is one");
    }
  );

  // And scoped to the sessions that keep one: `keepFile` is
  // `runtimeDied && captured > 0`, so an explicit teardown deletes the file
  // however much it had captured. Promising the file to every session that
  // logged sends a reader after a path no note will name.
  it("no_app_connected: promises the file only to a session whose runtime died", () => {
    const { guidance } = buildNotConnected(
      "no_app_connected",
      coded(FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS),
      { port: 8081, device_id: "emulator-5554" }
    );
    expect(guidance).toContain("whose runtime died holding console logs keeps its file");
  });

  // The same errand read from the tool that runs it. debugger-log-registry
  // reports the note itself, so this clause would send an agent holding the
  // answer back to the tool that produced it — for a note that answer either
  // already carries or has just said it does not have.
  it("no_app_connected: the answer that reports the note itself does not send the reader to fetch it", () => {
    const { guidance } = buildNotConnected(
      "no_app_connected",
      coded(FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS),
      { port: 8081, device_id: "emulator-5554" },
      { reportsOwnNote: true }
    );
    expect(guidance).not.toContain("debugger-log-registry");
    // Still the same state, and still the same recovery.
    expect(guidance).toContain("a crashed app reads as this too");
    expect(guidance).toContain("launch-app / restart-app");
  });

  // The re-target this reason asks for is the one action that changes the id the
  // next call asks under, and the record is filed under the id that was refused
  // — so the shared string has to name the tool, and the tool that carries the
  // note has to not be sent back to itself for it.
  it("device_mismatch: the shared string sends the reader to the note, its own answer does not", () => {
    const params = { port: 8081, device_id: "emulator-5554" };
    const err = coded(FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH);
    const shared = buildNotConnected("device_mismatch", err, params).guidance;
    expect(shared).toContain("read debugger-log-registry's note with this same device_id first");
    const own = buildNotConnected("device_mismatch", err, params, {
      reportsOwnNote: true,
    }).guidance;
    expect(own).not.toContain("debugger-log-registry");
    // Same refusal and same recovery from either caller.
    for (const guidance of [shared, own]) {
      expect(guidance).toContain("matched by its logicalDeviceId alone");
      expect(guidance).toContain("give the device its own Metro port");
    }
  });

  // Only the reasons whose shared string names the tool need an override, and
  // the rest must keep reading identically from either caller — an override map
  // that grew an entry by accident would fork guidance no reason needs.
  // `stale_connection` names the tool and still needs none: debugger-status
  // mints it and debugger-log-registry never emits it, so no answer that
  // carries the note ever carries this string.
  it("never sends the caller that holds the note back here for it", () => {
    // Every reason `debugger-log-registry` can emit, on both platforms: the
    // platform override is consulted before the own-note one, so a pointer
    // added to a Chromium string would reach the answer carrying the note
    // however clean the Metro column stayed - and would read as a loop, since
    // the note it names is in the same result. `stale_connection` is absent
    // because no code maps there, so this tool never emits it.
    for (const device_id of ["emulator-5554", "chromium-cdp-9222"]) {
      for (const reason of [
        "metro_not_running",
        "no_app_connected",
        "device_mismatch",
        "cdp_unreachable",
        "runtime_unresponsive",
        "reconnecting",
      ] as const) {
        const err = coded(FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING);
        const params = { port: 8081, device_id };
        expect(
          buildNotConnected(reason, err, params, { reportsOwnNote: true }).guidance
        ).not.toContain("debugger-log-registry");
      }
    }
  });

  it("every other reason reads the same from the tool that reports the note", () => {
    for (const device_id of ["emulator-5554", "chromium-cdp-9222"]) {
      const params = { port: 8081, device_id };
      for (const reason of [
        "metro_not_running",
        "runtime_unresponsive",
        "reconnecting",
        "stale_connection",
      ] as const) {
        const err = coded(FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING);
        expect(buildNotConnected(reason, err, params, { reportsOwnNote: true }).guidance).toBe(
          buildNotConnected(reason, err, params).guidance
        );
      }
    }
  });

  // The one reason both platforms reach that also has a pointer to drop, so it
  // is the only one whose guidance varies along both axes at once. On Chromium
  // it is also the ONLY reason a crashed renderer produces, which is what makes
  // the missing pointer cost the whole log rather than an ordering hint.
  it("points cdp_unreachable at the note, except in the answer that carries it", () => {
    const err = coded(FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED);
    const metro = { port: 8081, device_id: "emulator-5554" };
    const chromium = { port: 8081, device_id: "chromium-cdp-9222" };

    expect(buildNotConnected("cdp_unreachable", err, metro).guidance).toContain(
      "debugger-log-registry's note names it"
    );
    expect(buildNotConnected("cdp_unreachable", err, chromium).guidance).toContain(
      "debugger-log-registry's note names it"
    );
    // Chromium keeps its own recovery in both, rather than falling back to the
    // RN wording the caller override is written in.
    for (const opts of [undefined, { reportsOwnNote: true }]) {
      expect(buildNotConnected("cdp_unreachable", err, chromium, opts).guidance).toContain(
        "launch-app cannot start a Chromium app"
      );
    }
    // The pointer itself differs by platform, and the Chromium half is the one
    // that has to say WHY reading it first matters: its record is filed under
    // the CDP port, and boot-device draws a free one, so a relaunch that does
    // not pass the old port leaves the record answering to an id nothing will
    // ask about again. A Metro device keeps its ids across a relaunch and needs
    // no such warning.
    expect(buildNotConnected("cdp_unreachable", err, chromium).guidance).toContain(
      "relaunching on a port boot-device picks strands it"
    );
    expect(buildNotConnected("cdp_unreachable", err, metro).guidance).not.toContain(
      "boot-device picks"
    );
    // And the tool holding the record is not sent to fetch it from itself.
    for (const params of [metro, chromium]) {
      expect(
        buildNotConnected("cdp_unreachable", err, params, { reportsOwnNote: true }).guidance
      ).not.toContain("debugger-log-registry's note");
    }
  });
});
