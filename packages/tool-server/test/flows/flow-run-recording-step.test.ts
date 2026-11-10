import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";

const PROJECT_ROOT = path.join(os.tmpdir(), `flow-recording-step-tests-${process.pid}`);

async function writeFlow(yaml: string): Promise<string> {
  const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
  const file = path.join(flowsDir, "recording.yaml");
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

afterEach(async () => {
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true });
});

async function runStep(tool: string, result: unknown): Promise<FlowRunResult["steps"][number]> {
  const flowFile = await writeFlow(`executionPrerequisite: ""
steps:
  - tool: ${tool}
    args:
      path: scripts/check.mjs
`);
  const registry = {
    invokeTool: vi.fn(async () => result),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
  const run = await createRunFlowTool(registry).execute(
    {},
    { name: "recording", project_root: PROJECT_ROOT, e2e_test_file: flowFile, device: "X" }
  );
  if (!("steps" in run)) throw new Error(`expected a run report, got a notice: ${run.notice}`);
  const step = run.steps.find((s) => s.kind === "tool");
  if (!step) throw new Error("the tool step did not run");
  return step;
}

describe("a tool: step that runs a recording tool", () => {
  it("fails when e2e-add-script's script did not pass", async () => {
    const step = await runStep("e2e-add-script", {
      message: "The script did not pass; nothing was recorded",
      status: "fail",
      reason: "seeded failure",
    });

    expect(step.status).toBe("fail");
    expect(step.reason).toBe("The script did not pass; nothing was recorded (seeded failure)");
  });

  it("passes when e2e-add-script recorded the script", async () => {
    const step = await runStep("e2e-add-script", { message: "Recorded", status: "pass" });

    expect(step.status).toBe("pass");
  });
});
