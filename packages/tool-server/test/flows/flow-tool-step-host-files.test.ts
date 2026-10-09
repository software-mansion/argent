import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";

/**
 * A `tool:` step of a run without a link names its file arguments as the flow
 * spells them, with no argent client to wrap them. `flow-execute` and
 * `flow-read-prerequisite` run a `flow_path` only with the file-input entry a
 * direct call gets, so the runner gives the step that entry.
 */

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
const PREREQUISITE = "The QA app is open on its main screen";

let root: string;
let flowsDir: string;

function registry(): Registry {
  const r = new Registry();
  r.registerTool(createRunFlowTool(r) as never);
  r.registerTool(flowReadPrerequisiteTool as never);
  return r;
}

async function runOuter(steps: string): Promise<FlowRunResult> {
  await fs.writeFile(path.join(flowsDir, "outer.yaml"), `steps:\n${steps}`, "utf8");
  return registry().invokeTool<FlowRunResult>("flow-execute", {
    name: "outer",
    project_root: root,
    device: DEVICE,
  });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-host-files-"));
  flowsDir = path.join(root, ".argent", "flows");
  await fs.mkdir(path.join(flowsDir, "elsewhere"), { recursive: true });
  await fs.writeFile(
    path.join(flowsDir, "elsewhere", "frag.yaml"),
    `executionPrerequisite: ${PREREQUISITE}\nsteps:\n  - echo: from the fragment\n`,
    "utf8"
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("a tool: step with flow_path, without a link", () => {
  it("runs the flow that a tool: flow-execute step names by flow_path", async () => {
    const frag = path.join(flowsDir, "elsewhere", "frag.yaml");
    const result = await runOuter(
      `  - tool: flow-execute\n    args: { flow_path: ${frag}, project_root: ${root}, prerequisiteAcknowledged: true }\n`
    );

    expect(result.steps[0]).toMatchObject({ kind: "tool", tool: "flow-execute", status: "pass" });
    expect(result.steps[0].result).toMatchObject({
      flow: "frag",
      ok: true,
      steps: [{ kind: "echo", status: "pass", message: "from the fragment" }],
    });
    expect(result.ok).toBe(true);
  });

  it("reads the prerequisite of the flow that a tool: flow-read-prerequisite step names", async () => {
    const frag = path.join(flowsDir, "elsewhere", "frag.yaml");
    const result = await runOuter(
      `  - tool: flow-read-prerequisite\n    args: { flow_path: ${frag}, project_root: ${root} }\n`
    );

    expect(result.steps[0]).toMatchObject({ status: "pass", tool: "flow-read-prerequisite" });
    expect(result.steps[0].result).toEqual({ flow: "frag", executionPrerequisite: PREREQUISITE });
  });

  it("fails a step whose flow_path names no file as a direct call does, not at the boundary gate", async () => {
    const missing = path.join(flowsDir, "elsewhere", "missing.yaml");
    const result = await runOuter(
      `  - tool: flow-read-prerequisite\n    args: { flow_path: ${missing}, project_root: ${root} }\n`
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toBe(
      `File "${missing}" was not found on the tool-server host and the client did not upload ` +
        `its content. Either the file does not exist, or it changed since it was referenced — ` +
        `re-create it (or re-run the producing tool) and try again.`
    );
  });

  it("leaves the path that a tool builds from name to the tool itself", async () => {
    const result = await runOuter(
      `  - tool: flow-execute\n    args: { name: nope, project_root: ${root}, prerequisiteAcknowledged: true }\n`
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toBe(
      `[Tool:flow-execute] ENOENT: no such file or directory, open '${path.join(flowsDir, "nope.yaml")}'`
    );
  });
});
