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

  it("fails a status tool's disconnected answer, which an e2e step asserts against", () => {
    expect(
      toolResultVerdict("native-devtools-status", { status: "init_failed", message: "env failed" })
    ).toEqual({
      status: "fail",
      reason: "native-devtools-status did not run (init_failed): env failed",
    });
  });

  it("scores an e2e-add-script that recorded nothing by its script's status, under its former id too", () => {
    const failed = {
      status: "fail",
      reason: "boom",
      message: 'Script "s.mjs" failed; no step was recorded.',
      stepCount: 0,
    };
    const expected = {
      status: "fail",
      reason: 'Script "s.mjs" failed; no step was recorded. (boom)',
    };
    expect(toolResultVerdict("e2e-add-script", failed)).toEqual(expected);
    expect(toolResultVerdict("flow-add-script", failed)).toEqual(expected);
    const { reason: _reason, ...noReason } = failed;
    expect(toolResultVerdict("e2e-add-script", { ...noReason, status: "error" })).toEqual({
      status: "error",
      reason: 'Script "s.mjs" failed; no step was recorded.',
    });
    expect(
      toolResultVerdict("e2e-add-script", { status: "pass", message: "Step added", stepCount: 1 })
    ).toBeUndefined();
  });

  it("errors an e2e-add-step that answered with guidance instead of recording", () => {
    expect(
      toolResultVerdict("e2e-add-step", {
        message: "Call it directly. Nothing was executed and no step was recorded.",
        toolResult: undefined,
        stepCount: 2,
        savedTo: "/p/.argent/e2e/t.yaml",
      })
    ).toEqual({
      status: "error",
      reason: "Call it directly. Nothing was executed and no step was recorded.",
    });
    expect(
      toolResultVerdict("e2e-add-step", {
        message: 'Step added to "t" e2e test',
        stepCount: 3,
        recorded: "3: tool gesture-tap",
      })
    ).toBeUndefined();
  });

  it("returns undefined for a passing result and for a tool with no verdict", () => {
    expect(toolResultVerdict("await-ui-element", { success: true })).toBeUndefined();
    expect(toolResultVerdict("e2e-execute", { ok: true, steps: [] })).toBeUndefined();
    expect(toolResultVerdict("debugger-status", { status: "connected" })).toBeUndefined();
    expect(toolResultVerdict("gesture-tap", { ok: false, success: false })).toBeUndefined();
    expect(toolResultVerdict("gesture-tap", { error: "x", message: "x" })).toBeUndefined();
    expect(toolResultVerdict("e2e-add-script", { message: "no status" })).toBeUndefined();
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

  it("fails a debugger-inspect-element error, which the runner leaves to the step", () => {
    expect(directCallFailure("debugger-inspect-element", { error: "no host fiber" })).toBe(
      "debugger-inspect-element failed: no host fiber"
    );
    expect(
      toolResultVerdict("debugger-inspect-element", { error: "no host fiber" })
    ).toBeUndefined();
    expect(directCallFailure("debugger-inspect-element", { items: [] })).toBeUndefined();
    expect(directCallFailure("gesture-tap", { error: "x" })).toBeUndefined();
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
