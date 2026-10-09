import { describe, it, expect } from "vitest";
import { FAILURE_CODES, FailureError, type FailureSignal } from "@argent/registry";
import { jsRuntimeDebuggerBlueprint } from "../../src/blueprints/js-runtime-debugger";
import { chromiumJsRuntimeDebuggerBlueprint } from "../../src/blueprints/chromium-js-runtime-debugger";

/**
 * Truth table for `recoverable()` on the Metro debugger blueprint — the
 * predicate the registry's dispose-and-retry-once self-heal consults for a
 * RUNNING node — plus a pin that the Chromium wrapper deliberately declares
 * NO recoverable() at all.
 *
 * Metro (JsRuntimeDebugger): ONLY the send()-guard rejection (NOT_CONNECTED) is
 * recoverable — the one window where the node can still be RUNNING and the
 * request provably never left the host. CONNECTION_CLOSED is deliberately
 * excluded (delivered-request double-execution risk; node has left RUNNING by
 * then anyway), as is REQUEST_TIMEOUT (request may have taken effect; a hung
 * runtime is not fixed by reconnecting).
 *
 * Chromium: recovery would dispose the wrapper node, which ends the capture
 * session — the next resolve builds a new writer over a new path, so the
 * counts and clusters go with it — and it buys nothing, because a tab-switch
 * reconnect re-points the same client object so the cached node heals for the
 * next call without any dispose. See the blueprint comment.
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

// Codes that must be non-recoverable on the Metro blueprint.
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

describe("chromiumJsRuntimeDebuggerBlueprint has NO recovery", () => {
  it("declares no recoverable() — the registry must never dispose-and-retry this node", () => {
    // Load-bearing absence: Registry._recoverFailedServices treats a missing
    // recoverable() as never-recover, so the wrapper node is never disposed on
    // a failing call — which is what keeps this session's captured history
    // reachable through the registry, rather than reduced to the breadcrumb a
    // dispose leaves. Reintroducing a recoverable() here re-opens the hole this
    // pin guards.
    expect(chromiumJsRuntimeDebuggerBlueprint.recoverable).toBeUndefined();
  });
});

describe("recoverable() with non-FailureError inputs (Metro)", () => {
  it("plain Error is not recoverable", () => {
    expect(jsRuntimeDebuggerBlueprint.recoverable!(new Error("socket hang up"))).toBe(false);
  });

  it("a bare string does not throw and is not recoverable", () => {
    expect(jsRuntimeDebuggerBlueprint.recoverable!("socket hang up")).toBe(false);
  });

  it("undefined does not throw and is not recoverable", () => {
    expect(jsRuntimeDebuggerBlueprint.recoverable!(undefined)).toBe(false);
  });

  it("null does not throw and is not recoverable", () => {
    expect(jsRuntimeDebuggerBlueprint.recoverable!(null)).toBe(false);
  });
});
