import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { screenshotDiffTool } from "../../src/tools/screenshot-diff";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
const PREREQUISITE = "The QA app is open on its main screen";

let root: string;
let flowsDir: string;

function registry(): Registry {
  const r = new Registry();
  r.registerTool(createRunFlowTool(r) as never);
  r.registerTool(flowReadPrerequisiteTool as never);
  r.registerTool(screenshotDiffTool as never);
  return r;
}

async function runOuter(steps: string): Promise<FlowRunResult> {
  await fs.writeFile(path.join(flowsDir, "outer.yaml"), `steps:\n${steps}`, "utf8");
  return registry().invokeTool<FlowRunResult>("e2e-execute", {
    name: "outer",
    project_root: root,
    device: DEVICE,
  });
}

beforeEach(async () => {
  // realpath: the tool reports a resolved path, and macOS tmpdir is a symlink.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-host-files-")));
  flowsDir = path.join(root, ".argent", "e2e");
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
  it("runs the flow that a tool: e2e-execute step names by flow_path", async () => {
    const frag = path.join(flowsDir, "elsewhere", "frag.yaml");
    const result = await runOuter(
      `  - tool: e2e-execute\n    args: { flow_path: ${frag}, project_root: ${root}, prerequisiteAcknowledged: true }\n`
    );

    expect(result.steps[0]).toMatchObject({ kind: "tool", tool: "e2e-execute", status: "pass" });
    expect(result.steps[0].result).toMatchObject({
      flow: "frag",
      ok: true,
      steps: [{ kind: "echo", status: "pass", message: "from the fragment" }],
    });
    expect(result.ok).toBe(true);
  });

  it("reads the prerequisite of the flow that a tool: e2e-read-prerequisite step names", async () => {
    const frag = path.join(flowsDir, "elsewhere", "frag.yaml");
    const result = await runOuter(
      `  - tool: e2e-read-prerequisite\n    args: { flow_path: ${frag}, project_root: ${root} }\n`
    );

    expect(result.steps[0]).toMatchObject({ status: "pass", tool: "e2e-read-prerequisite" });
    expect(result.steps[0].result).toEqual({ flow: "frag", executionPrerequisite: PREREQUISITE });
  });

  it("fails a step whose flow_path names no file, naming the argument and the tool", async () => {
    const missing = path.join(flowsDir, "elsewhere", "missing.yaml");
    const result = await runOuter(
      `  - tool: e2e-read-prerequisite\n    args: { flow_path: ${missing}, project_root: ${root} }\n`
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toBe(
      `there is no file at "${missing}" (argument flow_path of e2e-read-prerequisite)`
    );
  });

  it("says where a relative path that names no file was looked up", async () => {
    const result = await runOuter(
      `  - tool: e2e-execute\n    args: { flow_path: elsewhere/frag.yaml, project_root: ${root}, prerequisiteAcknowledged: true }\n`
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toBe(
      `there is no file at "elsewhere/frag.yaml" (argument flow_path of e2e-execute); a relative ` +
        `path is resolved against the tool server's working directory, not the e2e test's`
    );
  });

  it("leaves a flow_path set beside name to the tool's one-source check", async () => {
    const missing = path.join(flowsDir, "elsewhere", "missing.yaml");
    const result = await runOuter(
      `  - tool: e2e-read-prerequisite\n    args: { name: frag, flow_path: ${missing}, project_root: ${root} }\n`
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain(
      "Pass exactly one e2e test source: name or flow_path."
    );
  });

  it("fails a step whose file argument is a directory", async () => {
    const dir = path.join(root, "shots.png");
    await fs.mkdir(dir);
    const result = await runOuter(
      `  - tool: screenshot-diff\n    args: { baselinePath: ${dir}, currentPath: ${dir} }\n`
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toBe(
      `there is no file at "${dir}" (argument baselinePath of screenshot-diff)`
    );
  });

  it("hands a flow_path with any extension to the tool's own checks", async () => {
    const yml = path.join(flowsDir, "elsewhere", "frag.yml");
    await fs.copyFile(path.join(flowsDir, "elsewhere", "frag.yaml"), yml);
    const result = await runOuter(
      `  - tool: e2e-read-prerequisite\n    args: { flow_path: ${yml}, project_root: ${root} }\n`
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain("e2e test files must use the .yaml extension");
  });

  it("leaves the path that a tool builds from name to the tool itself", async () => {
    const result = await runOuter(
      `  - tool: e2e-execute\n    args: { name: nope, project_root: ${root}, prerequisiteAcknowledged: true }\n`
    );

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toBe(
      `[Tool:e2e-execute] ENOENT: no such file or directory, open '${path.join(flowsDir, "nope.yaml")}'`
    );
  });
});
