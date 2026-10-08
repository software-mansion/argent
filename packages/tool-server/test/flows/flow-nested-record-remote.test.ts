import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  FAILURE_CODES,
  Registry,
  flowMemberKey,
  getFailureSignal,
  type InvokeToolOptions,
  type ResolvedMember,
  type ToolContext,
} from "@argent/registry";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { ClientProjectAccess } from "../../src/tools/flows/project-access";
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
 * nested flow-execute, which runs the flow the client sent with the call and
 * records as `run:` only when the client's sibling of the recording is the
 * flow that ran, and a tool: step whose file arguments the client sent. The
 * client sends them as the members of the call's `project_root` probe. The
 * recorder records only what a replay over the same link runs, so every other
 * such call is refused before anything runs. The nested tools are stubs on a
 * registry that reports their real file-input declarations.
 */

type Members = Record<string, ResolvedMember>;
type ToolHandler = (args: Record<string, unknown>, options?: InvokeToolOptions) => unknown;

/** The client's project root. It exists on this host too, so a host file can share a client path. */
let root: string;
let flowsDir: string;
let recordingPath: string;
/** Where the tool-server materializes the bytes of the files the client sent. */
let uploads: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-nested-record-remote-"));
  uploads = await fs.mkdtemp(path.join(os.tmpdir(), "flow-nested-record-remote-uploads-"));
  flowsDir = path.join(root, ".argent", "flows");
  recordingPath = path.join(flowsDir, "rec.yaml");
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(uploads, { recursive: true, force: true });
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
 * What a current argent client sends with a flow-add-step call over a link,
 * as the tool-server resolves it: each flow in `flows` (keyed by the client
 * path it is spelled as, which is also its real path, listed as written)
 * under the key the recorder looks it up by, its directory and basename, each
 * path of `missing` as a flow the client does not have, and each file
 * argument in `files` by its client path, its bytes written to this host as
 * the resolver materializes them. Nothing else: a lookup of any other file is
 * refused.
 */
async function clientFiles({
  flows = {},
  files = {},
  missing = [],
}: {
  flows?: Record<string, string>;
  files?: Record<string, Buffer>;
  missing?: string[];
}): Promise<Members> {
  const members: Members = {};
  const key = (spelled: string) => flowMemberKey(path.dirname(spelled), path.basename(spelled));
  for (const spelled of missing) {
    members[key(spelled)] = {
      role: "flow",
      state: "missing",
      canonical: spelled,
      spelling: { state: "absent" },
    };
  }
  for (const [spelled, text] of Object.entries(flows)) {
    members[key(spelled)] = {
      role: "flow",
      state: "present",
      canonical: spelled,
      spelling: { state: "listed" },
      text,
    };
  }
  for (const [clientPath, bytes] of Object.entries(files)) {
    const hostPath = path.join(
      uploads,
      `${Object.keys(members).length}-${path.basename(clientPath)}`
    );
    await fs.writeFile(hostPath, bytes);
    members[clientPath] = { role: "tool", state: "present", hostPath };
  }
  return members;
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

/** A call over a link: with `members`, from a current client; without, from one that sends no files. */
function linkedCtx(members?: Members): ToolContext {
  return {
    artifacts: new ArtifactStore(),
    linked: true,
    ...(members ? { fileInputs: probeWith(members) } : {}),
  };
}

/** The resolved `project_root` probe of flow-add-step, carrying the files of its step. */
function probeWith(members: Members): ToolContext["fileInputs"] {
  return { project_root: { clientPath: root, presentOnHost: true, viaUpload: false, members } };
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
  it("records run: <name>.yaml from a client sibling sent with the call", async () => {
    const basicPath = path.join(flowsDir, "basic.yaml");
    const members = await clientFiles({
      flows: { [recordingPath]: "steps: []\n", [basicPath]: flowText("basic") },
    });
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: root },
      linkedCtx(members)
    );

    expect(result.recorded).toBe("1. run: basic.yaml");
    expect(directiveSteps(result.savedTo)).toEqual([{ kind: "run", flow: "basic.yaml" }]);
    expect(result).not.toHaveProperty("baselineWrites");
    // Every file came from the client: nothing was written or read on this host.
    await expect(fs.stat(flowsDir)).rejects.toThrow();
  });

  it("keeps the raw step when the client sibling does not parse", async () => {
    const members = await clientFiles({
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
      linkedCtx(members)
    );

    expect(result.message).toContain('could not resolve "basic" as a sibling fragment');
    expect(result.message).toContain("kept the raw flow-execute step");
    expect(directiveSteps(result.savedTo)).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "basic", project_root: root } },
    ]);
  });

  it("keeps the raw step when the client has no sibling", async () => {
    // The nested run names a sub-project inside the client root, and the
    // recording's folder has no basic.yaml: the client sends it as missing.
    const subRoot = path.join(root, "sub");
    const subBasic = path.join(subRoot, ".argent", "flows", "basic.yaml");
    const sibling = path.join(flowsDir, "basic.yaml");
    const members = await clientFiles({
      flows: { [recordingPath]: "steps: []\n", [subBasic]: flowText("sub basic") },
      missing: [sibling],
    });
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: subRoot },
      linkedCtx(members)
    );

    expect(result.message).toContain(
      `could not resolve "basic" as a sibling fragment (ENOENT: no such file or directory, ` +
        `open '${sibling}')`
    );
    expect(result.message).toContain("kept the raw flow-execute step");
    expect(directiveSteps(result.savedTo)).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "basic", project_root: subRoot } },
    ]);
  });

  it("keeps the raw step when the client did not send the sibling", async () => {
    // A lookup of a file the call did not carry is the client's refusal.
    const subRoot = path.join(root, "sub");
    const subBasic = path.join(subRoot, ".argent", "flows", "basic.yaml");
    const members = await clientFiles({
      flows: { [recordingPath]: "steps: []\n", [subBasic]: flowText("sub basic") },
    });
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: subRoot },
      linkedCtx(members)
    );

    expect(result.message).toContain(
      `could not resolve "basic" as a sibling fragment (the client refused to send ` +
        `"basic.yaml": basic.yaml is not a run: target of a flow this client sent)`
    );
    expect(directiveSteps(result.savedTo)).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "basic", project_root: subRoot } },
    ]);
  });

  it("keeps the raw step when the client sends a sibling that is another file than the flow that ran", async () => {
    // The sibling parses, but a `run:` of it would replay another flow than
    // the one that just ran.
    const subRoot = path.join(root, "sub");
    const subBasic = path.join(subRoot, ".argent", "flows", "basic.yaml");
    const sibling = path.join(flowsDir, "basic.yaml");
    const members = await clientFiles({
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
      linkedCtx(members)
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
    const members = await clientFiles({
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
      linkedCtx(members)
    );

    expect(seen).toHaveLength(1);
    const [{ args, options, text }] = seen;
    expect(args).toMatchObject({ name: "basic", project_root: root });
    expect(args.flow_file).not.toBe(basicPath);
    expect(options?.fileInputs?.flow_file).toMatchObject({
      clientPath: basicPath,
      viaUpload: true,
      canonical: basicPath,
      spelling: { state: "listed" },
    });
    expect(text).toBe(clientText);
    // The nested run finds its own files among the same members, and runs as
    // a nested run with no enclosing one.
    expect(options?.fileInputs?.flow_file?.members).toBe(members);
    expect(options?.flowStack).toEqual([]);
    // The upload lives for the invoke only, and the host file is untouched.
    await expect(fs.stat(String(args.flow_file))).rejects.toThrow();
    expect(await fs.readFile(basicPath, "utf8")).toBe(hostText);
    expect(directiveSteps(result.savedTo)).toEqual([{ kind: "run", flow: "basic.yaml" }]);
  });

  it("runs a real nested flow-execute on the client copy", async () => {
    // The real tool on a real registry: it accepts the upload the recorder
    // hands it, runs the client's flow and not the host file at the same path,
    // and resolves that flow's `run:` fragment, which only the client has,
    // among the members the recorder forwards. A `run:` step binds a device,
    // so the call names one, which no step then acts on.
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
    const members = await clientFiles({
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
      linkedCtx(members)
    );

    expect(result.toolResult).toMatchObject({ flow: "basic", ok: true, failed: 0, errored: 0 });
    const report = JSON.stringify((result.toolResult as { steps: unknown }).steps);
    expect(report).toContain("from the client");
    expect(report).toContain("inner on the client");
    expect(report).not.toContain("from the host");
    expect(directiveSteps(result.savedTo)).toEqual([{ kind: "run", flow: "basic.yaml" }]);
  });

  it("returns the baselines the nested run wrote, for the client to write", async () => {
    // The nested run writes into the overlay of the call's files; flow-add-step,
    // the outermost run of the call, returns those writes as directives. The
    // stub stands in for a nested run that wrote one baseline.
    const basicPath = path.join(flowsDir, "basic.yaml");
    const baseline = path.join(flowsDir, "__baselines__", "basic", "page__chromium-1x1.png");
    const bytes = Buffer.from("new baseline bytes");
    const members = await clientFiles({
      flows: { [recordingPath]: "steps: []\n", [basicPath]: flowText("snap") },
    });
    const registry = stubRegistry({
      "flow-execute": async (args, options) => {
        const nested = new ClientProjectAccess(options!.fileInputs!.flow_file!.members!);
        await nested.writeBaseline(baseline, bytes);
        // A nested run returns none itself: the call's outermost run does.
        expect(nested.baselineDirectives()).toHaveLength(1);
        expect(args.updateBaselines).toBe(true);
        return PASSING_RUN;
      },
    });
    await startLinked();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: root, updateBaselines: true },
      linkedCtx(members)
    );

    expect(result.baselineWrites).toEqual([
      {
        __argentClientFile: true,
        path: baseline,
        content: bytes.toString("base64"),
        encoding: "base64",
      },
    ]);
    expect(result.recorded).toBe("1. run: basic.yaml");
  });

  it("refuses a nested flow-execute before the invoke when the call carries no files", async () => {
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
      "Over a link, a nested flow-execute runs only when the argent client sends the flow it " +
        "names with the call. Update the argent CLI or MCP adapter on the client."
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await takeSteps()).toEqual([]);
  });

  it("refuses a nested flow-execute whose flow_path is outside the recording folder", async () => {
    const members = await clientFiles({ flows: { [recordingPath]: "steps: []\n" } });
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const err = await rejection(
      addStep(
        registry,
        "flow-execute",
        { flow_path: path.join(root, "shared", "login.yaml"), project_root: root },
        linkedCtx(members)
      )
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("flow_add_step_flow_path");
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await takeSteps()).toEqual([]);
  });

  it("refuses a nested flow that the client does not have, and records nothing", async () => {
    // The client sent the flow as missing; the recorder reads it before the
    // nested run starts.
    const missingPath = path.join(flowsDir, "nosuchflow.yaml");
    const members = await clientFiles({
      flows: { [recordingPath]: "steps: []\n" },
      missing: [missingPath],
    });
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry));
    await startLinked();

    const err = await rejection(
      addStep(
        registry,
        "flow-execute",
        { name: "nosuchflow", project_root: root },
        linkedCtx(members)
      )
    );

    expect(err.message).toBe(`ENOENT: no such file or directory, open '${missingPath}'`);
    expect(await takeSteps()).toEqual([]);
  });
});

describe("a call from a client that sends no link header and no files", () => {
  // An older argent client sends neither, so the recorder has no files of the
  // step to read.
  it("refuses a nested flow-execute in a client take", async () => {
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startLinked();

    const err = await rejection(
      addStep(
        registry,
        "flow-execute",
        { name: "basic", project_root: root },
        { artifacts: new ArtifactStore() }
      )
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_nested_flow");
    expect(err.message).toContain("Update the argent CLI or MCP adapter on the client.");
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await takeSteps()).toEqual([]);
  });

  it("records a nested flow-execute in a host take as without a link", async () => {
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(path.join(flowsDir, "basic.yaml"), flowText("basic"));
    const registry = stubRegistry({ "flow-execute": () => PASSING_RUN });
    await startHost();

    const result = await addStep(
      registry,
      "flow-execute",
      { name: "basic", project_root: root },
      { artifacts: new ArtifactStore() }
    );

    expect(result.recorded).toBe("1. run: basic.yaml");
    // The nested run read this host's file: no upload.
    const options = vi.mocked(registry.invokeTool).mock.calls[0]?.[2];
    expect(options?.fileInputs).toBeUndefined();
  });
});

describe("a tool: step with file arguments recorded over a link", () => {
  it("refuses a tool step with a directory argument before the invoke", async () => {
    const registry = stubRegistry({ "gather-workspace-data": () => ({}) });
    await startLinked();

    const err = await rejection(
      addStep(registry, "gather-workspace-data", { workspacePath: root }, linkedCtx({}))
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
    expect(await takeSteps()).toEqual([]);
  });

  it("refuses a file argument from a client that sends no files, with the update hint", async () => {
    const registry = stubRegistry({ "screenshot-diff": () => ({}) });
    await startLinked();
    const baselinePath = path.join(root, "shots", "base.png");

    const err = await rejection(
      addStep(
        registry,
        "screenshot-diff",
        { udid: "DEVICE-1", baselinePath, captureCurrent: true },
        linkedCtx()
      )
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_tool_file_input");
    expect(err.message).toContain(
      "This tool-server runs tool: steps with file arguments for a client that sends them with " +
        "the call. Update the argent CLI or MCP adapter on the client."
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("records a screenshot-diff step with a client .png baseline sent with the call", async () => {
    const baselinePath = path.join(root, "shots", "base.png");
    const clientBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
    const members = await clientFiles({ files: { [baselinePath]: clientBytes } });
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
      linkedCtx(members)
    );

    expect(seen).toHaveLength(1);
    const [{ args, options, bytes }] = seen;
    expect(args.baselinePath).not.toBe(baselinePath);
    expect(bytes.equals(clientBytes)).toBe(true);
    expect(options?.fileInputs?.baselinePath).toMatchObject({
      clientPath: baselinePath,
      viaUpload: true,
    });
    // A file argument gets a file input of its own, not the members of the call.
    expect(options?.fileInputs?.baselinePath?.members).toBeUndefined();
    await expect(fs.stat(String(args.baselinePath))).rejects.toThrow();
    expect(directiveSteps(result.savedTo)).toEqual([
      {
        kind: "tool",
        name: "screenshot-diff",
        args: { baselinePath, captureCurrent: true },
      },
    ]);
  });

  it("fails a screenshot-diff step whose baseline the client does not have, and records nothing", async () => {
    const baselinePath = path.join(root, "shots", "base.png");
    const registry = stubRegistry({ "screenshot-diff": () => ({}) });
    await startLinked();

    const err = await rejection(
      addStep(
        registry,
        "screenshot-diff",
        { udid: "DEVICE-1", baselinePath, captureCurrent: true },
        linkedCtx({ [baselinePath]: { role: "tool", state: "missing" } })
      )
    );

    expect(err.message).toContain(
      `the client has no file at "${baselinePath}" (argument baselinePath of screenshot-diff)`
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(await takeSteps()).toEqual([]);
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

  const basicMembers = () =>
    clientFiles({
      flows: {
        [recordingPath]: "steps: []\n",
        [path.join(flowsDir, "basic.yaml")]: flowText("basic"),
      },
    });

  it("records nothing when the nested flow fails, and returns the failing step", async () => {
    const members = await basicMembers();
    const registry = stubRegistry({ "flow-execute": () => FAILED_RUN });
    await startLinked();

    const err = await rejection(
      addStep(registry, "flow-execute", { name: "basic", project_root: root }, linkedCtx(members))
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
      const members = await basicMembers();
      const registry = stubRegistry({ "flow-execute": () => report });
      await startLinked();

      const err = await rejection(
        addStep(registry, "flow-execute", { name: "basic", project_root: root }, linkedCtx(members))
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
