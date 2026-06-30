import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const PROJECT_ROOT = path.join(os.tmpdir(), "flow-await-tests");

// Mock registry: invokeTool returns canned per-tool results; getTool is a stub.
function makeRegistry(invoke: (id: string, args: unknown) => Promise<unknown>) {
  return {
    invokeTool: vi.fn(invoke),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

const writtenFiles: string[] = [];
async function writeFlow(yaml: string): Promise<string> {
  const file = path.join(os.tmpdir(), `flow-await-${writtenFiles.length}-${process.pid}.yaml`);
  await fs.writeFile(file, yaml, "utf8");
  writtenFiles.push(file);
  return file;
}

afterEach(async () => {
  await Promise.all(writtenFiles.splice(0).map((f) => fs.rm(f, { force: true })));
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
      await tool.execute({}, { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile })
    );

    // gesture-tap + await-ui-element ran; the trailing tap did NOT.
    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
    const toolSteps = result.steps.filter((s) => s.kind === "tool");
    expect(toolSteps).toHaveLength(2);
    const last = toolSteps[1] as { tool: string; error?: string };
    expect(last.tool).toBe("await-ui-element");
    expect(last.error).toMatch(/condition not met/i);
    expect(last.error).toMatch(/no element matched/i);
  });

  it("runs the whole flow when the gating await-ui-element step is met", async () => {
    const flowFile = await writeFlow(GATED_FLOW);
    const registry = makeRegistry(async (id) => {
      if (id === "await-ui-element") return { success: true, elapsed: 80 };
      return { tapped: true };
    });
    const tool = createRunFlowTool(registry);

    const result = asRun(
      await tool.execute({}, { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile })
    );

    expect(registry.invokeTool).toHaveBeenCalledTimes(3);
    expect(result.steps.filter((s) => s.kind === "tool")).toHaveLength(3);
  });

  it("forwards the request abort signal into each step invocation", async () => {
    const flowFile = await writeFlow(GATED_FLOW);
    const registry = makeRegistry(async () => ({ tapped: true, success: true }));
    const tool = createRunFlowTool(registry);
    const controller = new AbortController();

    await tool.execute({}, { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile }, {
      signal: controller.signal,
    } as never);

    const opts = (registry.invokeTool as any).mock.calls[0][2];
    expect(opts.signal).toBe(controller.signal);
  });

  it("does not run any step when the signal is already aborted", async () => {
    const flowFile = await writeFlow(GATED_FLOW);
    const registry = makeRegistry(async () => ({ tapped: true }));
    const tool = createRunFlowTool(registry);
    const controller = new AbortController();
    controller.abort();

    await tool.execute({}, { name: "gated", project_root: PROJECT_ROOT, flow_file: flowFile }, {
      signal: controller.signal,
    } as never);

    expect(registry.invokeTool).not.toHaveBeenCalled();
  });
});
