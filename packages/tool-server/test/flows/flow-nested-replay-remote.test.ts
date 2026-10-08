import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import {
  CLIENT_FILE_MARKER,
  flowMemberKey,
  getFailureSignal,
  Registry,
  type ClientFileDirective,
  type ResolvedMember,
} from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";

/**
 * A `tool: flow-execute` step of a flow uploaded over a link, which names its
 * flow with `name`: the client sent that flow, its own files and its own
 * baselines with the call, as members of the root flow's file input, and the
 * runner runs it as the upload of a nested call that gets the same members.
 * The REAL flow-execute is registered in a real registry, so the nested call
 * actually runs; the members are built here as the file-input boundary hands
 * them to the runner. Only the device edges are stubbed: the settle, and a
 * `screenshot` tool that returns one fixed PNG.
 */

// The registry serves no describe tree, so an unstubbed settle would poll to
// its own deadline before a snapshot's capture.
vi.mock("../../src/tools/flows/flow-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/tools/flows/flow-actions")>()),
  settleTree: vi.fn(async () => ({})),
}));

const DEVICE = "00000000-0000-0000-0000-0000000000ab";
const CLIENT_ROOT = "/client";
const CLIENT_FLOWS = "/client/.argent/flows";

let workDir = "";
let capture = "";
let captureBytes: Buffer = Buffer.alloc(0);
/** A PNG of the capture's size that differs from it everywhere: a compare against it fails. */
let otherBytes: Buffer = Buffer.alloc(0);

beforeEach(async () => {
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-nested-remote-")));
  // A real PNG: the snapshot keys on its size and the compare decodes it.
  const png = new PNG({ width: 30, height: 60 });
  png.data.fill(200);
  captureBytes = PNG.sync.write(png);
  capture = path.join(workDir, "capture.png");
  await fs.writeFile(capture, captureBytes);
  const other = new PNG({ width: 30, height: 60 });
  other.data.fill(0);
  for (let i = 3; i < other.data.length; i += 4) other.data[i] = 255;
  otherBytes = PNG.sync.write(other);
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/**
 * The member of the flow that `target` names beside `anchorDir`, as the
 * boundary resolves what the client sent: `text` present, `null` missing on
 * the client, `refused` with the client's reason. `canonical` is its real
 * path on the client, the spelled path unless it is a symlink.
 */
function flowMember(
  anchorDir: string,
  target: string,
  opts: { text?: string | null; canonical?: string; refused?: string }
): Record<string, ResolvedMember> {
  const base = {
    role: "flow" as const,
    canonical: opts.canonical ?? path.posix.join(anchorDir, target),
    spelling: { state: "listed" as const },
  };
  const member: ResolvedMember =
    opts.refused !== undefined
      ? { ...base, state: "refused", error: opts.refused }
      : opts.text === null || opts.text === undefined
        ? { ...base, state: "missing" }
        : { ...base, state: "present", text: opts.text };
  return { [flowMemberKey(anchorDir, target)]: member };
}

/**
 * A baseline the client sent: with its bytes (written to a file on this host,
 * as the boundary materializes them), or by name only (`listed`), as a client
 * sends the baselines of a run that updates them.
 */
async function baselineMember(
  file: string,
  bytes: Buffer | "listed"
): Promise<Record<string, ResolvedMember>> {
  if (bytes === "listed") return { [file]: { role: "baseline", state: "listed" } };
  const hostPath = path.join(workDir, `sent-${path.basename(file)}-${Math.random()}`);
  await fs.writeFile(hostPath, bytes);
  return { [file]: { role: "baseline", state: "present", hostPath } };
}

/**
 * A real registry with the real flow-execute, and a `screenshot` tool that
 * returns the fixed capture. `invoke` spies on every dispatch, the nested
 * flow-execute calls included.
 */
function realRegistry() {
  const registry = new Registry();
  registry.registerTool(createRunFlowTool(registry) as never);
  registry.registerTool({
    id: "screenshot",
    inputSchema: { type: "object", properties: { udid: { type: "string" } } },
    services: () => ({}),
    execute: async () => ({ image: { hostPath: capture } }),
  } as never);
  const invoke = vi.spyOn(registry, "invokeTool");
  return { registry, invoke };
}

/** The dispatches of `tool` as [args, options], in call order. */
function dispatches(invoke: ReturnType<typeof realRegistry>["invoke"], tool: string) {
  return invoke.mock.calls
    .filter(([id]) => id === tool)
    .map(([, args, options]) => [args as Record<string, unknown>, options] as const);
}

const flowText = (steps: FlowStep[]): string => serializeFlow({ executionPrerequisite: "", steps });

const nestedStep = (args: Record<string, unknown>): FlowStep => ({
  kind: "tool",
  name: "flow-execute",
  args,
});

/**
 * Run `steps` as the flow `main` a client uploaded over a link, through the
 * registry as the HTTP route dispatches it: the upload materialized into a
 * temp file, its real path and spelling, and the `members` the client sent
 * with it.
 */
async function runUploaded(
  registry: Registry,
  steps: FlowStep[],
  members: Record<string, ResolvedMember>,
  extra: { updateBaselines?: boolean } = {}
): Promise<FlowRunResult & { baselineWrites?: ClientFileDirective[] }> {
  const uploaded = path.join(workDir, "upload", "main.yaml");
  await fs.mkdir(path.dirname(uploaded), { recursive: true });
  await fs.writeFile(uploaded, flowText(steps), "utf8");
  return registry.invokeTool(
    "flow-execute",
    {
      name: "main",
      project_root: CLIENT_ROOT,
      flow_file: uploaded,
      device: DEVICE,
      ...extra,
    },
    {
      fileInputs: {
        flow_file: {
          clientPath: `${CLIENT_FLOWS}/main.yaml`,
          presentOnHost: false,
          viaUpload: true,
          canonical: `${CLIENT_FLOWS}/main.yaml`,
          spelling: { state: "listed" },
          members,
        },
      },
      linked: true,
    }
  );
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err
  );
}

describe("a nested tool: flow-execute in a flow uploaded over a link", () => {
  it("runs the client's copy of the nested flow, and its run: fragment, from the members of the call", async () => {
    const members = {
      ...flowMember(CLIENT_FLOWS, "login.yaml", {
        text: flowText([{ kind: "run", flow: "helper.yaml" }]),
      }),
      ...flowMember(CLIENT_FLOWS, "helper.yaml", {
        text: flowText([{ kind: "echo", message: "logged in on the client" }]),
      }),
    };
    const { registry, invoke } = realRegistry();

    const result = await runUploaded(
      registry,
      [
        { kind: "echo", message: "before" },
        nestedStep({ name: "login", project_root: CLIENT_ROOT }),
      ],
      members
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["echo:pass", "tool:pass"]);
    expect(result.ok).toBe(true);
    const nested = result.steps[1]!.result as FlowRunResult;
    expect(nested.flow).toBe("login");
    expect(nested.steps.map((s) => `${s.kind}:${s.status}:${s.message ?? s.target}`)).toEqual([
      "run:pass:helper.yaml",
      "echo:pass:logged in on the client",
    ]);
    // The nested run gets the client's copy as an upload, with its real path,
    // and the members of the outer call itself, not a copy of them.
    const runs = dispatches(invoke, "flow-execute");
    expect(runs).toHaveLength(2);
    expect(runs[1]![1]).toMatchObject({
      fileInputs: {
        flow_file: {
          clientPath: `${CLIENT_FLOWS}/login.yaml`,
          viaUpload: true,
          canonical: `${CLIENT_FLOWS}/login.yaml`,
          spelling: { state: "listed" },
        },
      },
      flowStack: [{ canonical: `${CLIENT_FLOWS}/main.yaml`, display: "main" }],
    });
    const outer = runs[0]![1]?.fileInputs?.flow_file?.members;
    expect(outer).toBeDefined();
    expect(runs[1]![1]?.fileInputs?.flow_file?.members).toBe(outer);
  });

  it("refuses the call before step 1 when the nested flow has a script: step", async () => {
    // Every flow the client sent is checked before the first step, the
    // nested ones included, and its steps are numbered in its own file.
    const members = flowMember(CLIENT_FLOWS, "login.yaml", {
      text: flowText([
        { kind: "echo", message: "inside login" },
        { kind: "script", path: "seed.mjs" },
      ]),
    });
    const { registry, invoke } = realRegistry();

    const err = await rejection(
      runUploaded(
        registry,
        [
          { kind: "echo", message: "before" },
          nestedStep({ name: "login", project_root: CLIENT_ROOT }),
          { kind: "echo", message: "after" },
        ],
        members
      )
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_script_step");
    expect((err as Error).message).toContain(
      "This flow is not self-contained, and it arrived as an upload. The steps below read or " +
        "write project files, which stay on the client:\n" +
        `  - step 2 in ${CLIENT_FLOWS}/login.yaml: script: { path: seed.mjs }\n`
    );
    // No nested run started, and no step ran.
    expect(dispatches(invoke, "flow-execute")).toHaveLength(1);
  });

  it("words the refusal of a nested run that starts without the outer check for its own flow", async () => {
    // flow-add-step runs a nested flow-execute live with no enclosing check:
    // the nested run checks its flow itself when it starts.
    const members = flowMember(CLIENT_FLOWS, "login.yaml", {
      text: flowText([{ kind: "script", path: "seed.mjs" }]),
    });
    const uploaded = path.join(workDir, "upload", "login.yaml");
    await fs.mkdir(path.dirname(uploaded), { recursive: true });
    await fs.writeFile(uploaded, flowText([{ kind: "script", path: "seed.mjs" }]), "utf8");
    const { registry } = realRegistry();

    const err = await rejection(
      registry.invokeTool(
        "flow-execute",
        { name: "login", project_root: CLIENT_ROOT, flow_file: uploaded, device: DEVICE },
        {
          fileInputs: {
            flow_file: {
              clientPath: `${CLIENT_FLOWS}/login.yaml`,
              presentOnHost: false,
              viaUpload: true,
              canonical: `${CLIENT_FLOWS}/login.yaml`,
              spelling: { state: "listed" },
              members,
            },
          },
          flowStack: [],
        }
      )
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_script_step");
    expect((err as Error).message).toContain(
      'The nested flow "login" is not self-contained, and the client sent it with the call. ' +
        "The steps below read or write project files, which stay on the client:\n" +
        "  - step 1: script: { path: seed.mjs }\n"
    );
  });

  it("fails the nested step with the ENOENT reason when the client has no such flow", async () => {
    // A missing flow is not refused up front: its step may never run.
    const members = flowMember(CLIENT_FLOWS, "missing.yaml", { text: null });
    const { registry, invoke } = realRegistry();

    const result = await runUploaded(
      registry,
      [
        { kind: "echo", message: "before" },
        nestedStep({ name: "missing", project_root: CLIENT_ROOT }),
      ],
      members
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["echo:pass", "tool:error"]);
    expect(result.steps[1]!.reason).toBe(
      `ENOENT: no such file or directory, open '${CLIENT_FLOWS}/missing.yaml'`
    );
    // No nested run started.
    expect(dispatches(invoke, "flow-execute")).toHaveLength(1);
  });

  it("lists a nested flow the client refused to send before step 1, with the client's reason", async () => {
    // The client resolves the flow under the step's project_root and refuses
    // one outside its roots; the refusal is known before the first step.
    const why =
      "/elsewhere/.argent/flows/login.yaml is outside every root this client serves (/client)";
    const members = flowMember("/elsewhere/.argent/flows", "login.yaml", { refused: why });
    const { registry, invoke } = realRegistry();

    const err = await rejection(
      runUploaded(
        registry,
        [
          { kind: "echo", message: "before" },
          nestedStep({ name: "login", project_root: "/elsewhere" }),
        ],
        members
      )
    );

    expect(getFailureSignal(err)?.failure_stage).toBe("flow_upload_nested_flow");
    expect((err as Error).message).toContain(
      `which stay on the client:\n  - step 2: tool: flow-execute (name: login) (${why})\nRun the flow`
    );
    expect((err as Error).message).not.toContain("Update the argent CLI");
    expect(dispatches(invoke, "flow-execute")).toHaveLength(1);
  });

  it("fails the nested step with the client's refusal when the client sent no entry for the flow", async () => {
    const { registry, invoke } = realRegistry();

    const result = await runUploaded(
      registry,
      [nestedStep({ name: "login", project_root: CLIENT_ROOT })],
      {}
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:error"]);
    expect(result.steps[0]!.reason).toBe(
      'the client refused to send "login.yaml": login.yaml is not a run: target of a flow this ' +
        "client sent"
    );
    expect(dispatches(invoke, "flow-execute")).toHaveLength(1);
  });

  it("stops a client-sent flow that runs itself at the cycle guard", async () => {
    // A flow with no run: or snapshot step keeps its client path as spelled
    // as its canonical, so the outer flow's client path is spelled exactly as
    // the nested step's project_root and name build it.
    const selfy = flowText([nestedStep({ name: "main", project_root: CLIENT_ROOT })]);
    const members = flowMember(CLIENT_FLOWS, "main.yaml", { text: selfy });
    const { registry, invoke } = realRegistry();

    const result = await runUploaded(
      registry,
      [nestedStep({ name: "main", project_root: CLIENT_ROOT })],
      members
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:error"]);
    expect(result.steps[0]!.reason).toContain("cyclic flow reference: main → main");
    expect(dispatches(invoke, "flow-execute")).toHaveLength(2);
  });

  describe("snapshot steps of the nested flow", () => {
    // The nested flow is a symlink on the client: its baselines live beside
    // its real file, under its own key, not under the root flow's.
    const REAL = "/client/vault/login-real.yaml";
    const BASELINE = "/client/vault/__baselines__/login-real/title__ios-30x60.png";
    const login = () =>
      flowMember(CLIENT_FLOWS, "login.yaml", {
        canonical: REAL,
        text: flowText([{ kind: "snapshot", name: "title" }]),
      });
    const directive = (bytes: Buffer) => ({
      [CLIENT_FILE_MARKER]: true,
      path: BASELINE,
      content: bytes.toString("base64"),
      encoding: "base64",
    });

    it("compares against the baseline the client sent beside the nested flow's real file", async () => {
      const members = { ...login(), ...(await baselineMember(BASELINE, captureBytes)) };
      const { registry } = realRegistry();

      const result = await runUploaded(
        registry,
        [nestedStep({ name: "login", project_root: CLIENT_ROOT })],
        members
      );

      const nested = result.steps[0]!.result as FlowRunResult & { baselineWrites?: unknown };
      expect(nested.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["snapshot:pass"]);
      expect(result.ok).toBe(true);
      expect(result.baselineWrites).toBeUndefined();
      expect(nested.baselineWrites).toBeUndefined();
    });

    it("returns the nested flow's new baseline in the result of the outer run when it updates baselines", async () => {
      const members = { ...login(), ...(await baselineMember(BASELINE, "listed")) };
      const { registry, invoke } = realRegistry();

      const result = await runUploaded(
        registry,
        [nestedStep({ name: "login", project_root: CLIENT_ROOT })],
        members,
        { updateBaselines: true }
      );

      const nested = result.steps[0]!.result as FlowRunResult & { baselineWrites?: unknown };
      expect(nested.steps.map((s) => `${s.kind}:${s.status}:${s.reason}`)).toEqual([
        `snapshot:pass:baseline updated (${BASELINE})`,
      ]);
      // Only the outermost run returns the writes of the call, the nested
      // run's included; the nested step's own result carries none.
      expect(result.baselineWrites).toEqual([directive(captureBytes)]);
      expect(nested.baselineWrites).toBeUndefined();
      // The nested run got the outer run's updateBaselines; the report keeps
      // the step's args as the flow wrote them.
      expect(dispatches(invoke, "flow-execute")[1]![0]).toMatchObject({ updateBaselines: true });
      expect(result.steps[0]!.args).not.toHaveProperty("updateBaselines");
    });

    it("writes the baseline of a nested step that updates baselines in a run that does not", async () => {
      // The client sends the baselines of each run by that run's own rule, so
      // a nested run that updates them needs nothing the outer run lacks.
      const { registry } = realRegistry();

      const result = await runUploaded(
        registry,
        [nestedStep({ name: "login", project_root: CLIENT_ROOT, updateBaselines: true })],
        login()
      );

      const nested = result.steps[0]!.result as FlowRunResult;
      expect(nested.steps.map((s) => `${s.kind}:${s.status}:${s.reason}`)).toEqual([
        `snapshot:pass:baseline written (${BASELINE})`,
      ]);
      expect(result.baselineWrites).toEqual([directive(captureBytes)]);
    });

    it("keeps a nested step's own updateBaselines: false in a run that updates baselines", async () => {
      const members = { ...login(), ...(await baselineMember(BASELINE, captureBytes)) };
      const { registry, invoke } = realRegistry();

      const result = await runUploaded(
        registry,
        [nestedStep({ name: "login", project_root: CLIENT_ROOT, updateBaselines: false })],
        members,
        { updateBaselines: true }
      );

      const nested = result.steps[0]!.result as FlowRunResult;
      expect(nested.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["snapshot:pass"]);
      expect(result.baselineWrites).toBeUndefined();
      expect(dispatches(invoke, "flow-execute")[1]![0]).toMatchObject({ updateBaselines: false });
    });

    it("compares a later nested run of one call against the baseline an earlier one wrote", async () => {
      // The client holds an older baseline, which the capture does not match.
      const stale = { ...login(), ...(await baselineMember(BASELINE, otherBytes)) };

      // Alone, the compare fails against the client's bytes...
      const alone = await runUploaded(
        realRegistry().registry,
        [nestedStep({ name: "login", project_root: CLIENT_ROOT, updateBaselines: false })],
        stale
      );
      expect((alone.steps[0]!.result as FlowRunResult).steps.map((s) => s.status)).toEqual([
        "fail",
      ]);

      // ...but after a nested run of the same call wrote a new one, the
      // compare reads that one: one overlay serves every run of the call.
      const result = await runUploaded(
        realRegistry().registry,
        [
          nestedStep({ name: "login", project_root: CLIENT_ROOT }),
          nestedStep({ name: "login", project_root: CLIENT_ROOT, updateBaselines: false }),
        ],
        { ...login(), ...(await baselineMember(BASELINE, otherBytes)) },
        { updateBaselines: true }
      );

      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:pass", "tool:pass"]);
      const [written, compared] = result.steps.map((s) => s.result as FlowRunResult);
      expect(written!.steps.map((s) => `${s.status}:${s.reason}`)).toEqual([
        `pass:baseline updated (${BASELINE})`,
      ]);
      expect(compared!.steps.map((s) => s.status)).toEqual(["pass"]);
      expect(result.baselineWrites).toEqual([directive(captureBytes)]);
    });
  });
});

describe("updateBaselines of a nested tool: flow-execute without a link", () => {
  it("passes the outer run's updateBaselines to the nested run, and keeps it out of the step report", async () => {
    const root = path.join(workDir, "project");
    const flowsDir = path.join(root, ".argent", "flows");
    await fs.mkdir(flowsDir, { recursive: true });
    await fs.writeFile(
      path.join(flowsDir, "main.yaml"),
      flowText([nestedStep({ name: "leaf", project_root: root })])
    );
    await fs.writeFile(
      path.join(flowsDir, "leaf.yaml"),
      flowText([{ kind: "echo", message: "x" }])
    );

    for (const updateBaselines of [true, undefined]) {
      const { registry, invoke } = realRegistry();
      const result = await registry.invokeTool<FlowRunResult>("flow-execute", {
        name: "main",
        project_root: root,
        device: DEVICE,
        ...(updateBaselines ? { updateBaselines } : {}),
      });
      expect(result.ok).toBe(true);
      const nestedArgs = dispatches(invoke, "flow-execute")[1]![0];
      expect(nestedArgs).toMatchObject({ name: "leaf", project_root: root, device: DEVICE });
      if (updateBaselines) expect(nestedArgs.updateBaselines).toBe(true);
      else expect(nestedArgs).not.toHaveProperty("updateBaselines");
      expect(result.steps[0]!.args).toEqual({ name: "leaf", project_root: root, device: DEVICE });
    }
  });
});
