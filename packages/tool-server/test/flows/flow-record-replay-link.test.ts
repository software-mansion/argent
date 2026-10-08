import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLIENT_FILE_MARKER,
  flowMemberKey,
  getFailureSignal,
  type FileInputSpec,
  type InvokeToolOptions,
  type Registry,
  type ResolvedMember,
} from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

/**
 * Recording over a link and replaying over the same link apply one rule
 * (`toolStepUploadIssue`): every step a linked take writes passes the up-front
 * check of an uploaded flow, and every `tool:` step that check refuses is
 * refused by the recorder before anything runs. Both sides run on the REAL
 * catalog (`createRegistry`), with the real runner and recorder tools; every
 * other tool is a stub that checks its args against the real schema, and the
 * client sends the files of a map with each call, as the members of its file
 * input.
 */

// The recorder's tap capture and the runner's tap read the same tree source,
// so one screen with one labelled button serves both.
vi.mock("../../src/tools/flows/flow-tree", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-tree")>()),
  fetchFlowTree: vi.fn(async (): Promise<DescribeTreeData> => buttonScreen()),
}));

import { createRegistry } from "../../src/utils/setup-registry";
import { RECORDING_TOOL_IDS } from "../../src/tools/flows/flow-add-step";
import type { FlowRunResult } from "../../src/tools/flows/flow-run";
import { servedToolInput, toolStepFilePaths } from "../../src/tools/flows/flow-tool-inputs";
import {
  __resetRecordingsForTesting,
  parseFlow,
  serializeFlow,
} from "../../src/tools/flows/flow-utils";
import { definitionsById } from "../helpers/catalog";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
const APP = "com.example.app";
// Client paths: none of them exists on this host.
const CLIENT_ROOT = "/client/app";
const OTHER_ROOT = "/client/other";
const FLOWS = `${CLIENT_ROOT}/.argent/flows`;
const OTHER_FLOWS = `${OTHER_ROOT}/.argent/flows`;
const REC = "rec";
const REC_PATH = `${FLOWS}/${REC}.yaml`;
const BASE_PNG = `${CLIENT_ROOT}/shots/base.png`;
const NOW_PNG = `${CLIENT_ROOT}/shots/now.png`;

// The runner and the recorder run for real; every other tool is stubbed.
const REAL_TOOLS: ReadonlySet<string> = new Set(["flow-execute", ...RECORDING_TOOL_IDS]);

function buttonScreen(): DescribeTreeData {
  const node = (partial: Partial<DescribeNode> & { frame: DescribeNode["frame"] }) => ({
    role: "AXOther",
    children: [],
    ...partial,
  });
  return {
    tree: node({
      role: "AXWindow",
      frame: { x: 0, y: 0, width: 1, height: 1 },
      children: [
        node({
          role: "AXButton",
          label: "Continue",
          frame: { x: 0.3, y: 0.4, width: 0.4, height: 0.1 },
        }),
      ],
    }),
    source: "native-devtools",
  };
}

const flowText = (steps: Parameters<typeof serializeFlow>[0]["steps"]) =>
  serializeFlow({ executionPrerequisite: "", steps });

interface StubCall {
  tool: string;
  args: Record<string, unknown>;
  options?: InvokeToolOptions;
}

/**
 * The full catalog, with every tool outside {@link REAL_TOOLS} answered by a
 * stub that records the call and parses its args with the tool's real schema,
 * as the registry would. The iOS launch gate's native-devtools service reports
 * the app connected.
 */
function linkRegistry(): { registry: Registry; stubCalls: StubCall[] } {
  const registry = createRegistry();
  const stubCalls: StubCall[] = [];
  const invoke = registry.invokeTool.bind(registry);
  vi.spyOn(registry, "invokeTool").mockImplementation((async (
    id: string,
    params?: unknown,
    options?: InvokeToolOptions
  ) => {
    if (REAL_TOOLS.has(id)) return invoke(id, params, options);
    const parsed = registry.getTool(id)?.zodSchema?.safeParse(params ?? {});
    if (parsed && !parsed.success) {
      throw new Error(`stub ${id} got invalid params: ${parsed.error.message}`);
    }
    stubCalls.push({ tool: id, args: params as Record<string, unknown>, options });
    return { ok: true };
  }) as Registry["invokeTool"]);
  vi.spyOn(registry, "resolveService").mockImplementation((async () => ({
    isConnected: () => true,
    listConnectedBundleIds: () => [APP],
  })) as unknown as Registry["resolveService"]);
  return { registry, stubCalls };
}

interface FakeClient {
  disk: Map<string, Buffer>;
}

/** A client with the files of `files`, under both project roots. */
function fakeClient(files: Record<string, string | Buffer>): FakeClient {
  return { disk: new Map(Object.entries(files).map(([p, content]) => [p, Buffer.from(content)])) };
}

/**
 * The files the client sends with a call over a link, as the tool-server
 * resolves them: every flow on its disk under the key a lookup beside its own
 * directory uses (its directory and basename), listed as written, and every
 * other file as a file argument by its path, its bytes written to this host.
 * It sends more than one call needs, which changes no lookup the call makes.
 */
let sends = 0;
async function membersOf(client: FakeClient): Promise<Record<string, ResolvedMember>> {
  const dir = path.join(workDir, `members-${++sends}`);
  await fs.mkdir(dir, { recursive: true });
  const members: Record<string, ResolvedMember> = {};
  for (const [file, bytes] of client.disk) {
    if (file.endsWith(".yaml")) {
      members[flowMemberKey(path.posix.dirname(file), path.posix.basename(file))] = {
        role: "flow",
        state: "present",
        canonical: file,
        spelling: { state: "listed" },
        text: bytes.toString("utf8"),
      };
    } else {
      const hostPath = path.join(dir, `${Object.keys(members).length}-${path.basename(file)}`);
      await fs.writeFile(hostPath, bytes);
      members[file] = { role: "tool", state: "present", hostPath };
    }
  }
  return members;
}

/** Apply a recorder result's client-write directive, as the argent client does. */
function keep<T>(client: FakeClient, result: T): T {
  const saved = (result as { savedTo?: unknown }).savedTo as
    | { [CLIENT_FILE_MARKER]?: true; path: string; content: string }
    | undefined;
  if (typeof saved === "object" && saved?.[CLIENT_FILE_MARKER]) {
    client.disk.set(saved.path, Buffer.from(saved.content));
  }
  return result;
}

async function startLinkedTake(registry: Registry, client: FakeClient): Promise<void> {
  keep(
    client,
    await registry.invokeTool(
      "flow-start-recording",
      { name: REC, project_root: CLIENT_ROOT },
      {
        linked: true,
        fileInputs: {
          project_root: { clientPath: CLIENT_ROOT, presentOnHost: false, viaUpload: false },
        },
      }
    )
  );
}

interface AddStepResult {
  message: string;
  recorded?: string;
  savedTo: unknown;
}

async function addStep(
  registry: Registry,
  client: FakeClient,
  command: string,
  args: Record<string, unknown>
): Promise<AddStepResult> {
  return keep(
    client,
    await registry.invokeTool<AddStepResult>(
      "flow-add-step",
      { name: REC, project_root: CLIENT_ROOT, command, args: JSON.stringify(args) },
      {
        linked: true,
        fileInputs: {
          project_root: {
            clientPath: CLIENT_ROOT,
            presentOnHost: false,
            viaUpload: false,
            members: await membersOf(client),
          },
        },
      }
    )
  );
}

async function finishTake(
  registry: Registry,
  client: FakeClient
): Promise<{ steps: number; savedTo: unknown }> {
  return keep(
    client,
    await registry.invokeTool<{ steps: number; savedTo: unknown }>(
      "flow-finish-recording",
      { name: REC, project_root: CLIENT_ROOT },
      { linked: true }
    )
  );
}

let workDir = "";
let uploads = 0;

/**
 * flow-execute on an uploaded flow, as the HTTP layer hands it over for a
 * linked `name` call: `flow_file` is this host's copy of the YAML, and the
 * file input names the client's path and carries the client's files.
 */
async function replayUpload(
  registry: Registry,
  client: FakeClient,
  name: string,
  yaml: string
): Promise<FlowRunResult> {
  const uploaded = path.join(workDir, `upload-${++uploads}`, `${name}.yaml`);
  await fs.mkdir(path.dirname(uploaded), { recursive: true });
  await fs.writeFile(uploaded, yaml, "utf8");
  return registry.invokeTool<FlowRunResult>(
    "flow-execute",
    { name, project_root: CLIENT_ROOT, flow_file: uploaded, device: DEVICE },
    {
      fileInputs: {
        flow_file: {
          clientPath: `${FLOWS}/${name}.yaml`,
          presentOnHost: false,
          viaUpload: true,
          canonical: `${FLOWS}/${name}.yaml`,
          spelling: { state: "listed" },
          members: await membersOf(client),
        },
      },
      linked: true,
    }
  );
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-record-replay-link-"));
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  vi.restoreAllMocks();
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("a take recorded over a link replays over the same link", () => {
  it("replays every flow that a linked take writes through the up-front check", async () => {
    const { registry, stubCalls } = linkRegistry();
    const client = fakeClient({
      [`${FLOWS}/sibling.yaml`]: flowText([{ kind: "echo", message: "sibling ran" }]),
      [`${OTHER_FLOWS}/other.yaml`]: flowText([{ kind: "echo", message: "other project ran" }]),
      // The recording's folder has an other.yaml of its own, which is not the
      // file the nested call ran, so that call stays a raw step.
      [`${FLOWS}/other.yaml`]: flowText([{ kind: "echo", message: "not the flow that ran" }]),
      [BASE_PNG]: Buffer.from("base png bytes"),
      [NOW_PNG]: Buffer.from("now png bytes"),
    });

    await startLinkedTake(registry, client);
    const takes = [
      await addStep(registry, client, "restart-app", { udid: DEVICE, bundleId: APP }),
      keep(
        client,
        await registry.invokeTool<AddStepResult>(
          "flow-add-echo",
          { name: REC, project_root: CLIENT_ROOT, message: "after launch" },
          { linked: true }
        )
      ),
      await addStep(registry, client, "gesture-tap", { udid: DEVICE, x: 0.5, y: 0.45 }),
      await addStep(registry, client, "flow-execute", {
        name: "sibling",
        project_root: CLIENT_ROOT,
        device: DEVICE,
      }),
      await addStep(registry, client, "flow-execute", {
        name: "other",
        project_root: OTHER_ROOT,
        device: DEVICE,
      }),
      await addStep(registry, client, "screenshot-diff", {
        udid: DEVICE,
        baselinePath: BASE_PNG,
        currentPath: NOW_PNG,
      }),
    ];
    const finished = await finishTake(registry, client);

    // The take holds one step of each kind, with the client's paths. The
    // nested call into the other project stays raw because the recording's
    // own other.yaml is another file than the one that ran.
    expect(takes[4]!.message).toContain(
      `project_root "${OTHER_ROOT}" resolves "other" to "${OTHER_FLOWS}/other.yaml", not the ` +
        `recording's sibling "${FLOWS}/other.yaml"`
    );
    expect(finished.steps).toBe(6);
    const yaml = client.disk.get(REC_PATH)!.toString("utf8");
    expect(parseFlow(yaml).steps).toEqual([
      { kind: "launch", app: APP },
      { kind: "echo", message: "after launch" },
      { kind: "tap", selector: { text: "Continue" } },
      { kind: "run", flow: "sibling.yaml" },
      { kind: "tool", name: "flow-execute", args: { name: "other", project_root: OTHER_ROOT } },
      {
        kind: "tool",
        name: "screenshot-diff",
        args: { baselinePath: BASE_PNG, currentPath: NOW_PNG },
      },
    ]);
    // Live, the diff read the client's PNGs from temp copies on this host.
    const recordedDiff = stubCalls.find((call) => call.tool === "screenshot-diff")!;
    expect(recordedDiff.args.baselinePath).not.toBe(BASE_PNG);
    expect(recordedDiff.options?.fileInputs).toEqual({
      baselinePath: { clientPath: BASE_PNG, presentOnHost: false, viaUpload: true },
      currentPath: { clientPath: NOW_PNG, presentOnHost: false, viaUpload: true },
    });

    stubCalls.length = 0;
    // A refusal of the up-front check would reject here, before step 1.
    const run = await replayUpload(registry, client, REC, yaml);

    // The fragment's echo reports inline, under the run: step.
    expect(run.steps.map((step) => [step.kind, step.status, step.message])).toEqual([
      ["launch", "pass", undefined],
      ["echo", "pass", "after launch"],
      ["tap", "pass", undefined],
      ["run", "pass", undefined],
      ["echo", "pass", "sibling ran"],
      ["tool", "pass", undefined],
      ["tool", "pass", undefined],
    ]);
    expect(run.steps.every((step) => step.reason === undefined)).toBe(true);
    expect(run.ok).toBe(true);
    expect(stubCalls.map((call) => call.tool)).toEqual([
      "restart-app",
      "gesture-tap",
      "screenshot-diff",
    ]);
    const replayedDiff = stubCalls.find((call) => call.tool === "screenshot-diff")!;
    expect(replayedDiff.options?.fileInputs).toEqual(recordedDiff.options?.fileInputs);
    // The nested run of the other project ran the client's flow.
    expect(JSON.stringify(run.steps[5])).toContain("other project ran");
  });
});

// ---------------------------------------------------------------------------
// Refused at record time exactly when a replay over the link refuses
// ---------------------------------------------------------------------------

interface RefusalRow {
  label: string;
  tool: string;
  args: Record<string, unknown>;
  /** The file input a row built from the catalog fills. */
  spec?: FileInputSpec;
  /** The failure stage of the recorder's refusal, or "nothing" for a call answered with guidance. */
  record: string;
  /** The failure stage of the up-front refusal. */
  replay: { stage: string };
}

/**
 * Args that fill `spec` with a path no client serves: a relative path for a
 * file argument, every param of a path the tool builds from several, and an
 * absolute path for a directory, a probe or an app.
 */
function argsFilling(spec: FileInputSpec): Record<string, unknown> {
  if (spec.path === `\${${spec.target}}`) {
    return {
      [spec.target]:
        spec.kind === "file" ? `relative/${spec.target}.png` : `${CLIENT_ROOT}/${spec.target}`,
    };
  }
  const args: Record<string, unknown> = {};
  for (const [whole, param] of spec.path.matchAll(/\$\{(\w+)\}/g)) {
    args[param!] = spec.path.startsWith(whole) ? CLIENT_ROOT : "rec";
  }
  return args;
}

/** One row per declared file input of the catalog, so a new tool with one adds a row. */
const FILE_INPUT_ROWS: RefusalRow[] = [...definitionsById(createRegistry())]
  .filter(([id]) => id !== "flow-execute" && !RECORDING_TOOL_IDS.has(id))
  .flatMap(([id, definition]) =>
    (definition.fileInputs ?? []).map((spec) => ({
      label: `${id}, ${spec.kind} input ${spec.target}`,
      tool: id,
      args: argsFilling(spec),
      spec,
      record: "flow_upload_tool_file_input",
      replay: { stage: "flow_upload_tool_file_input" },
    }))
  );

const SCRIPTED = flowText([{ kind: "script", path: "seed.mjs" }]);

const ROWS: RefusalRow[] = [
  ...FILE_INPUT_ROWS,
  {
    label: "flow-execute, flow_path outside the recording folder",
    tool: "flow-execute",
    args: { flow_path: "/client/shared/login.yaml", project_root: CLIENT_ROOT },
    record: "flow_add_step_flow_path",
    replay: { stage: "flow_upload_nested_flow" },
  },
  {
    label: "flow-execute, flow_path in the recording folder that project_root does not name",
    tool: "flow-execute",
    args: { flow_path: `${FLOWS}/login.yaml`, project_root: OTHER_ROOT },
    record: "flow_add_step_flow_path",
    replay: { stage: "flow_upload_nested_flow" },
  },
  ...[...RECORDING_TOOL_IDS].map((id) => ({
    label: `${id} as the command`,
    tool: id,
    args: { name: REC, project_root: CLIENT_ROOT },
    record: "nothing",
    replay: { stage: "flow_upload_recording_tool" },
  })),
  {
    // The replay checks the nested flow the client sent before step 1.
    label: "flow-execute of a flow the client sends that has a script: step",
    tool: "flow-execute",
    args: { name: "scripted", project_root: CLIENT_ROOT },
    record: "flow_upload_script_step",
    replay: { stage: "flow_upload_script_step" },
  },
];

describe("the recorder over a link refuses what a replay over it refuses", () => {
  it("builds a row for each file input kind of the catalog", () => {
    expect(FILE_INPUT_ROWS.map((row) => row.spec!.kind)).toEqual(
      expect.arrayContaining(["file", "directory", "probe", "tar-upload"])
    );
  });

  it.each(ROWS.map((row) => [row.label, row] as const))(
    "refuses at record time every step that the replay refuses: %s",
    async (_label, row) => {
      const { registry, stubCalls } = linkRegistry();
      // A client that sends its files: the refusal is not an older client's.
      const client = fakeClient({ [`${FLOWS}/scripted.yaml`]: SCRIPTED });

      // The row fills its input with a path no client sends.
      let line: string | undefined;
      if (row.spec) {
        const file = toolStepFilePaths(registry, row.tool, row.args).find(
          ({ spec }) => spec === row.spec
        );
        expect(file).toBeDefined();
        expect(servedToolInput(file!, true)).toBe(false);
        line = `tool: ${row.tool} (${file!.path})`;
      }

      await startLinkedTake(registry, client);
      const recording = await addStep(registry, client, row.tool, row.args).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );
      if (row.record === "nothing") {
        const { result } = recording as { result: AddStepResult };
        expect(result.recorded).toBeUndefined();
        expect(result.message).toContain("no step was recorded");
      } else {
        expect("error" in recording).toBe(true);
        const error = (recording as { error: unknown }).error;
        expect(getFailureSignal(error)?.failure_stage).toBe(row.record);
        if (line) expect((error as Error).message).toContain(`refuses the step "${line}"`);
      }
      // No device or host tool ran, and the take is still empty.
      expect(stubCalls).toEqual([]);
      expect((await finishTake(registry, client)).steps).toBe(0);

      const yaml = flowText([{ kind: "tool", name: row.tool, args: row.args }]);
      const error = await replayUpload(registry, client, "replay", yaml).then(
        () => undefined,
        (err: unknown) => err
      );
      expect(getFailureSignal(error)?.failure_stage).toBe(row.replay.stage);
      if (line) expect((error as Error).message).toContain(`  - step 1: ${line}`);
      expect(stubCalls).toEqual([]);
    }
  );
});
