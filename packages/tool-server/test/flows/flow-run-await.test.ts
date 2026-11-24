import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, FailureError, type Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const PROJECT_ROOT = path.join(os.tmpdir(), `flow-await-tests-${process.pid}`);

// Mock registry: invokeTool returns canned per-tool results; getTool is a stub.
function makeRegistry(invoke: (id: string, args: unknown) => Promise<unknown>) {
  return {
    invokeTool: vi.fn(invoke),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

// The flow lives at the exact path the file-input boundary derives
// (`${project_root}/.argent/flows/${name}.yaml`) — any other explicit
// e2e_test_file is rejected by the containment check.
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
  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.9
  - tool: await-ui-element
    args:
      udid: X
      condition: visible
      selector:
        text: Continue
  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.5
`;

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a FlowRunResult, got a notice: ${r.notice}`);
  return r;
}

describe("flow-execute with await-ui-element gating", () => {
  it("stops the flow when a gating await-ui-element step is not met", async () => {
    const flowFile = await writeFlow(GATED_FLOW);
    const registry = makeRegistry(async (id) => {
      if (id === "await-ui-element") {
        return {
          success: false,
          elapsed: 5000,
          note: "no element matched the selector before timeout",
        };
      }
      return { tapped: true };
    });
    const tool = createRunFlowTool(registry);

    const result = asRun(
      await tool.execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, e2e_test_file: flowFile, device: "X" }
      )
    );

    // gesture-tap + await-ui-element ran, then the failure screenshot; the
    // trailing tap did NOT (skipped).
    expect(registry.invokeTool).toHaveBeenCalledTimes(3);
    const executed = result.steps.filter((s) => s.kind === "tool" && s.status !== "skip");
    expect(executed).toHaveLength(2);
    const last = executed[1];
    expect(last.tool).toBe("await-ui-element");
    expect(last.status).toBe("fail");
    expect(last.reason).toMatch(/condition not met/i);
    expect(last.reason).toMatch(/no element matched/i);
    // The report keeps what the step ran with and what it got back.
    expect(last.args).toEqual({ condition: "visible", selector: { text: "Continue" } });
    expect(last.result).toEqual({
      success: false,
      elapsed: 5000,
      note: "no element matched the selector before timeout",
    });
    expect(result.ok).toBe(false);
  });

  it("runs the whole flow when the gating await-ui-element step is met", async () => {
    const flowFile = await writeFlow(GATED_FLOW);
    const registry = makeRegistry(async (id) => {
      if (id === "await-ui-element") return { success: true, elapsed: 80 };
      return { tapped: true };
    });
    const tool = createRunFlowTool(registry);

    const result = asRun(
      await tool.execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, e2e_test_file: flowFile, device: "X" }
      )
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(3);
    expect(result.steps.filter((s) => s.kind === "tool")).toHaveLength(3);
    expect(result.ok).toBe(true);
  });

  it("forwards the request abort signal into each step invocation", async () => {
    const flowFile = await writeFlow(GATED_FLOW);
    const registry = makeRegistry(async () => ({ tapped: true, success: true }));
    const tool = createRunFlowTool(registry);
    const controller = new AbortController();

    await tool.execute(
      {},
      { name: "gated", project_root: PROJECT_ROOT, e2e_test_file: flowFile, device: "X" },
      { signal: controller.signal } as never
    );

    const opts = (registry.invokeTool as any).mock.calls[0][2];
    expect(opts.signal).toBe(controller.signal);
  });

  it("does not run any step when the signal is already aborted", async () => {
    const flowFile = await writeFlow(GATED_FLOW);
    const registry = makeRegistry(async () => ({ tapped: true }));
    const tool = createRunFlowTool(registry);
    const controller = new AbortController();
    controller.abort();

    await tool.execute(
      {},
      { name: "gated", project_root: PROJECT_ROOT, e2e_test_file: flowFile, device: "X" },
      { signal: controller.signal } as never
    );

    expect(registry.invokeTool).not.toHaveBeenCalled();
  });
});

const NETWORK_FLOW = `executionPrerequisite: ""
steps:
  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.9
  - tool: await-network-request
    args:
      udid: X
      bundleId: com.example.shop
      method: POST
      url: /v1/auth/login
      status: 200
  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.5
`;

describe("flow-execute with await-network-request gating", () => {
  async function runNetworkFlow(wait: () => Promise<unknown>) {
    const flowFile = await writeFlow(NETWORK_FLOW);
    const registry = makeRegistry(async (id) =>
      id === "await-network-request" ? wait() : { tapped: true }
    );
    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, e2e_test_file: flowFile, device: "X" }
      )
    );
    const invoked = (registry.invokeTool as any).mock.calls.map(([id]: [string]) => id);
    return { result, invoked };
  }

  it("fails the step on an unmet wait and skips the rest", async () => {
    const note =
      'No request since network-capture-start matched within this 10000 ms wait (wanted: POST, URL containing "/v1/auth/login", status 200, complete).';
    const { result, invoked } = await runNetworkFlow(async () => ({
      success: false,
      elapsed: 10_000,
      cause: "unmet",
      note,
    }));

    // The trailing tap never ran; only the failure screenshot follows the wait.
    expect(invoked.filter((id: string) => id === "gesture-tap")).toHaveLength(1);
    const tools = result.steps.filter((s) => s.kind === "tool");
    expect(tools.map((s) => s.status)).toEqual(["pass", "fail", "skip"]);
    expect(tools[1]).toMatchObject({
      tool: "await-network-request",
      status: "fail",
      reason: `await-network-request condition not met: ${note}`,
    });
    expect(result.ok).toBe(false);
  });

  it("scores a wait without a start as an error, not a failed check", async () => {
    const { result, invoked } = await runNetworkFlow(async () => {
      throw new FailureError(
        "Network capture is not started for com.example.shop on X, so no request can be waited for. Call network-capture-start for com.example.shop, repeat the action that sends the request, then call await-network-request.",
        {
          error_code: FAILURE_CODES.NETWORK_CAPTURE_NOT_STARTED,
          failure_stage: "await_network_request_marks",
          failure_area: "tool_server",
          error_kind: "not_found",
        }
      );
    });

    expect(invoked.filter((id: string) => id === "gesture-tap")).toHaveLength(1);
    const tools = result.steps.filter((s) => s.kind === "tool");
    expect(tools.map((s) => s.status)).toEqual(["pass", "error", "skip"]);
    expect(tools[1]!.reason).toContain("Call network-capture-start for com.example.shop");
    expect(result.ok).toBe(false);
  });
});
