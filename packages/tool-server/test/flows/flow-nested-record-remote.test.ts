import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  FAILURE_CODES,
  Registry,
  getFailureSignal,
  type ClientServiceOp,
  type InvokeToolOptions,
  type ToolContext,
} from "@argent/registry";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import {
  __resetRecordingsForTesting,
  getRecordingSession,
  parseFlow,
  serializeFlow,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";
import { screenshotDiffTool } from "../../src/tools/screenshot-diff";
import { gatherWorkspaceDataTool } from "../../src/tools/workspace/gather-workspace-data";

/**
 * flow-add-step over a link, for the calls whose files are on the client: a
 * nested flow-execute, which runs the flow the client serves and records as
 * `run:` only when the client's sibling of the recording is the flow that ran,
 * and a tool: step whose file arguments the client serves. The recorder
 * records only what a replay over the same link runs, so every other such
 * call is refused before anything runs. The nested tools are stubs on a
 * registry that reports their real file-input declarations.
 */

type ClientServices = NonNullable<ToolContext["clientServices"]>;
type ToolHandler = (args: Record<string, unknown>, options?: InvokeToolOptions) => unknown;

/** The client's project root. It exists on this host too, so a host file can share a client path. */
let root: string;
let flowsDir: string;
let recordingPath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-nested-record-remote-"));
  flowsDir = path.join(root, ".argent", "flows");
  recordingPath = path.join(flowsDir, "rec.yaml");
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

const flowText = (message: string): string =>
  serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message }] });

/** A nested run that passed, as flow-execute reports it. */
const PASSING_RUN = {
  flow: "basic",
  device: "",
  executionPrerequisite: "",
  ok: true,
  passed: 1,
  failed: 0,
  skipped: 0,
  errored: 0,
  steps: [{ index: 0, kind: "echo", status: "pass", message: "basic" }],
  startedAt: 0,
  durationMs: 1,
};

/**
 * The client side of the channel: `resolve-file` answers each flow in `flows`
 * (keyed by the client path it is spelled as, listed as written), and
 * `read-file` each file in `files`. Every other request is refused, as the
 * argent client refuses a file the recorded step does not name. Records every
 * request.
 */
function fakeClient(
  { flows = {}, files = {} }: { flows?: Record<string, string>; files?: Record<string, Buffer> },
  ops: ClientServiceOp[] = ["resolve-file", "read-file"]
): { services: ClientServices; requests: Array<{ op: string; args: Record<string, unknown> }> } {
  const requests: Array<{ op: string; args: Record<string, unknown> }> = [];
  const refuse = (op: string, subject: string): never => {
    throw new Error(
      `the client refused the ${op} request for "${subject}": ${subject} is not a file that ` +
        `the step this call records names`
    );
  };
  const services: ClientServices = {
    ops,
    roots: [root],
    request: vi.fn(async (op: ClientServiceOp, args: Record<string, unknown>) => {
      requests.push({ op, args });
      if (op === "resolve-file") {
        const spelled = path.join(String(args.anchorDir), String(args.target));
        const text = flows[spelled];
        if (text === undefined) return refuse(op, String(args.target));
        return {
          canonical: spelled,
          spelling: { state: "listed" },
          exists: true,
          size: Buffer.byteLength(text),
          mtimeMs: 1,
          content: Buffer.from(text, "utf8").toString("base64"),
        };
      }
      if (op === "read-file") {
        const bytes = files[String(args.path)];
        if (bytes === undefined) return refuse(op, String(args.path));
        return { exists: true, size: bytes.length, mtimeMs: 1, content: bytes.toString("base64") };
      }
      return refuse(op, JSON.stringify(args));
    }),
  };
  return { services, requests };
}

/**
 * A registry whose `invokeTool` runs `handlers` in place of the tools, and
 * whose `getTool` reports the real definitions of the tools these calls
 * name: the recorder reads their file inputs.
 */
function stubRegistry(handlers: Record<string, ToolHandler>): Registry {
  const registry = {
    invokeTool: vi.fn(async (id: string, args?: unknown, options?: InvokeToolOptions) => {
      const handler = handlers[id];
      if (!handler) throw new Error(`Tool "${id}" not found`);
      return handler(args as Record<string, unknown>, options);
    }),
    getTool: vi.fn(),
  } as unknown as Registry;
  const definitions: Record<string, unknown> = {
    "flow-execute": createRunFlowTool(registry),
    "screenshot-diff": screenshotDiffTool,
    "gather-workspace-data": gatherWorkspaceDataTool,
  };
  vi.mocked(registry.getTool).mockImplementation((id: string) => definitions[id] as never);
  return registry;
}

/** Start the recording `rec` over a link: it persists on the client. */
async function startLinked(): Promise<void> {
  await flowStartRecordingTool.execute(
    {},
    { name: "rec", project_root: root },
    { artifacts: new ArtifactStore(), linked: true }
  );
}

/** Start the recording `rec` without a link: it persists on this host. */
async function startHost(): Promise<void> {
  await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
}

function linkedCtx(services?: ClientServices): ToolContext {
  return {
    artifacts: new ArtifactStore(),
    linked: true,
    ...(services ? { clientServices: services } : {}),
  };
}

function addStep(
  registry: Registry,
  command: string,
  args: Record<string, unknown>,
  ctx?: ToolContext
) {
  return createFlowAddStepTool(registry).execute(
    {},
    { name: "rec", project_root: root, command, args: JSON.stringify(args) },
    ctx
  );
}

async function rejection(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to fail");
}

/** The steps of the recording as the client writes them. */
function directiveSteps(savedTo: unknown): FlowStep[] {
  return parseFlow((savedTo as { content: string }).content).steps;
}

async function takeSteps(): Promise<FlowStep[] | undefined> {
  return (await getRecordingSession(root, "rec"))?.flow.steps;
}

describe("a nested flow-execute recorded over a link", () => {
  it("records run: <name>.yaml from a client sibling served through resolve-file", async () => {
    const basicPath = path.join(flowsDir, "basic.yaml");
    const { services, requests } = fakeClient({
      flows: { [recordingPath]: "steps: []\n", [basicPath]: flowText("basic") },
    });
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: root },
      linkedCtx(services)
    );

    expect(result.recorded).toBe("1. run: basic.yaml");
    expect(directiveSteps(result.savedTo)).toEqual([{ kind: "run", flow: "basic.yaml" }]);
    // Every answer came from the client: the recording itself and the sibling,
    // which is also the flow the nested run executed.
    expect(requests.map((r) => r.op)).toEqual(["resolve-file", "resolve-file"]);
    expect(requests.map((r) => path.join(String(r.args.anchorDir), String(r.args.target)))).toEqual(
      [basicPath, recordingPath]
    );
    await expect(fs.stat(flowsDir)).rejects.toThrow();
  });

  it("keeps the raw step when the client sibling does not parse", async () => {
    const { services } = fakeClient({
      flows: {
        [recordingPath]: "steps: []\n",
        [path.join(flowsDir, "basic.yaml")]: "steps:\n  - nonsense: true\n",
      },
    });
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: root },
      linkedCtx(services)
    );

    expect(result.message).toContain('could not resolve "basic" as a sibling fragment');
    expect(result.message).toContain("kept the raw flow-execute step");
    expect(directiveSteps(result.savedTo)).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "basic", project_root: root } },
    ]);
  });

  it("keeps the raw step when the client refuses the sibling", async () => {
    // The nested run names a sub-project inside the client root, so the
    // sibling in the recording's folder is another file than the flow that
    // ran, and the client does not serve it. Distinct (anchor, target) pairs,
    // so the client's answer for the flow that ran is not reused for it.
    const subRoot = path.join(root, "sub");
    const subBasic = path.join(subRoot, ".argent", "flows", "basic.yaml");
    const { services, requests } = fakeClient({
      flows: { [recordingPath]: "steps: []\n", [subBasic]: flowText("sub basic") },
    });
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: subRoot },
      linkedCtx(services)
    );

    expect(requests).toContainEqual({
      op: "resolve-file",
      args: { anchorDir: flowsDir, target: "basic.yaml", kind: "flow" },
    });
    expect(result.message).toContain(
      `could not resolve "basic" as a sibling fragment (the client refused the resolve-file ` +
        `request for "basic.yaml"`
    );
    expect(result.message).toContain("kept the raw flow-execute step");
    expect(directiveSteps(result.savedTo)).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "basic", project_root: subRoot } },
    ]);
  });

  it("keeps the raw step when the client serves a sibling that is another file than the flow that ran", async () => {
    // A client that serves both: the sibling parses, but a `run:` of it would
    // replay another flow than the one that just ran.
    const subRoot = path.join(root, "sub");
    const subBasic = path.join(subRoot, ".argent", "flows", "basic.yaml");
    const sibling = path.join(flowsDir, "basic.yaml");
    const { services } = fakeClient({
      flows: {
        [recordingPath]: "steps: []\n",
        [subBasic]: flowText("sub basic"),
        [sibling]: flowText("sibling basic"),
      },
    });
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: subRoot },
      linkedCtx(services)
    );

    expect(result.message).toContain(
      `kept the raw flow-execute step — project_root "${subRoot}" resolves "basic" to ` +
        `"${subBasic}", not the recording's sibling "${sibling}"`
    );
    expect(directiveSteps(result.savedTo)).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "basic", project_root: subRoot } },
    ]);
  });

  it("runs the live nested flow-execute from the client copy, not the host file", async () => {
    // This host has a different flow at the same path as the client's.
    const basicPath = path.join(flowsDir, "basic.yaml");
    const hostText = flowText("from the host");
    const clientText = flowText("from the client");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(basicPath, hostText);
    const { services } = fakeClient({
      flows: { [recordingPath]: "steps: []\n", [basicPath]: clientText },
    });
    const seen: Array<{
      args: Record<string, unknown>;
      options?: InvokeToolOptions;
      text: string;
    }> = [];
    const registry = stubRegistry({
      "flow-execute": async (args, options) => {
        seen.push({ args, options, text: await fs.readFile(String(args.flow_file), "utf8") });
        return PASSING_RUN;
      },
    });
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: root },
      linkedCtx(services)
    );

    expect(seen).toHaveLength(1);
    const [{ args, options, text }] = seen;
    expect(args).toMatchObject({ name: "basic", project_root: root });
    expect(args.flow_file).not.toBe(basicPath);
    expect(options?.fileInputs?.flow_file).toMatchObject({
      clientPath: basicPath,
      viaUpload: true,
    });
    expect(text).toBe(clientText);
    // The nested run resolves its own files through this call's channel.
    expect(options?.clientServices).toBe(services);
    // The upload lives for the invoke only, and the host file is untouched.
    await expect(fs.stat(String(args.flow_file))).rejects.toThrow();
    expect(await fs.readFile(basicPath, "utf8")).toBe(hostText);
    expect(directiveSteps(result.savedTo)).toEqual([{ kind: "run", flow: "basic.yaml" }]);
  });

  it("runs a real nested flow-execute on the client copy", async () => {
    // The real tool on a real registry: it accepts the upload the recorder
    // hands it, runs the client's flow and not the host file at the same path,
    // and resolves that flow's `run:` fragment, which only the client has,
    // through the forwarded channel. A `run:` step binds a device, so the call
    // names one, which no step then acts on.
    const basicPath = path.join(flowsDir, "basic.yaml");
    const innerPath = path.join(flowsDir, "inner.yaml");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(basicPath, flowText("from the host"));
    const clientBasic = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "from the client" },
        { kind: "run", flow: "inner.yaml" },
      ],
    });
    const { services, requests } = fakeClient({
      flows: {
        [recordingPath]: "steps: []\n",
        [basicPath]: clientBasic,
        [innerPath]: flowText("inner on the client"),
      },
    });
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry));
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: root, device: "00000000-0000-0000-0000-0000000000ab" },
      linkedCtx(services)
    );

    expect(result.toolResult).toMatchObject({ flow: "basic", ok: true, failed: 0, errored: 0 });
    const report = JSON.stringify((result.toolResult as { steps: unknown }).steps);
    expect(report).toContain("from the client");
    expect(report).toContain("inner on the client");
    expect(report).not.toContain("from the host");
    // The recorder asks for the flow to run, the nested run for its own root
    // and its fragment, and the recorder then for the recording itself.
    expect(requests.map((r) => path.join(String(r.args.anchorDir), String(r.args.target)))).toEqual(
      [basicPath, basicPath, innerPath, recordingPath]
    );
    expect(directiveSteps(result.savedTo)).toEqual([{ kind: "run", flow: "basic.yaml" }]);
  });

  it("refuses a nested flow-execute before the invoke when the call carries no client services", async () => {
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const err = await rejection(
      addStep(registry, "flow-execute", { name: "basic", project_root: root }, linkedCtx())
    );

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "flow_upload_nested_flow",
    });
    expect(err.message).toContain(
      'a replay over the same link refuses the step "tool: flow-execute (name: basic)". ' +
        "Nothing ran and no step was recorded."
    );
    expect(err.message).toContain(
      "Over a link, a nested flow-execute runs only when the argent client serves the flow it names."
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await takeSteps()).toEqual([]);
  });
});

describe("client services from a client that sends no link header", () => {
  // An older argent client serves what the recording file names, not what the
  // recorded step names, so the recorder does not ask it for files.
  it("refuses a nested flow-execute in a client take, without a request to that client", async () => {
    const { services, requests } = fakeClient({
      flows: { [path.join(flowsDir, "basic.yaml")]: flowText("basic") },
    });
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const err = await rejection(
      addStep(
        registry,
        "flow-execute",
        { name: "basic", project_root: root },
        { artifacts: new ArtifactStore(), clientServices: services }
      )
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_nested_flow");
    expect(err.message).toContain("Update the argent CLI or MCP adapter on the client.");
    expect(requests).toEqual([]);
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await takeSteps()).toEqual([]);
  });

  it("records a nested flow-execute in a host take as without a link", async () => {
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(path.join(flowsDir, "basic.yaml"), flowText("basic"));
    const { services, requests } = fakeClient({});
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startHost();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: root },
      { artifacts: new ArtifactStore(), clientServices: services }
    );

    expect(result.recorded).toBe("1. run: basic.yaml");
    expect(requests).toEqual([]);
    // The nested run read this host's file: no upload, no client services.
    const options = vi.mocked(registry.invokeTool).mock.calls[0]?.[2];
    expect(options?.fileInputs).toBeUndefined();
    expect(options?.clientServices).toBeUndefined();
  });
});

describe("a tool: step with file arguments recorded over a link", () => {
  it("refuses a tool step with a directory argument before the invoke", async () => {
    const { services, requests } = fakeClient({});
    const registry = stubRegistry({ "gather-workspace-data": () => ({}) });
    await startLinked();

    const err = await rejection(
      addStep(registry, "gather-workspace-data", { workspacePath: root }, linkedCtx(services))
    );

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "flow_upload_tool_file_input",
    });
    expect(err.message).toContain(
      `refuses the step "tool: gather-workspace-data (${root})". Nothing ran and no step was recorded.`
    );
    expect(err.message).toContain(
      "A replay without a link runs this step. To keep it, add it to the YAML by hand after " +
        "flow-finish-recording."
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(await takeSteps()).toEqual([]);
  });

  it("records a screenshot-diff step with a client .png baseline read through read-file", async () => {
    const baselinePath = path.join(root, "shots", "base.png");
    const clientBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
    const { services, requests } = fakeClient({ files: { [baselinePath]: clientBytes } });
    const seen: Array<{
      args: Record<string, unknown>;
      options?: InvokeToolOptions;
      bytes: Buffer;
    }> = [];
    const registry = stubRegistry({
      "screenshot-diff": async (args, options) => {
        seen.push({ args, options, bytes: await fs.readFile(String(args.baselinePath)) });
        return { summary: "stubbed diff" };
      },
    });
    await startLinked();

    const result = await addStep(
      registry,
      "screenshot-diff",
      { udid: "DEVICE-1", baselinePath, captureCurrent: true },
      linkedCtx(services)
    );

    expect(requests).toEqual([{ op: "read-file", args: { path: baselinePath } }]);
    expect(seen).toHaveLength(1);
    const [{ args, options, bytes }] = seen;
    expect(args.baselinePath).not.toBe(baselinePath);
    expect(bytes.equals(clientBytes)).toBe(true);
    expect(options?.fileInputs?.baselinePath).toMatchObject({
      clientPath: baselinePath,
      viaUpload: true,
    });
    // Only a nested flow-execute gets the channel.
    expect(options?.clientServices).toBeUndefined();
    await expect(fs.stat(String(args.baselinePath))).rejects.toThrow();
    expect(directiveSteps(result.savedTo)).toEqual([
      {
        kind: "tool",
        name: "screenshot-diff",
        args: { baselinePath, captureCurrent: true },
      },
    ]);
  });
});

describe("a nested flow-execute that does not pass", () => {
  const FAILED_RUN = {
    ...PASSING_RUN,
    ok: false,
    passed: 1,
    failed: 1,
    steps: [
      { index: 0, kind: "echo", status: "pass", message: "basic" },
      { index: 1, kind: "tool", tool: "gesture-tap", status: "fail", reason: "no element matched" },
    ],
  };

  it("records nothing when the nested flow fails, and returns the failing step", async () => {
    const { services } = fakeClient({
      flows: {
        [recordingPath]: "steps: []\n",
        [path.join(flowsDir, "basic.yaml")]: flowText("basic"),
      },
    });
    const registry = stubRegistry({ "flow-execute": () => FAILED_RUN });
    await startLinked();

    const err = await rejection(
      addStep(registry, "flow-execute", { name: "basic", project_root: root }, linkedCtx(services))
    );

    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_FILE_INVALID,
      failure_stage: "flow_add_step_nested_failed",
    });
    expect(err.message).toBe(
      'Cannot record this call: the nested flow did not pass (flow "basic" failed: 1 passed, ' +
        "1 failed, 0 errored (gesture-tap: no element matched)). A replay over the same link " +
        "fails at the same step. No step was recorded. Fix the nested flow, then call " +
        "flow-add-step again."
    );
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
    expect(await takeSteps()).toEqual([]);
  });

  it.each([
    [
      "an unacknowledged prerequisite",
      { flow: "basic", notice: "Confirm the prerequisite first.", executionPrerequisite: "Home" },
      'flow "basic" did not run — its execution prerequisite was not acknowledged: Home.',
    ],
    ["an aborted run", { ...PASSING_RUN, ok: false, aborted: true }, 'flow "basic" was aborted'],
  ])(
    "records nothing when the nested flow did not run, with the did-not-run message (%s)",
    async (_case, report, reason) => {
      const { services } = fakeClient({
        flows: {
          [recordingPath]: "steps: []\n",
          [path.join(flowsDir, "basic.yaml")]: flowText("basic"),
        },
      });
      const registry = stubRegistry({ "flow-execute": () => report });
      await startLinked();

      const err = await rejection(
        addStep(
          registry,
          "flow-execute",
          { name: "basic", project_root: root },
          linkedCtx(services)
        )
      );

      expect(getFailureSignal(err)?.failure_stage).toBe("flow_add_step_nested_failed");
      expect(err.message).toContain(
        `Cannot record this call: the nested flow did not run (${reason}`
      );
      expect(err.message).toMatch(/\)\. No step was recorded\.$/);
      expect(err.message).not.toContain("A replay over the same link fails");
      expect(await takeSteps()).toEqual([]);
    }
  );

  it("records a failed nested flow without a link", async () => {
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(path.join(flowsDir, "basic.yaml"), flowText("basic"));
    const registry = stubRegistry({ "flow-execute": () => FAILED_RUN });
    await startHost();

    const result = await addStep(registry, "flow-execute", { name: "basic", project_root: root });

    // No link: the host path is invoked as is, and the step is recorded.
    expect(vi.mocked(registry.invokeTool).mock.calls).toEqual([
      ["flow-execute", { name: "basic", project_root: root }],
    ]);
    expect(result.toolResult).toEqual(FAILED_RUN);
    expect(result.savedTo).toBe(recordingPath);
    expect(parseFlow(await fs.readFile(recordingPath, "utf8")).steps).toEqual([
      { kind: "run", flow: "basic.yaml" },
    ]);
  });

  it("refuses a linked call into a host take with the same checks", async () => {
    const registry = stubRegistry({
      "gather-workspace-data": () => ({}),
      "flow-execute": () => PASSING_RUN,
    });
    await startHost();

    const directory = await rejection(
      addStep(registry, "gather-workspace-data", { workspacePath: root }, linkedCtx())
    );
    expect(getFailureSignal(directory)?.failure_stage).toBe("flow_upload_tool_file_input");

    const nested = await rejection(
      addStep(registry, "flow-execute", { name: "basic", project_root: root }, linkedCtx())
    );
    expect(getFailureSignal(nested)?.failure_stage).toBe("flow_upload_nested_flow");

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await fs.readFile(recordingPath, "utf8")).steps).toEqual([]);
  });
});
