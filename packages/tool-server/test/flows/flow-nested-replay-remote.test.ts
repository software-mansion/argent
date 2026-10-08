import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PNG } from "pngjs";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  Registry,
  type ClientServiceOp,
  type ToolContext,
} from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";

/**
 * A `tool: flow-execute` step of a flow uploaded over a link, which names its
 * flow with `name`: the runner reads that flow from the client and runs it as
 * the upload of a nested call. The REAL flow-execute is registered in a real
 * registry, so the nested call actually runs; the client is a fake whose
 * client services answer from a map of its files. Only the device edges are
 * stubbed: the settle, and a `screenshot` tool that returns one fixed PNG.
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
const ALL_OPS: ClientServiceOp[] = ["resolve-file", "read-file", "write-file"];

let workDir = "";
let capture = "";
let captureBytes: Buffer = Buffer.alloc(0);

beforeEach(async () => {
  workDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-nested-remote-")));
  // A real PNG: the snapshot keys on its size and the compare decodes it.
  const png = new PNG({ width: 30, height: 60 });
  png.data.fill(200);
  captureBytes = PNG.sync.write(png);
  capture = path.join(workDir, "capture.png");
  await fs.writeFile(capture, captureBytes);
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

/** What the broker raises for a request the client answered with a refusal. */
function clientRefusal(op: ClientServiceOp, subject: string, why: string): FailureError {
  return new FailureError(`the client refused the ${op} request for "${subject}": ${why}`, {
    error_code: FAILURE_CODES.FLOW_FILE_INVALID,
    failure_stage: "client_request_refused",
    failure_area: "tool_server",
    error_kind: "validation",
  });
}

/**
 * The client's side of the channel over a map of its flow files (by real
 * path): `resolve-file` follows `realpaths` from a spelled path to the real
 * one, `read-file` serves `baselines`, and `write-file` stores into `written`.
 * A request for a path outside `/client` is refused, as the argent client
 * refuses one outside its roots. Every request is recorded in `calls`.
 */
function fakeClient(
  files: Record<string, string>,
  opts: {
    ops?: ClientServiceOp[];
    realpaths?: Record<string, string>;
    baselines?: Record<string, Buffer>;
  } = {}
): {
  services: NonNullable<ToolContext["clientServices"]>;
  calls: Array<{ op: ClientServiceOp; args: Record<string, unknown> }>;
  written: Map<string, Buffer>;
} {
  const calls: Array<{ op: ClientServiceOp; args: Record<string, unknown> }> = [];
  const written = new Map<string, Buffer>();
  const inRoots = (p: string): boolean => p === CLIENT_ROOT || p.startsWith(`${CLIENT_ROOT}/`);
  const services: NonNullable<ToolContext["clientServices"]> = {
    ops: opts.ops ?? ALL_OPS,
    roots: [CLIENT_ROOT],
    request: vi.fn(async (op: ClientServiceOp, args: Record<string, unknown>) => {
      calls.push({ op, args });
      if (op === "resolve-file") {
        const anchorDir = String(args.anchorDir);
        const target = String(args.target);
        if (!inRoots(anchorDir)) {
          throw clientRefusal(op, target, `${anchorDir} is outside the roots this client serves`);
        }
        const spelled = path.posix.join(anchorDir, target);
        const canonical = opts.realpaths?.[spelled] ?? spelled;
        const text = files[canonical];
        if (text === undefined) return { canonical, spelling: { state: "absent" }, exists: false };
        return {
          canonical,
          spelling: { state: "listed" },
          exists: true,
          size: Buffer.byteLength(text),
          mtimeMs: 1,
          content: Buffer.from(text, "utf8").toString("base64"),
        };
      }
      const file = String(args.path);
      if (!inRoots(file)) throw clientRefusal(op, file, "outside the roots this client serves");
      if (op === "read-file") {
        const bytes = opts.baselines?.[file];
        if (bytes === undefined) return { exists: false };
        return { exists: true, size: bytes.length, mtimeMs: 1, content: bytes.toString("base64") };
      }
      const replaced = written.has(file) || opts.baselines?.[file] !== undefined;
      written.set(file, Buffer.from(String(args.content), "base64"));
      return { written: file, replaced };
    }),
  };
  return { services, calls, written };
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
 * temp file, and the client's services on the call.
 */
async function runUploaded(
  registry: Registry,
  steps: FlowStep[],
  services: NonNullable<ToolContext["clientServices"]>,
  extra: { updateBaselines?: boolean } = {}
): Promise<FlowRunResult> {
  const uploaded = path.join(workDir, "upload", "main.yaml");
  await fs.mkdir(path.dirname(uploaded), { recursive: true });
  await fs.writeFile(uploaded, flowText(steps), "utf8");
  return registry.invokeTool<FlowRunResult>(
    "flow-execute",
    { name: "main", project_root: CLIENT_ROOT, flow_file: uploaded, device: DEVICE, ...extra },
    {
      fileInputs: {
        flow_file: {
          clientPath: `${CLIENT_FLOWS}/main.yaml`,
          presentOnHost: false,
          viaUpload: true,
        },
      },
      clientServices: services,
      // A current client sends the link header, which a nested step needs.
      linked: true,
    }
  );
}

describe("a nested tool: flow-execute in a flow uploaded over a link", () => {
  it("runs a nested tool: flow-execute of an uploaded flow from the client", async () => {
    const client = fakeClient({
      [`${CLIENT_FLOWS}/login.yaml`]: flowText([{ kind: "echo", message: "logged in" }]),
    });
    const { registry, invoke } = realRegistry();

    const result = await runUploaded(
      registry,
      [
        { kind: "echo", message: "before" },
        nestedStep({ name: "login", project_root: CLIENT_ROOT }),
      ],
      client.services
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["echo:pass", "tool:pass"]);
    expect(result.ok).toBe(true);
    const nested = result.steps[1]!.result as FlowRunResult;
    expect(nested.flow).toBe("login");
    expect(nested.steps.map((s) => `${s.kind}:${s.status}:${s.message}`)).toEqual([
      "echo:pass:logged in",
    ]);
    // One request: the nested flow in the project's flows dir. Neither run
    // resolves its own root, since neither has a run: or snapshot step.
    expect(client.calls).toEqual([
      {
        op: "resolve-file",
        args: { anchorDir: CLIENT_FLOWS, target: "login.yaml", kind: "flow" },
      },
    ]);
    // The nested run gets the client's copy as an upload, and the channel.
    const runs = dispatches(invoke, "flow-execute");
    expect(runs).toHaveLength(2);
    expect(runs[1]![1]).toMatchObject({
      fileInputs: {
        flow_file: { clientPath: `${CLIENT_FLOWS}/login.yaml`, viaUpload: true },
      },
      clientServices: client.services,
    });
  });

  it("fails the nested step with the script refusal when the nested flow has a script: step", async () => {
    // A nested flow gets the up-front check of an uploaded flow when its step
    // runs, so its script step is refused before any of its steps runs.
    const client = fakeClient({
      [`${CLIENT_FLOWS}/login.yaml`]: flowText([
        { kind: "echo", message: "inside login" },
        { kind: "script", path: "seed.mjs" },
      ]),
    });
    const { registry, invoke } = realRegistry();

    const result = await runUploaded(
      registry,
      [
        { kind: "echo", message: "before" },
        nestedStep({ name: "login", project_root: CLIENT_ROOT }),
        { kind: "echo", message: "after" },
      ],
      client.services
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "echo:pass",
      "tool:error",
      "echo:skip",
    ]);
    const settled = invoke.mock.settledResults[invoke.mock.calls.length - 1]!;
    expect(invoke.mock.calls.at(-1)![0]).toBe("flow-execute");
    expect(settled.type).toBe("rejected");
    expect(getFailureSignal(settled.value)?.failure_stage).toBe("flow_upload_script_step");
    // The refusal names the nested flow, whose steps it numbers, and the step
    // of the outer flow quotes it whole.
    const refusal = (settled.value as Error).message;
    expect(refusal).toContain(
      'The nested flow "login" is not self-contained, and the ' +
        "client served it from a project. The steps below read or write project files, which " +
        "stay on the client:\n  - step 2: script: { path: seed.mjs }\n"
    );
    expect(result.steps[1]!.reason).toBe(refusal);
  });

  it("fails the nested step with the ENOENT reason when the client has no such flow", async () => {
    const client = fakeClient({});
    const { registry, invoke } = realRegistry();

    const result = await runUploaded(
      registry,
      [
        { kind: "echo", message: "before" },
        nestedStep({ name: "missing", project_root: CLIENT_ROOT }),
      ],
      client.services
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["echo:pass", "tool:error"]);
    expect(result.steps[1]!.reason).toBe(
      `ENOENT: no such file or directory, open '${CLIENT_FLOWS}/missing.yaml'`
    );
    // No nested run started.
    expect(dispatches(invoke, "flow-execute")).toHaveLength(1);
  });

  it("fails the nested step with client_request_refused when the nested project_root is outside the client roots", async () => {
    // The up-front check passes the step (an absolute project_root and a
    // name): only the client knows its roots, so its refusal fails the step.
    const client = fakeClient({
      [`${CLIENT_FLOWS}/login.yaml`]: flowText([{ kind: "echo", message: "never runs" }]),
    });
    const { registry, invoke } = realRegistry();

    const result = await runUploaded(
      registry,
      [
        { kind: "echo", message: "before" },
        nestedStep({ name: "login", project_root: "/elsewhere" }),
      ],
      client.services
    );

    expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["echo:pass", "tool:error"]);
    const request = vi.mocked(client.services.request).mock.settledResults[0]!;
    expect(request.type).toBe("rejected");
    expect(getFailureSignal(request.value)?.failure_stage).toBe("client_request_refused");
    expect(result.steps[1]!.reason).toBe(
      'the client refused the resolve-file request for "login.yaml": ' +
        "/elsewhere/.argent/flows is outside the roots this client serves"
    );
    expect(client.calls).toEqual([
      {
        op: "resolve-file",
        args: { anchorDir: "/elsewhere/.argent/flows", target: "login.yaml", kind: "flow" },
      },
    ]);
    expect(dispatches(invoke, "flow-execute")).toHaveLength(1);
  });

  describe("snapshot steps of the nested flow", () => {
    // The nested flow is a symlink on the client: its baselines live beside
    // its real file, under its own key, not under the root flow's.
    const SPELLED = `${CLIENT_FLOWS}/login.yaml`;
    const REAL = "/client/vault/login-real.yaml";
    const BASELINE = "/client/vault/__baselines__/login-real/title__ios-30x60.png";
    const withSnapshot = () =>
      fakeClient(
        { [REAL]: flowText([{ kind: "snapshot", name: "title" }]) },
        { realpaths: { [SPELLED]: REAL }, baselines: { [BASELINE]: captureBytes } }
      );

    it("reads the baseline of a compare run through read-file beside the nested flow's real file", async () => {
      const client = withSnapshot();
      const { registry } = realRegistry();

      const result = await runUploaded(
        registry,
        [nestedStep({ name: "login", project_root: CLIENT_ROOT })],
        client.services
      );

      const nested = result.steps[0]!.result as FlowRunResult;
      expect(nested.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["snapshot:pass"]);
      expect(result.ok).toBe(true);
      // The runner's read of the nested flow, the nested run's resolve of its
      // own root (a snapshot anchors there), then the baseline.
      expect(client.calls).toEqual([
        {
          op: "resolve-file",
          args: { anchorDir: CLIENT_FLOWS, target: "login.yaml", kind: "flow" },
        },
        {
          op: "resolve-file",
          args: { anchorDir: CLIENT_FLOWS, target: "login.yaml", kind: "flow" },
        },
        { op: "read-file", args: { path: BASELINE } },
      ]);
      expect(client.written.size).toBe(0);
    });

    it("writes the nested flow's own baseline through write-file when the outer run updates baselines", async () => {
      const client = withSnapshot();
      const { registry, invoke } = realRegistry();

      const result = await runUploaded(
        registry,
        [nestedStep({ name: "login", project_root: CLIENT_ROOT })],
        client.services,
        { updateBaselines: true }
      );

      const nested = result.steps[0]!.result as FlowRunResult;
      expect(nested.steps.map((s) => `${s.kind}:${s.status}:${s.reason}`)).toEqual([
        `snapshot:pass:baseline updated (${BASELINE})`,
      ]);
      expect([...client.written.keys()]).toEqual([BASELINE]);
      expect(client.written.get(BASELINE)).toEqual(captureBytes);
      expect(client.calls.filter((c) => c.op === "read-file")).toEqual([]);
      // The nested run got the outer run's updateBaselines; the report keeps
      // the step's args as the flow wrote them.
      expect(dispatches(invoke, "flow-execute")[1]![0]).toMatchObject({ updateBaselines: true });
      expect(result.steps[0]!.args).not.toHaveProperty("updateBaselines");
    });

    it("refuses a nested step that updates baselines in a run that does not, without asking to update the client", async () => {
      // A current client offers write-file only for a call that updates
      // baselines, so the nested run lacks that op alone.
      const client = fakeClient(
        { [REAL]: flowText([{ kind: "snapshot", name: "title" }]) },
        { realpaths: { [SPELLED]: REAL }, ops: ["resolve-file", "read-file"] }
      );
      const { registry } = realRegistry();

      const result = await runUploaded(
        registry,
        [nestedStep({ name: "login", project_root: CLIENT_ROOT, updateBaselines: true })],
        client.services
      );

      expect(result.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["tool:error"]);
      const reason = result.steps[0]!.reason!;
      expect(reason).toContain("  - step 1: snapshot: title");
      expect(reason).toContain(
        "Over a link, a nested flow updates its baselines only when the run that starts it " +
          "updates baselines."
      );
      expect(reason).not.toContain("Update the argent CLI");
      expect(client.written.size).toBe(0);
    });

    it("keeps a nested step's own updateBaselines: false in a run that updates baselines", async () => {
      const client = withSnapshot();
      const { registry, invoke } = realRegistry();

      const result = await runUploaded(
        registry,
        [nestedStep({ name: "login", project_root: CLIENT_ROOT, updateBaselines: false })],
        client.services,
        { updateBaselines: true }
      );

      const nested = result.steps[0]!.result as FlowRunResult;
      expect(nested.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(["snapshot:pass"]);
      expect(client.calls.filter((c) => c.op === "read-file")).toEqual([
        { op: "read-file", args: { path: BASELINE } },
      ]);
      expect(client.written.size).toBe(0);
      expect(dispatches(invoke, "flow-execute")[1]![0]).toMatchObject({ updateBaselines: false });
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
