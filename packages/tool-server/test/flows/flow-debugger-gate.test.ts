import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

/**
 * A debugger-status / debugger-log-registry step returning the structured
 * not_connected shape is a SUCCESSFUL tool call, but a flow using it as a
 * connectivity gate must not silently green-pass on it. Mirrors the
 * await-ui-element unmet-condition mapping (flow-run-await.test.ts).
 */

const PROJECT_ROOT = path.join(os.tmpdir(), `flow-debugger-gate-tests-${process.pid}`);

function makeRegistry(invoke: (id: string, args: unknown) => Promise<unknown>) {
  return {
    invokeTool: vi.fn(invoke),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

async function writeFlow(yaml: string): Promise<string> {
  const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
  const file = path.join(flowsDir, "gated.yaml");
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

afterEach(async () => {
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true });
});

const GATED_FLOW = `executionPrerequisite: ""
steps:
  - tool: debugger-status
    args:
      port: 8081
      device_id: X
  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.5
`;

const NOT_CONNECTED_RESULT = {
  status: "not_connected",
  connected: false,
  port: 8081,
  reason: "metro_not_running",
  detail: "Metro at port 8081 is not running",
  guidance: "Do not retry in a loop — start Metro first.",
};

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a FlowRunResult, got a notice: ${r.notice}`);
  return r;
}

describe("flow-execute with a debugger-status connectivity gate", () => {
  it("maps a not_connected result to step status fail and stops the flow", async () => {
    const flowFile = await writeFlow(GATED_FLOW);
    const registry = makeRegistry(async (id) => {
      if (id === "debugger-status") return NOT_CONNECTED_RESULT;
      return { tapped: true };
    });
    const tool = createRunFlowTool(registry);

    const result = asRun(
      await tool.execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" }
      )
    );

    // debugger-status ran; the trailing tap did NOT.
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    const executed = result.steps.filter((s) => s.kind === "tool" && s.status !== "skip");
    expect(executed).toHaveLength(1);
    const gate = executed[0];
    expect(gate.tool).toBe("debugger-status");
    expect(gate.status).toBe("fail");
    expect(gate.reason).toMatch(/debugger not connected \(metro_not_running\)/);
    expect(gate.reason).toMatch(/Do not retry in a loop/);
    // `detail` must reach the report: it is the only field that names what
    // actually answered the port (and device_mismatch's guidance explicitly
    // forwards the agent to it for the valid logicalDeviceIds).
    expect(gate.reason).toContain(NOT_CONNECTED_RESULT.detail);
    expect(gate.result).toEqual(NOT_CONNECTED_RESULT);
    expect(result.ok).toBe(false);
  });

  it("maps a debugger-log-registry gate the same way — the second tool id is load-bearing", async () => {
    // Narrowing the predicate to debugger-status alone would silently
    // green-pass a log-registry connectivity gate; this pins the second arm.
    const LOG_FLOW = `executionPrerequisite: ""
steps:
  - tool: debugger-log-registry
    args:
      port: 8081
      device_id: X
  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.5
`;
    const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
    const file = path.join(flowsDir, "log-gated.yaml");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(file, LOG_FLOW, "utf8");

    const registry = makeRegistry(async (id) => {
      if (id === "debugger-log-registry") return NOT_CONNECTED_RESULT;
      return { tapped: true };
    });
    const tool = createRunFlowTool(registry);

    const result = asRun(
      await tool.execute(
        {},
        { name: "log-gated", project_root: PROJECT_ROOT, flow_file: file, device: "X" }
      )
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    const executed = result.steps.filter((s) => s.kind === "tool" && s.status !== "skip");
    expect(executed).toHaveLength(1);
    expect(executed[0].tool).toBe("debugger-log-registry");
    expect(executed[0].status).toBe("fail");
    expect(executed[0].reason).toContain(NOT_CONNECTED_RESULT.detail);
    expect(result.ok).toBe(false);
  });

  it("passes the gate and runs the whole flow on a connected result", async () => {
    const flowFile = await writeFlow(GATED_FLOW);
    const registry = makeRegistry(async (id) => {
      if (id === "debugger-status") {
        return { status: "connected", connected: true, port: 8081 };
      }
      return { tapped: true };
    });
    const tool = createRunFlowTool(registry);

    const result = asRun(
      await tool.execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" }
      )
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    expect(result.steps.filter((s) => s.kind === "tool")).toHaveLength(2);
    expect(result.ok).toBe(true);
  });

  it("does NOT trip the mapping for other tools returning a status field", async () => {
    // The predicate is keyed on the two debugger tool ids — an unrelated tool
    // whose result happens to carry status:"not_connected" must stay a pass.
    const OTHER_FLOW = `executionPrerequisite: ""
steps:
  - tool: some-custom-tool
    args:
      udid: X
`;
    const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
    const file = path.join(flowsDir, "other.yaml");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(file, OTHER_FLOW, "utf8");

    const registry = makeRegistry(async () => ({ status: "not_connected" }));
    const tool = createRunFlowTool(registry);

    const result = asRun(
      await tool.execute(
        {},
        { name: "other", project_root: PROJECT_ROOT, flow_file: file, device: "X" }
      )
    );

    const executed = result.steps.filter((s) => s.kind === "tool");
    expect(executed).toHaveLength(1);
    expect(executed[0].status).toBe("pass");
    expect(result.ok).toBe(true);
  });
});
