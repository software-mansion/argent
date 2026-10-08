import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  FAILURE_CODES,
  flowMemberKey,
  getFailureSignal,
  MAX_RUN_DEPTH,
  Registry,
  type ResolvedMember,
} from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import {
  __resetRecordingsForTesting,
  getRecordingSession,
  parseFlow,
  serializeFlow,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

/**
 * The cycle and depth guards of a flow run cover nested runs as well as `run:`
 * fragments: a `tool: flow-execute` step, and a `tool: flow-add-step` step that
 * runs flow-execute, pass the run stack on to the run they start. The REAL
 * flow-execute and flow-add-step are registered in a real registry, so each
 * nested call actually runs; flows are on a temp disk unless a test says
 * otherwise.
 */

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

let root = "";
let flowsDir = "";

beforeEach(async () => {
  __resetRecordingsForTesting();
  // realpath'd: the runner keys its run stack on canonical paths.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-nesting-bound-")));
  flowsDir = path.join(root, ".argent", "flows");
  await fs.mkdir(flowsDir, { recursive: true });
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

function realRegistry() {
  const registry = new Registry();
  registry.registerTool(createRunFlowTool(registry) as never);
  registry.registerTool(createFlowAddStepTool(registry) as never);
  const invoke = vi.spyOn(registry, "invokeTool");
  return { registry, invoke };
}

/** How many times `tool` was dispatched through the registry. */
function countOf(invoke: ReturnType<typeof realRegistry>["invoke"], tool: string): number {
  return invoke.mock.calls.filter(([id]) => id === tool).length;
}

/** What the dispatch of `tool` numbered `nth` (0-based) settled with. */
function settledOf(invoke: ReturnType<typeof realRegistry>["invoke"], tool: string, nth: number) {
  const indexes = invoke.mock.calls.flatMap(([id], i) => (id === tool ? [i] : []));
  return invoke.mock.settledResults[indexes[nth]!]!;
}

async function writeFlow(name: string, steps: FlowStep[]): Promise<void> {
  const file = path.join(flowsDir, `${name}.yaml`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializeFlow({ executionPrerequisite: "", steps }), "utf8");
}

const runsFlow = (name: string, projectRoot = root): FlowStep => ({
  kind: "tool",
  name: "flow-execute",
  args: { name, project_root: projectRoot },
});

function run(registry: Registry, name: string): Promise<FlowRunResult> {
  return registry.invokeTool<FlowRunResult>("flow-execute", {
    name,
    project_root: root,
    device: DEVICE,
  });
}

/** Write the chain f0 -> f1 -> ... -> f{count-1}, each running the next by tool: flow-execute. */
async function writeNestedChain(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await writeFlow(
      `f${i}`,
      i === count - 1 ? [{ kind: "echo", message: "deepest" }] : [runsFlow(`f${i + 1}`)]
    );
  }
}

describe("nesting bound of tool: flow-execute", () => {
  it("stops a flow that runs itself through tool: flow-execute with the cycle error, without a link", async () => {
    await writeFlow("selfy", [runsFlow("selfy")]);
    const { registry, invoke } = realRegistry();

    const result = await run(registry, "selfy");

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:error"]);
    expect(result.steps[0]!.reason).toContain("cyclic flow reference: selfy → selfy");
    // The run itself and the one nested run the guard refused.
    expect(countOf(invoke, "flow-execute")).toBe(2);
    const refused = settledOf(invoke, "flow-execute", 1);
    expect(refused.type).toBe("rejected");
    expect(getFailureSignal(refused.value)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "flow_run_validate",
    });
  });

  it("stops a nesting chain deeper than MAX_RUN_DEPTH", async () => {
    // MAX_RUN_DEPTH + 1 distinct flows: the last one is the first run past the
    // limit, so it is refused, and each run above reports its nested failure.
    await writeNestedChain(MAX_RUN_DEPTH + 1);
    const { registry, invoke } = realRegistry();

    const result = await run(registry, "f0");

    expect(result.ok).toBe(false);
    expect(result.steps[0]!.status).toBe("fail");
    expect(result.steps[0]!.reason).toContain("max run depth exceeded");
    expect(countOf(invoke, "flow-execute")).toBe(MAX_RUN_DEPTH + 1);
    const deepest = settledOf(invoke, "flow-execute", MAX_RUN_DEPTH);
    expect(invoke.mock.calls.filter(([id]) => id === "flow-execute").at(-1)![1]).toMatchObject({
      name: `f${MAX_RUN_DEPTH}`,
    });
    expect(deepest.type).toBe("rejected");
    expect((deepest.value as Error).message).toContain("max run depth exceeded");
    expect(getFailureSignal(deepest.value)?.failure_stage).toBe("flow_run_validate");
  });

  it("runs a nesting chain of exactly MAX_RUN_DEPTH flows", async () => {
    // The boundary below the refusal above: one flow fewer runs to the end.
    await writeNestedChain(MAX_RUN_DEPTH);
    const { registry, invoke } = realRegistry();

    const result = await run(registry, "f0");

    expect(result.ok).toBe(true);
    expect(countOf(invoke, "flow-execute")).toBe(MAX_RUN_DEPTH);
  });

  it("detects a cycle that mixes run: and tool: flow-execute", async () => {
    await writeFlow("a", [{ kind: "run", flow: "b.yaml" }]);
    await writeFlow("b", [runsFlow("a")]);
    const { registry, invoke } = realRegistry();

    const result = await run(registry, "a");

    expect(result.steps.map((s) => `${s.kind}:${s.status}:${s.depth ?? 0}`)).toEqual([
      "run:pass:0",
      "tool:error:1",
    ]);
    expect(result.steps[1]!.reason).toContain("cyclic flow reference: a → b → a");
    expect(countOf(invoke, "flow-execute")).toBe(2);
  });

  it("stops a client-sent flow that runs itself", async () => {
    // A flow with no run: or snapshot step keeps its client path as spelled as
    // its canonical, so the outer flow's client path is spelled exactly as the
    // nested step's project_root and name build it.
    const selfy = serializeFlow({
      executionPrerequisite: "",
      steps: [runsFlow("selfy", "/client")],
    });
    const uploaded = path.join(root, "upload", "selfy.yaml");
    await fs.mkdir(path.dirname(uploaded), { recursive: true });
    await fs.writeFile(uploaded, selfy, "utf8");
    const members = sentFlows({ "/client/.argent/flows/selfy.yaml": selfy });
    const { registry, invoke } = realRegistry();

    const result = await registry.invokeTool<FlowRunResult>(
      "flow-execute",
      { name: "selfy", project_root: "/client", flow_file: uploaded, device: DEVICE },
      {
        fileInputs: {
          flow_file: {
            clientPath: "/client/.argent/flows/selfy.yaml",
            presentOnHost: false,
            viaUpload: true,
            canonical: "/client/.argent/flows/selfy.yaml",
            spelling: { state: "listed" },
            members,
          },
        },
        linked: true,
      }
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:error"]);
    expect(result.steps[0]!.reason).toContain("cyclic flow reference: selfy → selfy");
    expect(countOf(invoke, "flow-execute")).toBe(2);
    // The nested run read the flow from the members of the call.
    const nestedOptions = invoke.mock.calls.filter(([id]) => id === "flow-execute")[1]![2];
    expect(nestedOptions?.fileInputs?.flow_file?.members).toBe(members);
  });

  it("keeps the report name helpers/login for a nested flow login with run: helpers/login.yaml", async () => {
    // The fragment's stem equals the name of the nested run's own root flow,
    // so its steps are named by the path as written, not by the stem, also
    // when an outer run encloses the nested one.
    await writeFlow("x", [runsFlow("login")]);
    await writeFlow("login", [{ kind: "run", flow: "helpers/login.yaml" }]);
    await writeFlow("helpers/login", [{ kind: "echo", message: "helper" }]);
    const { registry } = realRegistry();

    const result = await run(registry, "x");

    expect(result.ok).toBe(true);
    const nested = result.steps[0]!.result as FlowRunResult;
    expect(nested.flow).toBe("login");
    expect(nested.steps.map((s) => `${s.kind}:${s.status}:${s.flow}`)).toEqual([
      "run:pass:helpers/login",
      "echo:pass:helpers/login",
    ]);
  });
});

describe("nesting bound of tool: flow-add-step", () => {
  it("records nothing for a linked flow-add-step whose nested flow runs itself", async () => {
    const selfy = serializeFlow({
      executionPrerequisite: "",
      steps: [runsFlow("selfy", "/client")],
    });
    // What a current client sends with the flow-add-step call: the nested
    // flow, its sibling beside the recording (the same file), and the
    // recording itself.
    const members = sentFlows({
      "/client/.argent/flows/selfy.yaml": selfy,
      "/client/.argent/flows/rec.yaml": serializeFlow({ executionPrerequisite: "", steps: [] }),
    });
    const { registry, invoke } = realRegistry();
    await flowStartRecordingTool.execute(
      {},
      { name: "rec", project_root: "/client" },
      { artifacts: new ArtifactStore(), linked: true }
    );

    const err = await registry
      .invokeTool(
        "flow-add-step",
        {
          name: "rec",
          project_root: "/client",
          command: "flow-execute",
          args: JSON.stringify({ name: "selfy", project_root: "/client", device: DEVICE }),
        },
        {
          linked: true,
          fileInputs: {
            project_root: {
              clientPath: "/client",
              presentOnHost: false,
              viaUpload: false,
              members,
            },
          },
        }
      )
      .then(
        () => null,
        (e: unknown) => e
      );

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "flow_add_step_nested_failed",
    });
    expect((err as Error).message).toContain("cyclic flow reference: selfy → selfy");
    // The live call and the one nested run the guard refused.
    expect(countOf(invoke, "flow-execute")).toBe(2);
    expect((await getRecordingSession("/client", "rec"))!.flow.steps).toEqual([]);
  });

  it("stops a flow whose tool: flow-add-step step re-runs the same flow, without a link", async () => {
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    await writeFlow("a", [
      {
        kind: "tool",
        name: "flow-add-step",
        args: {
          name: "rec",
          project_root: root,
          command: "flow-execute",
          args: JSON.stringify({ name: "a", project_root: root }),
        },
      },
    ]);
    const { registry, invoke } = realRegistry();

    const result = await run(registry, "a");

    expect(result.ok).toBe(false);
    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:error"]);
    expect(result.steps[0]!.reason).toContain("cyclic flow reference: a → a");
    expect(countOf(invoke, "flow-add-step")).toBe(1);
    expect(countOf(invoke, "flow-execute")).toBe(2);
    const recorded = parseFlow(await fs.readFile(path.join(flowsDir, "rec.yaml"), "utf8"));
    expect(recorded.steps).toEqual([]);
  });
});

/**
 * The flows a client sent with a call (by client path, each in its own
 * directory), as the file-input boundary resolves them: each keyed as the
 * runner looks it up, by its directory and file name.
 */
function sentFlows(files: Record<string, string>): Record<string, ResolvedMember> {
  const members: Record<string, ResolvedMember> = {};
  for (const [file, text] of Object.entries(files)) {
    members[flowMemberKey(path.posix.dirname(file), path.posix.basename(file))] = {
      role: "flow",
      state: "present",
      canonical: file,
      spelling: { state: "listed" },
      text,
    };
  }
  return members;
}
