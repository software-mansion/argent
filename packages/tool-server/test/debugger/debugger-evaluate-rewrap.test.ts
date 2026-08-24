import { describe, it, expect } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import { debuggerEvaluateTool } from "../../src/tools/debugger/debugger-evaluate";
import type { JsRuntimeDebuggerApi } from "../../src/blueprints/js-runtime-debugger";

/**
 * Step 7: an agent-supplied expression THROWING inside the runtime is not a CDP
 * malfunction — the evaluate round-trip worked. The tool must re-code
 * DEBUGGER_CDP_RUNTIME_EXCEPTION as DEBUGGER_EVALUATE_EXPRESSION_THREW so
 * telemetry can separate "agent's JS threw" from genuine CDP faults, while
 * preserving the message (with the JS stack the agent needs) byte-for-byte.
 */

const RUNTIME_EXCEPTION_MESSAGE =
  "Error: x\n    at <anonymous> (http://localhost:8081/index.bundle:1:7)";

function makeServices(evaluateImpl: () => Promise<unknown>) {
  return {
    debugger: {
      cdp: { evaluate: evaluateImpl },
      deviceName: "MockDevice",
      appName: "MockApp",
      logicalDeviceId: "aaa",
    } as unknown as JsRuntimeDebuggerApi,
  };
}

describe("debugger-evaluate runtime-exception rewrap", () => {
  it("rewraps RUNTIME_EXCEPTION as EVALUATE_EXPRESSION_THREW — outer signal wins, message identical", async () => {
    const inner = new FailureError(RUNTIME_EXCEPTION_MESSAGE, {
      error_code: FAILURE_CODES.DEBUGGER_CDP_RUNTIME_EXCEPTION,
      failure_stage: "debugger_cdp_evaluate",
      failure_area: "tool_server",
      error_kind: "unknown",
    });
    const services = makeServices(() => Promise.reject(inner));

    let thrown: unknown;
    try {
      await debuggerEvaluateTool.execute(services, {
        port: 8081,
        device_id: "dev",
        expression: 'throw new Error("x")',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(FailureError);
    // getFailureSignal walks the cause chain breadth-first: the OUTER
    // rewrapped signal must win over the inner RUNTIME_EXCEPTION.
    expect(getFailureSignal(thrown)).toMatchObject({
      error_code: FAILURE_CODES.DEBUGGER_EVALUATE_EXPRESSION_THREW,
      failure_stage: "debugger_evaluate_expression",
      failure_area: "tool_server",
    });
    // Message preserved verbatim — the JS stack is the agent's payload.
    expect((thrown as Error).message).toBe(RUNTIME_EXCEPTION_MESSAGE);
    // The original error stays reachable as the cause.
    expect((thrown as Error).cause).toBe(inner);
  });

  it("does NOT rewrap other CDP faults — NOT_CONNECTED passes through untouched", async () => {
    const inner = new FailureError("CDP not connected", {
      error_code: FAILURE_CODES.DEBUGGER_CDP_NOT_CONNECTED,
      failure_stage: "debugger_cdp_send",
      failure_area: "tool_server",
      error_kind: "network",
    });
    const services = makeServices(() => Promise.reject(inner));

    let thrown: unknown;
    try {
      await debuggerEvaluateTool.execute(services, {
        port: 8081,
        device_id: "dev",
        expression: "1 + 1",
      });
    } catch (err) {
      thrown = err;
    }

    // Identity, not just code: the rewrap path must not touch this error.
    expect(thrown).toBe(inner);
  });

  it("returns the evaluation result unchanged when nothing throws", async () => {
    const services = makeServices(() => Promise.resolve(42));
    const result = (await debuggerEvaluateTool.execute(services, {
      port: 8081,
      device_id: "dev",
      expression: "40 + 2",
    })) as Record<string, unknown>;
    expect(result.result).toBe(42);
    expect(result.deviceName).toBe("MockDevice");
  });
});
