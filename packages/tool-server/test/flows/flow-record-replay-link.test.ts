import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLIENT_FILE_MARKER,
  getFailureSignal,
  type ClientServiceOp,
  type FileInputSpec,
  type InvokeToolOptions,
  type Registry,
  type ToolContext,
} from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

/**
 * Recording over a link and replaying over the same link apply one rule
 * (`toolStepUploadIssue`): every step a linked take writes passes the up-front
 * check of an uploaded flow, and every `tool:` step that check refuses is
 * refused by the recorder before anything runs. Both sides run on the REAL
 * catalog (`createRegistry`), with the real runner and recorder tools; every
 * other tool is a stub that checks its args against the real schema, and the
 * client is a `clientServices` object that answers `resolve-file` and
 * `read-file` from a map of its files.
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
import {
  FLOW_RUN_CLIENT_OPS,
  servedToolInput,
  toolStepFilePaths,
} from "../../src/tools/flows/flow-tool-inputs";
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
// The ops a client offers flow-add-step and a replay that updates no
// baselines: write-file only comes with updateBaselines.
const LINK_OPS = FLOW_RUN_CLIENT_OPS.filter((op) => op !== "write-file");

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

type ClientServices = NonNullable<ToolContext["clientServices"]>;

interface FakeClient extends ClientServices {
  disk: Map<string, Buffer>;
  asked: Array<{ op: ClientServiceOp; args: Record<string, unknown> }>;
}

/** A client that resolves and reads the files of `files`, under both project roots. */
function fakeClient(ops: readonly ClientServiceOp[], files: Record<string, string | Buffer>) {
  const disk = new Map(Object.entries(files).map(([p, content]) => [p, Buffer.from(content)]));
  const client: FakeClient = {
    ops,
    roots: [CLIENT_ROOT, OTHER_ROOT],
    disk,
    asked: [],
    async request(op, args) {
      client.asked.push({ op, args });
      if (!ops.includes(op)) throw new Error(`op ${op} is not served by this client`);
      if (op === "resolve-file") {
        const canonical = path.posix.join(args.anchorDir as string, args.target as string);
        const content = disk.get(canonical);
        return content === undefined
          ? { canonical, spelling: { state: "absent" }, exists: false }
          : {
              canonical,
              spelling: { state: "listed" },
              exists: true,
              content: content.toString("base64"),
            };
      }
      if (op === "read-file") {
        const content = disk.get(args.path as string);
        return content === undefined
          ? { exists: false }
          : { exists: true, size: content.length, mtimeMs: 1, content: content.toString("base64") };
      }
      throw new Error(`the fake client writes nothing (${op})`);
    },
  };
  return client;
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
      { linked: true, clientServices: client }
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
 * file input names the client's path.
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
        },
      },
      clientServices: client,
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
  it("replays every flow that a linked take writes through the up-front check with the same ops", async () => {
    const { registry, stubCalls } = linkRegistry();
    const client = fakeClient(LINK_OPS, {
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
    client.asked.length = 0;
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
    // Each file the take names came from the client, with the same ops.
    expect(client.asked).toEqual(
      expect.arrayContaining([
        { op: "resolve-file", args: { anchorDir: FLOWS, target: `${REC}.yaml`, kind: "flow" } },
        { op: "resolve-file", args: { anchorDir: FLOWS, target: "sibling.yaml", kind: "flow" } },
        {
          op: "resolve-file",
          args: { anchorDir: OTHER_FLOWS, target: "other.yaml", kind: "flow" },
        },
        { op: "read-file", args: { path: BASE_PNG } },
        { op: "read-file", args: { path: NOW_PNG } },
      ])
    );
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
  /** The failure stage of the up-front refusal, or the text of a step 1 error. */
  replay: { stage: string } | { stepError: string };
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
    label: "flow-execute of a flow the client serves that has a script: step",
    tool: "flow-execute",
    args: { name: "scripted", project_root: CLIENT_ROOT },
    record: "flow_upload_script_step",
    replay: { stepError: "script: { path: seed.mjs }" },
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
      // A client that offers every op: the refusal is not a missing op.
      const client = fakeClient(FLOW_RUN_CLIENT_OPS, { [`${FLOWS}/scripted.yaml`]: SCRIPTED });

      // The row fills its input with a path no client sends.
      let line: string | undefined;
      if (row.spec) {
        const file = toolStepFilePaths(registry, row.tool, row.args).find(
          ({ spec }) => spec === row.spec
        );
        expect(file).toBeDefined();
        expect(servedToolInput(file!, FLOW_RUN_CLIENT_OPS)).toBe(false);
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
      if ("stage" in row.replay) {
        const error = await replayUpload(registry, client, "replay", yaml).then(
          () => undefined,
          (err: unknown) => err
        );
        expect(getFailureSignal(error)?.failure_stage).toBe(row.replay.stage);
        if (line) expect((error as Error).message).toContain(`  - step 1: ${line}`);
      } else {
        const run = await replayUpload(registry, client, "replay", yaml);
        expect(run.ok).toBe(false);
        expect(run.steps[0]).toMatchObject({
          kind: "tool",
          status: "error",
          reason: expect.stringContaining(row.replay.stepError),
        });
      }
      expect(stubCalls).toEqual([]);
    }
  );
});
