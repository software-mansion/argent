import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
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
// flow_file is rejected by the containment check.
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
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" }
      )
    );

    // gesture-tap + await-ui-element ran; the trailing tap did NOT (skipped).
    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    const executed = result.steps.filter((s) => s.kind === "tool" && s.status !== "skip");
    expect(executed).toHaveLength(2);
    const last = executed[1];
    expect(last.tool).toBe("await-ui-element");
    expect(last.status).toBe("fail");
    expect(last.reason).toMatch(/condition not met/i);
    expect(last.reason).toMatch(/no element matched/i);
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
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" }
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
      { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" },
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
      { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" },
      { signal: controller.signal } as never
    );

    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("scores a tool that completes under a mid-invocation abort as skip", async () => {
    // The client disconnects while the tool is running: the sub-tool still
    // returns (e.g. run-sequence honours the cancel by returning a partial
    // result rather than throwing), so the post-invoke abort guard is what
    // stops that return being scored a pass.
    const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.5
`);
    const controller = new AbortController();
    const registry = makeRegistry(async () => {
      controller.abort();
      return { tapped: true };
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" },
        { signal: controller.signal } as never
      )
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      tool: "gesture-tap",
      status: "skip",
      reason: "run aborted during tool",
    });
    expect(result.ok).toBe(false);
  });

  it("keeps a nested orchestrator's own abort wording and payload on the skip", async () => {
    // A nested run-sequence honours the cancel by returning a PARTIAL result,
    // and knows how far it got. The generic "run aborted during tool" wording
    // would throw that progress away, and a skip without `result`/`args` leaves
    // the partial sequence unreadable in the report.
    const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: run-sequence
    args:
      steps:
        - tool: gesture-tap
          args: { x: 0.5, y: 0.5 }
        - tool: gesture-tap
          args: { x: 0.5, y: 0.6 }
`);
    const controller = new AbortController();
    const registry = makeRegistry(async () => {
      controller.abort();
      return {
        completed: 1,
        total: 2,
        steps: [{ tool: "gesture-tap", result: { tapped: true } }],
      };
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" },
        { signal: controller.signal } as never
      )
    );

    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      tool: "run-sequence",
      status: "skip",
      reason: "run-sequence was aborted after 1 of 2 steps",
      result: { completed: 1, total: 2 },
    });
    expect(result.steps[0]!.args).toBeDefined();
  });

  it("falls back to the generic abort wording for a plain tool", async () => {
    // Only the two nested orchestrators report their own progress; anything else
    // has no abort verdict of its own, so the runner supplies the wording.
    const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.5
`);
    const controller = new AbortController();
    const registry = makeRegistry(async () => {
      controller.abort();
      return { tapped: true };
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" },
        { signal: controller.signal } as never
      )
    );

    expect(result.steps[0]).toMatchObject({
      status: "skip",
      reason: "run aborted during tool",
      result: { tapped: true },
    });
  });
});

describe("flow-execute with a nested run-sequence step", () => {
  it("fails a raw run-sequence step when one nested step returned an error", async () => {
    const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: run-sequence
    args:
      steps:
        - tool: await-ui-element
          args:
            condition: visible
            selector: { text: Continue }
  - echo: must not run
`);
    const registry = makeRegistry(async (id) => {
      if (id !== "run-sequence") return {};
      return {
        completed: 0,
        total: 1,
        steps: [
          {
            tool: "await-ui-element",
            error: "await-ui-element condition not met: no element matched",
          },
        ],
      };
    });

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" }
      )
    );

    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      tool: "run-sequence",
      status: "fail",
      reason: expect.stringContaining("await-ui-element condition not met"),
    });
    // Which nested step stopped it, by position and tool — the outer report
    // names only "run-sequence", and a sequence's steps are often identical.
    expect(result.steps[0]!.reason).toContain("stopped at await-ui-element after 0 of 1 steps");
    expect(result.steps[1]).toMatchObject({ kind: "echo", status: "skip" });
    expect(result.ok).toBe(false);
  });
});
