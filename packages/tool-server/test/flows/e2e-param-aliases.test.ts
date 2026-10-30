import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  FAILURE_CODES,
  FILE_INPUT_MARKER,
  Registry,
  TOOL_PARAM_ALIASES,
  canonicalToolArgs,
  getFailureSignal,
  nestedFlowTarget,
} from "@argent/registry";
import { createHttpApp } from "../../src/http";
import { createRegistry } from "../../src/utils/setup-registry";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

/** The e2e tools a run and a recording need, and a booted device for a nested run. */
function e2eRegistry(): Registry {
  const registry = new Registry();
  registry.registerTool(flowStartRecordingTool);
  registry.registerTool(createFlowAddStepTool(registry));
  registry.registerTool(flowFinishRecordingTool);
  registry.registerTool(flowReadPrerequisiteTool);
  registry.registerTool(createRunFlowTool(registry));
  registry.registerTool({
    id: "list-devices",
    services: () => ({}),
    execute: async () => ({ devices: [{ platform: "ios", udid: DEVICE, state: "Booted" }] }),
  });
  return registry;
}

let root: string;
let e2eDir: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "e2e-param-aliases-")));
  e2eDir = path.join(root, ".argent", "e2e");
  await fs.mkdir(e2eDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeTest(name: string, yaml: string): Promise<string> {
  const file = path.join(e2eDir, `${name}.yaml`);
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

/** A run report without its timing, which differs between two runs. */
function runShape(result: FlowRunResult) {
  return { ok: result.ok, steps: result.steps.map((s) => [s.kind, s.status, s.tool, s.message]) };
}

const clientSrc = path.resolve(__dirname, "../../../argent-tools-client/src/file-inputs.ts");

/**
 * The args a client sends for `args`, wrapped by the file inputs `GET /tools`
 * lists for `id`, as a client that knows no param name of its own wraps them.
 */
async function wrapAsListed(
  app: Parameters<typeof request>[0],
  id: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { prepareFileInputs } = (await import(clientSrc)) as {
    prepareFileInputs(specs: unknown, args: unknown, opts: object): Promise<unknown>;
  };
  const tools = (await request(app).get("/tools")).body.tools as {
    name: string;
    fileInputs: unknown;
  }[];
  const specs = tools.find((t) => t.name === id)!.fileInputs;
  return (await prepareFileInputs(specs, args, { includeContent: false })) as Record<
    string,
    unknown
  >;
}

describe("canonicalToolArgs", () => {
  it("renames each former param name of a tool called by either id", () => {
    for (const id of ["e2e-execute", "flow-execute", "e2e-read-prerequisite"]) {
      expect(canonicalToolArgs(id, { flow_path: "/a.yaml", flow_file: "/b.yaml", x: 1 })).toEqual({
        e2e_test_path: "/a.yaml",
        e2e_test_file: "/b.yaml",
        x: 1,
      });
    }
  });

  it("leaves the args of another tool, and a former name set to undefined, as they are", () => {
    const args = { flow_path: "/a.yaml" };
    expect(canonicalToolArgs("screenshot-diff", args)).toBe(args);
    expect(canonicalToolArgs("e2e-execute", { flow_path: undefined, name: "n" })).toEqual({
      flow_path: undefined,
      name: "n",
    });
  });

  it("throws when a call sets both names of one param", () => {
    expect(() =>
      canonicalToolArgs("e2e-execute", { flow_path: "/a.yaml", e2e_test_path: "/b.yaml" })
    ).toThrow("Pass e2e_test_path or its former name flow_path, not both.");
  });
});

describe("the former param names in GET /tools", () => {
  it("are not in any input schema, so an agent sees one name", async () => {
    const { app } = createHttpApp(createRegistry());
    const tools = (await request(app).get("/tools")).body.tools as {
      name: string;
      inputSchema: { properties?: Record<string, unknown> };
    }[];

    for (const [id, aliases] of Object.entries(TOOL_PARAM_ALIASES)) {
      const properties = tools.find((t) => t.name === id)!.inputSchema.properties!;
      for (const [former, current] of Object.entries(aliases)) {
        expect(properties, `${id}.${current}`).toHaveProperty(current);
        expect(properties, `${id}.${former}`).not.toHaveProperty(former);
      }
    }
  });

  it.each(["e2e-execute", "flow-execute", "e2e-read-prerequisite"])(
    "list the flow_path file input for a client older than the rename, on %s",
    async (id) => {
      const { app } = createHttpApp(createRegistry());
      const tools = (await request(app).get("/tools")).body.tools as {
        name: string;
        fileInputs: { target: string; path: string }[];
      }[];

      const specs = tools.find((t) => t.name === id)!.fileInputs;
      expect(specs.map((s) => [s.target, s.path])).toEqual([
        ["e2e_test_path", "${e2e_test_path}"],
        ["e2e_test_file", "${project_root}/.argent/flows/${name}.yaml"],
        ["flow_path", "${flow_path}"],
      ]);
      const [current, , former] = specs;
      expect({ ...former, target: current!.target, path: current!.path }).toEqual(current);
    }
  );
});

describe("a call that names its test by the former param name", () => {
  it.each(["e2e-execute", "flow-execute"])(
    "runs over POST /tools/%s as by e2e_test_path, from a client that wraps flow_path",
    async (id) => {
      const file = await writeTest("demo", "steps:\n  - echo: hi\n");
      const { app } = createHttpApp(e2eRegistry());

      const shapes = await Promise.all(
        ["flow_path", "e2e_test_path"].map(async (param) => {
          const sent = await wrapAsListed(app, id, { [param]: file, project_root: root });
          expect(sent[param]).toMatchObject({ [FILE_INPUT_MARKER]: true, path: file });
          const res = await request(app)
            .post(`/tools/${id}`)
            .send({ ...sent, device: DEVICE });
          expect(res.status, `${param}: ${JSON.stringify(res.body)}`).toBe(200);
          return runShape(res.body.data as FlowRunResult);
        })
      );

      expect(shapes[0]).toEqual({ ok: true, steps: [["echo", "pass", undefined, "hi"]] });
      expect(shapes[1]).toEqual(shapes[0]);
    }
  );

  it("reads the same prerequisite over POST /tools/e2e-read-prerequisite", async () => {
    const file = await writeTest("frag", 'executionPrerequisite: "on the form"\nsteps: []\n');
    const { app } = createHttpApp(e2eRegistry());

    const bodies = await Promise.all(
      ["flow_path", "e2e_test_path"].map(async (param) => {
        const sent = await wrapAsListed(app, "e2e-read-prerequisite", {
          [param]: file,
          project_root: root,
        });
        const res = await request(app).post("/tools/e2e-read-prerequisite").send(sent);
        expect(res.status, `${param}: ${JSON.stringify(res.body)}`).toBe(200);
        return res.body.data;
      })
    );

    expect(bodies[0]).toMatchObject({ executionPrerequisite: "on the form" });
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("is refused over HTTP when it sets both names, with the issue JSON older CLIs parse", async () => {
    const file = await writeTest("demo", "steps:\n  - echo: hi\n");
    const recordFailure = vi.fn();
    const { app } = createHttpApp(e2eRegistry(), { recordFailure });

    const sent = await wrapAsListed(app, "e2e-execute", {
      flow_path: file,
      e2e_test_path: file,
      project_root: root,
    });
    const res = await request(app).post("/tools/e2e-execute").send(sent);

    const message = "Pass e2e_test_path or its former name flow_path, not both.";
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(JSON.parse(res.body.error)).toEqual([{ code: "custom", path: [], message }]);
    expect(recordFailure).toHaveBeenCalledWith(
      "e2e-execute",
      expect.anything(),
      expect.objectContaining({
        error_code: FAILURE_CODES.HTTP_ZOD_VALIDATION_FAILED,
        failure_stage: "http_param_alias",
      }),
      expect.any(Number)
    );
  });

  it("is refused by invokeTool when it sets both names", async () => {
    const call = e2eRegistry().invokeTool("e2e-execute", {
      name: "demo",
      flow_path: "/a.yaml",
      e2e_test_path: "/a.yaml",
      project_root: root,
    });

    const err = await call.catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      '[Tool:e2e-execute] Invalid params for tool "e2e-execute": Pass e2e_test_path or its former name flow_path, not both.'
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.TOOL_INPUT_INVALID);
  });
});

describe("a `tool: e2e-execute` step in saved YAML", () => {
  it("names its test by flow_path as by e2e_test_path", async () => {
    const child = await writeTest("child", "steps:\n  - echo: from the child\n");
    const outcomes = [];
    for (const param of ["flow_path", "e2e_test_path"]) {
      await writeTest(
        "parent",
        `steps:\n  - tool: e2e-execute\n    args: { ${param}: ${JSON.stringify(child)}, project_root: ${JSON.stringify(root)} }\n`
      );
      const result = (await e2eRegistry().invokeTool("e2e-execute", {
        name: "parent",
        project_root: root,
        device: DEVICE,
      })) as FlowRunResult;
      outcomes.push(result.steps.map((s) => [s.tool, s.status, s.reason]));
    }

    // A raw step has no file-input boundary to resolve a path through.
    expect(outcomes[0]).toEqual([
      [
        "e2e-execute",
        "error",
        expect.stringContaining("must be supplied through the e2e_test_path file-input boundary"),
      ],
    ]);
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it("parses with the current param name", () => {
    const flow = parseFlow("steps:\n  - tool: flow-execute\n    args: { flow_path: /x/a.yaml }\n");
    expect(flow.steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { e2e_test_path: "/x/a.yaml" } },
    ]);
  });

  it("names the same nested test to the client, which reads it as written, as to the runner", () => {
    const written = { flow_path: "/x/a.yaml" };
    const parsed = parseFlow(`steps:\n  - tool: e2e-execute\n    args: { flow_path: /x/a.yaml }\n`)
      .steps[0] as { args: Record<string, unknown> };

    expect(nestedFlowTarget(written)).toEqual({ kind: "e2e_test_path", path: "/x/a.yaml" });
    expect(nestedFlowTarget(parsed.args)).toEqual(nestedFlowTarget(written));
  });

  it("is refused when it sets both names", () => {
    expect(() =>
      parseFlow(
        "steps:\n  - tool: e2e-execute\n    args: { flow_path: /x/a.yaml, e2e_test_path: /x/a.yaml }\n"
      )
    ).toThrow("Pass e2e_test_path or its former name flow_path, not both.");
  });
});

describe("a recorded e2e-execute of a sibling test by its former param name", () => {
  it.each(["flow_path", "e2e_test_path"])("records %s as a run: of the sibling", async (param) => {
    const sibling = await writeTest("frag", "steps:\n  - echo: hi\n");
    const registry = e2eRegistry();
    await registry.invokeTool("e2e-start-recording", { name: "rec", project_root: root });

    await registry.invokeTool("e2e-add-step", {
      name: "rec",
      project_root: root,
      command: "e2e-execute",
      args: JSON.stringify({ [param]: sibling, project_root: root, device: DEVICE }),
    });
    await registry.invokeTool("e2e-finish-recording", { name: "rec", project_root: root });

    const yaml = await fs.readFile(path.join(e2eDir, "rec.yaml"), "utf8");
    expect(parseFlow(yaml).steps).toEqual([{ kind: "run", flow: "frag.yaml" }]);
  });
});
