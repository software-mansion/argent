import { describe, it, expect } from "vitest";
import { directCallFailure, toolResultVerdict } from "../src/utils/tool-result-verdict";

describe("toolResultVerdict", () => {
  it("fails an unmet await-ui-element", () => {
    expect(toolResultVerdict("await-ui-element", { success: false, note: "timed out" })).toEqual({
      status: "fail",
      reason: "await-ui-element condition not met: timed out",
    });
  });

  it("says a wait that never judged its condition was not judged, by cause", () => {
    expect(
      toolResultVerdict("await-ui-element", {
        success: false,
        cause: "unreadable",
        note: "no element matched the selector before timeout",
      })
    ).toEqual({
      status: "fail",
      reason:
        "await-ui-element condition not judged (unreadable): no element matched the selector before timeout",
    });
    expect(
      toolResultVerdict("await-ui-element", {
        success: false,
        note: "wait was cancelled before the condition was met",
      })?.reason
    ).toBe(
      "await-ui-element condition not judged (cancelled): wait was cancelled before the condition was met"
    );
  });

  it("fails a run-sequence that stopped on an error", () => {
    expect(
      toolResultVerdict("run-sequence", {
        completed: 1,
        total: 3,
        steps: [{ tool: "gesture-tap" }, { tool: "button", error: "no device" }],
      })
    ).toEqual({
      status: "fail",
      reason: "run-sequence stopped at button after 1 of 3 steps: no device",
    });
  });

  it("errors an e2e-execute that ran nothing, under its former id too", () => {
    const notice = { e2eTest: "seed", notice: "acknowledge first", executionPrerequisite: "db up" };
    const expected = {
      status: "error",
      reason:
        'e2e test "seed" did not run — its execution prerequisite was not acknowledged: db up. ' +
        "Set prerequisiteAcknowledged to true once it holds; an e2e test can compose it with run: instead.",
    };
    expect(toolResultVerdict("e2e-execute", notice)).toEqual(expected);
    expect(toolResultVerdict("flow-execute", notice)).toEqual(expected);
  });

  it("fails a debugger tool with no connection", () => {
    expect(
      toolResultVerdict("debugger-status", {
        status: "not_connected",
        reason: "metro_not_running",
        detail: "nothing on 8081",
        guidance: "start Metro",
      })
    ).toEqual({
      status: "fail",
      reason: "debugger not connected (metro_not_running): nothing on 8081 — start Metro",
    });
  });

  it("fails a tool its native-devtools precheck stopped", () => {
    expect(
      toolResultVerdict("launch-app", { status: "restart_required", message: "restart the app" })
    ).toEqual({
      status: "fail",
      reason: "launch-app did not run (restart_required): restart the app",
    });
  });

  it("returns undefined for a passing result and for a tool with no verdict", () => {
    expect(toolResultVerdict("await-ui-element", { success: true })).toBeUndefined();
    expect(toolResultVerdict("e2e-execute", { ok: true, steps: [] })).toBeUndefined();
    expect(toolResultVerdict("debugger-status", { status: "connected" })).toBeUndefined();
    expect(toolResultVerdict("gesture-tap", { ok: false, success: false })).toBeUndefined();
    expect(
      toolResultVerdict("describe", { status: "restart_required", message: "x" })
    ).toBeUndefined();
  });
});

describe("directCallFailure", () => {
  const notConnected = {
    status: "not_connected",
    reason: "metro_not_running",
    detail: "nothing on 8081",
    guidance: "start Metro",
  };

  it("sends no failure for a status tool reporting its state", () => {
    expect(directCallFailure("debugger-status", notConnected)).toBeUndefined();
    expect(
      directCallFailure("native-devtools-status", { status: "init_failed", message: "env failed" })
    ).toBeUndefined();
  });

  it("sends the verdict's reason for any other tool", () => {
    expect(directCallFailure("debugger-log-registry", notConnected)).toBe(
      "debugger not connected (metro_not_running): nothing on 8081 — start Metro"
    );
    expect(directCallFailure("await-ui-element", { success: false, note: "x" })).toBe(
      "await-ui-element condition not met: x"
    );
  });
});
