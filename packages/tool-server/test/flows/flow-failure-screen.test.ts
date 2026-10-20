import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, type Registry } from "@argent/registry";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { __resetRecordingsForTesting } from "../../src/tools/flows/flow-utils";

const PROJECT_ROOT = path.join(os.tmpdir(), `flow-failure-screen-tests-${process.pid}`);

const SHOT = { id: "shot-1", kind: "screenshot", hostPath: "/tmp/shot-1.png" };

function makeRegistry(invoke: (id: string, args: unknown, opts?: object) => Promise<unknown>) {
  return {
    invokeTool: vi.fn(invoke),
    getTool: vi.fn((id: string) => ({
      inputSchema: { properties: id === "flow-execute" ? { device: {} } : { udid: {} } },
    })),
  } as unknown as Registry;
}

async function writeFlow(yaml: string): Promise<string> {
  const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
  const file = path.join(flowsDir, "screen.yaml");
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true });
});

const TAP = `  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.5
`;

const AWAIT = `  - tool: await-ui-element
    args:
      udid: X
      condition: visible
      selector:
        text: Continue
`;

const TYPE_SECRET = `  - tool: keyboard
    args:
      udid: X
      text: "{{secret:PASSWORD}}"
`;

async function run(steps: string, awaitMet: boolean, shot: () => Promise<unknown>) {
  const flowFile = await writeFlow(`executionPrerequisite: ""\nsteps:\n${steps}`);
  const registry = makeRegistry(async (id) => {
    if (id === "screenshot") return shot();
    if (id === "await-ui-element") {
      return awaitMet ? { success: true, elapsed: 10 } : { success: false, elapsed: 5000 };
    }
    return { ok: true };
  });
  const result = (await createRunFlowTool(registry).execute(
    {},
    { name: "screen", project_root: PROJECT_ROOT, flow_file: flowFile, device: "X" }
  )) as FlowRunResult;
  const shots = vi.mocked(registry.invokeTool).mock.calls.filter(([id]) => id === "screenshot");
  return { result, shots };
}

describe("flow-execute screenshot of a failed step", () => {
  it("attaches the screen to the failed step", async () => {
    const { result, shots } = await run(TAP + AWAIT + TAP, false, async () => ({ image: SHOT }));

    expect(shots).toHaveLength(1);
    expect(shots[0][1]).toMatchObject({ udid: "X", scale: 1, includeImageInContext: false });
    const failed = result.steps[1];
    expect(failed.status).toBe("fail");
    expect(failed.artifacts).toEqual({ screen: SHOT });
    expect(result.steps[0].artifacts).toBeUndefined();
    expect(result.steps[2].artifacts).toBeUndefined();
  });

  it("takes no screenshot when every step passes", async () => {
    const { result, shots } = await run(TAP + AWAIT, true, async () => ({ image: SHOT }));

    expect(result.ok).toBe(true);
    expect(shots).toHaveLength(0);
  });

  it("takes no screenshot after a step typed a secret", async () => {
    const { result, shots } = await run(TYPE_SECRET + AWAIT, false, async () => ({ image: SHOT }));

    expect(result.steps[1].status).toBe("fail");
    expect(shots).toHaveLength(0);
    expect(result.steps[1].artifacts).toBeUndefined();
  });

  it("keeps the step's own failure when the screenshot throws", async () => {
    const { result, shots } = await run(AWAIT, false, async () => {
      throw new Error("device gone");
    });

    expect(shots).toHaveLength(1);
    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).not.toMatch(/device gone/);
    expect(result.steps[0].artifacts).toBeUndefined();
  });
});

describe("flow-execute screenshot of a failed step around a nested flow", () => {
  const nestedRun = (name: string) => `  - tool: flow-execute
    args:
      name: ${name}
      project_root: ${JSON.stringify(PROJECT_ROOT)}
`;

  /**
   * Runs `root` with every flow in `flows` beside it, a `tool: flow-execute` or
   * `flow-add-step` step dispatching to the real tool as the registry does. The
   * await always fails, so each flow fails exactly where it awaits.
   */
  async function runNested(flows: Record<string, string>) {
    const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    for (const [name, steps] of Object.entries(flows)) {
      await fs.writeFile(
        path.join(flowsDir, `${name}.yaml`),
        `executionPrerequisite: ""\nsteps:\n${steps}`,
        "utf8"
      );
    }
    const registry = makeRegistry(async (id, args, opts) => {
      if (id === "screenshot") return { image: SHOT };
      if (id === "await-ui-element") return { success: false, elapsed: 5000 };
      const ctx = { artifacts: new ArtifactStore(), ...opts };
      if (id === "flow-execute") return tool.execute({}, args as never, ctx);
      if (id === "flow-add-step") return addStep.execute({}, args as never, ctx);
      return { ok: true };
    });
    const tool = createRunFlowTool(registry);
    const addStep = createFlowAddStepTool(registry);
    const result = (await tool.execute(
      {},
      { name: "root", project_root: PROJECT_ROOT, device: "X" }
    )) as FlowRunResult;
    const shots = vi.mocked(registry.invokeTool).mock.calls.filter(([id]) => id === "screenshot");
    return { result, shots };
  }

  const nestedSteps = (step: FlowRunResult["steps"][number]) =>
    (step.result as FlowRunResult).steps;

  it("takes no screenshot of a later failure after a nested flow typed a secret", async () => {
    const { result, shots } = await runNested({
      root: nestedRun("login") + AWAIT,
      login: TYPE_SECRET,
    });

    expect(result.steps.map((s) => s.status)).toEqual(["pass", "fail"]);
    expect(shots).toHaveLength(0);
    expect(result.steps[1].artifacts).toBeUndefined();
  });

  it("takes no screenshot when a nested flow fails after typing a secret", async () => {
    const { result, shots } = await runNested({
      root: nestedRun("login"),
      login: TYPE_SECRET + AWAIT,
    });

    expect(result.steps[0].status).toBe("fail");
    expect(nestedSteps(result.steps[0]).map((s) => s.status)).toEqual(["pass", "fail"]);
    expect(shots).toHaveLength(0);
    expect(result.steps[0].artifacts).toBeUndefined();
  });

  it("takes no screenshot after a secret typed two nested flows deep", async () => {
    const { result, shots } = await runNested({
      root: nestedRun("outer") + AWAIT,
      outer: nestedRun("login") + AWAIT,
      login: TYPE_SECRET,
    });

    expect(result.steps.map((s) => s.status)).toEqual(["fail", "skip"]);
    expect(nestedSteps(result.steps[0]).map((s) => s.status)).toEqual(["pass", "fail"]);
    expect(shots).toHaveLength(0);
  });

  it("takes no screenshot in a nested flow after its parent typed a secret", async () => {
    const { result, shots } = await runNested({
      root: TYPE_SECRET + nestedRun("check"),
      check: AWAIT,
    });

    expect(result.steps.map((s) => s.status)).toEqual(["pass", "fail"]);
    expect(nestedSteps(result.steps[1])[0].status).toBe("fail");
    expect(shots).toHaveLength(0);
  });

  it("takes no screenshot in a flow that a flow-add-step step runs after a secret", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "rec", project_root: PROJECT_ROOT, executionPrerequisite: "on the form" }
    );
    const addStep = `  - tool: flow-add-step
    args:
      name: rec
      project_root: ${JSON.stringify(PROJECT_ROOT)}
      command: flow-execute
      args: ${JSON.stringify(JSON.stringify({ name: "check", project_root: PROJECT_ROOT, device: "X" }))}
`;
    const { result, shots } = await runNested({
      root: TYPE_SECRET + addStep,
      check: AWAIT,
    });

    expect(result.steps.map((s) => s.status)).toEqual(["pass", "pass"]);
    const nested = (result.steps[1].result as { toolResult: FlowRunResult }).toolResult;
    expect(nested.steps[0].status).toBe("fail");
    expect(shots).toHaveLength(0);
  });

  it("still screenshots a failure around a nested flow that typed no secret", async () => {
    const { result, shots } = await runNested({
      root: nestedRun("tap") + nestedRun("check"),
      tap: TAP,
      check: AWAIT,
    });

    expect(result.steps.map((s) => s.status)).toEqual(["pass", "fail"]);
    expect(shots).toHaveLength(2);
    expect(nestedSteps(result.steps[1])[0].artifacts).toEqual({ screen: SHOT });
    expect(result.steps[1].artifacts).toEqual({ screen: SHOT });
  });
});
