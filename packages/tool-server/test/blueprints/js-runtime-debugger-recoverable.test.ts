import { describe, it, expect } from "vitest";
import { FAILURE_CODES, FailureError, type FailureSignal } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { chromiumJsRuntimeDebuggerBlueprint } from "../../src/blueprints/chromium-js-runtime-debugger";

/**
 * Truth tables for `recoverable()` on both debugger blueprints — the predicate
 * the registry's dispose-and-retry-once self-heal consults for a RUNNING node.
 *
 * Metro (JsRuntimeDebugger): ONLY the send()-guard rejection (NOT_CONNECTED) is
 * recoverable — the one window where the node can still be RUNNING and the
 * request provably never left the host. CONNECTION_CLOSED is deliberately
 * excluded (delivered-request double-execution risk; node has left RUNNING by
 * then anyway), as is REQUEST_TIMEOUT (request may have taken effect; a hung
 * runtime is not fixed by reconnecting).
 *
 * Chromium: NOT_CONNECTED and CONNECTION_CLOSED — the tab-switch reconnect
 * window, where CDPClient.reconnect() rejects in-flight requests while both
 * nodes stay RUNNING and the discarded tab's side effects are moot.
 */

function coded(
  error_code: FailureSignal["error_code"],
  error_kind: FailureSignal["error_kind"] = "network"
) {
  return new FailureError("x", {
    error_code,
    failure_stage: "test_stage",
    failure_area: "tool_server",
    error_kind,
  });
}

const RECOVERABLE_METRO = [FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED];
const RECOVERABLE_CHROMIUM = [
  FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED,
  FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED,
];

// Codes that must be non-recoverable on BOTH blueprints.
const NEVER_RECOVERABLE = [
  FAILURE_CODES.DEBUGGER_METRO_NOT_RUNNING,
  FAILURE_CODES.DEBUGGER_METRO_NO_TARGETS,
  FAILURE_CODES.DEBUGGER_TARGET_DEVICE_MISMATCH,
  FAILURE_CODES.DEBUGGER_CDP_REQUEST_TIMEOUT,
  FAILURE_CODES.DEBUGGER_CDP_CONNECT_FAILED,
  FAILURE_CODES.DEBUGGER_CDP_SOCKET_CLOSED_BEFORE_OPEN,
  FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION,
  FAILURE_CODES.DEBUGGER_CDP_PROTOCOL_ERROR,
  FAILURE_CODES.JS_RUNTIME_CDP_DISCONNECTED,
];

describe("jsRuntimeDebuggerBlueprint.recoverable (Metro)", () => {
  it.each(RECOVERABLE_METRO)("returns true for %s", (code) => {
    expect(jsRuntimeDebuggerBlueprint.recoverable!(coded(code))).toBe(true);
  });

  it("returns false for CONNECTION_CLOSED — delivered request, double-execution risk", () => {
    expect(
      jsRuntimeDebuggerBlueprint.recoverable!(coded(FAILURE_CODES.DEBUGGER_CDP_CONNECTION_CLOSED))
    ).toBe(false);
  });

  it.each(NEVER_RECOVERABLE)("returns false for %s", (code) => {
    expect(jsRuntimeDebuggerBlueprint.recoverable!(coded(code))).toBe(false);
  });
});

describe("chromiumJsRuntimeDebuggerBlueprint.recoverable", () => {
  it.each(RECOVERABLE_CHROMIUM)("returns true for %s", (code) => {
    expect(chromiumJsRuntimeDebuggerBlueprint.recoverable!(coded(code))).toBe(true);
  });

  it.each(NEVER_RECOVERABLE)("returns false for %s", (code) => {
    expect(chromiumJsRuntimeDebuggerBlueprint.recoverable!(coded(code))).toBe(false);
  });

  it("best-effort semantics: a retry re-failing with NOT_CONNECTED is itself still recoverable-coded", () => {
    // The CONNECTION_CLOSED rejection fires at the START of reconnect(), so an
    // immediate registry retry can land before the new handshake completes and
    // re-fail with a classified NOT_CONNECTED. That re-failure is bounded (the
    // registry retries exactly once), but the code stays in the recoverable set
    // so the failure the agent sees is precise, not unclassified.
    expect(
      chromiumJsRuntimeDebuggerBlueprint.recoverable!(
        coded(FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED)
      )
    ).toBe(true);
  });
});

describe("recoverable() with non-FailureError inputs (both blueprints)", () => {
  const blueprints = [
    ["metro", jsRuntimeDebuggerBlueprint],
    ["chromium", chromiumJsRuntimeDebuggerBlueprint],
  ] as const;

  it.each(blueprints)("%s: plain Error is not recoverable", (_name, bp) => {
    expect(bp.recoverable!(new Error("socket hang up"))).toBe(false);
  });

  it.each(blueprints)("%s: a bare string does not throw and is not recoverable", (_name, bp) => {
    expect(bp.recoverable!("socket hang up")).toBe(false);
  });

  it.each(blueprints)("%s: undefined does not throw and is not recoverable", (_name, bp) => {
    expect(bp.recoverable!(undefined)).toBe(false);
  });

  it.each(blueprints)("%s: null does not throw and is not recoverable", (_name, bp) => {
    expect(bp.recoverable!(null)).toBe(false);
  });
});
