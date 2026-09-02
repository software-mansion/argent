import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { createRunSequenceTool } from "../../src/tools/run-sequence";

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

  it("keeps a nested orchestrator's own abort wording and payload on the skip", async () => {
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
    expect(result.steps[0]!.reached).toBe(true);
  });

  it("calls a CANCELLED await-ui-element a skip, not a condition the app failed", async () => {
    const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: await-ui-element
    args:
      udid: X
      condition: visible
      selector:
        text: Continue
`);
    const controller = new AbortController();
    const registry = makeRegistry(async () => {
      controller.abort();
      return {
        success: false,
        elapsed: 12,
        note: "wait was cancelled before the condition was met",
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
      tool: "await-ui-element",
      status: "skip",
      reason: "run aborted during wait",
    });
    expect(result.steps[0]!.reason).not.toContain("condition not met");
    // Unmarked: the wait read the tree and dispatched nothing, so the skip IS
    // proof of an untouched device - the same answer `wait` and `await:` give.
    expect(result.steps[0]!.reached).toBeUndefined();
  });

  it("scores the same cancelled wait the same way through run-sequence", async () => {
    const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: run-sequence
    args:
      udid: X
      steps:
        - tool: await-ui-element
          args:
            condition: visible
            selector:
              text: Continue
`);
    const controller = new AbortController();
    // The real batch tool, so the entry the runner reads is the one it builds.
    const inner = makeRegistry(async () => {
      controller.abort();
      return {
        success: false,
        elapsed: 12,
        note: "wait was cancelled before the condition was met",
        cause: "cancelled",
      };
    });
    const runSequence = createRunSequenceTool(inner);
    const registry = {
      invokeTool: vi.fn(async (id: string, args: unknown) =>
        id === "run-sequence"
          ? runSequence.execute({}, args as never)
          : Promise.reject(new Error(`Tool "${id}" not found`))
      ),
      // Declared so the runner binds the run device onto the batch, as it does
      // for a real registration.
      getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    } as unknown as Registry;

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" },
        { signal: controller.signal } as never
      )
    );

    // The spelling must not decide the verdict: the direct case above is a
    // skip, so this one is too, and neither reason may call the condition unmet.
    expect(result.steps[0]).toMatchObject({ tool: "run-sequence", status: "skip" });
    expect(result.steps[0]!.reason).not.toContain("condition not met");
    expect(result.steps[0]!.reached).toBeUndefined();
  });

  it("keeps a GENUINE miss a failure when an unrelated cancel lands in the same tick", async () => {
    const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: await-ui-element
    args:
      udid: X
      condition: visible
      selector:
        text: Continue
`);
    const controller = new AbortController();
    const registry = makeRegistry(async () => {
      controller.abort();
      return {
        success: false,
        elapsed: 5000,
        note: "no element matched the selector before timeout",
        cause: "unmet",
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
      tool: "await-ui-element",
      status: "fail",
    });
    expect(result.steps[0]!.reason).toContain("condition not met");
    expect(result.steps[0]!.reason).not.toContain("run aborted");
  });

  it("leaves a step the cancel caught in its pre-invoke delay unmarked", async () => {
    const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: gesture-tap
    delayMs: 3000
    args:
      udid: X
      x: 0.5
      y: 0.5
`);
    const controller = new AbortController();
    const calls: string[] = [];
    const registry = makeRegistry(async (id) => {
      calls.push(id);
      return { tapped: true };
    });
    const timer = setTimeout(() => controller.abort(), 40);

    const result = asRun(
      await createRunFlowTool(registry).execute(
        {},
        { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" },
        { signal: controller.signal } as never
      )
    );
    clearTimeout(timer);

    expect(result.steps[0]).toMatchObject({
      tool: "gesture-tap",
      status: "skip",
      reason: "run aborted during delay",
    });
    expect(result.steps[0]!.reached).toBeUndefined();
    expect(calls).not.toContain("gesture-tap");
  });

  it("keeps a plain tool that finished before the cancel a PASS", async () => {
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

    expect(result.steps[0]).toMatchObject({ status: "pass", result: { tapped: true } });
  });

  it("keeps a nested step's FAILURE and its detail when the cancel lands too", async () => {
    const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: run-sequence
    args:
      steps:
        - tool: gesture-tap
          args: { x: 0.5, y: 0.5 }
        - tool: keyboard
          args: { text: hi }
`);
    const controller = new AbortController();
    const registry = makeRegistry(async () => {
      controller.abort();
      return {
        completed: 1,
        total: 2,
        steps: [
          { tool: "gesture-tap", result: { tapped: true } },
          { tool: "keyboard", error: "keyboard failed: no focused field" },
        ],
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
      tool: "run-sequence",
      status: "fail",
      reason:
        "run-sequence stopped at keyboard after 1 of 2 steps: keyboard failed: no focused field",
    });
  });
});
