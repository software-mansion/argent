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
