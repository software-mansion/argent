/**
 * E2e tests are saved in `.argent/e2e`, and `.argent/flows` is still read:
 * a name is looked up in `.argent/e2e` first, a same-named legacy test is
 * reported as hidden, a new recording lands in `.argent/e2e`, and `run:`
 * composes across the two directories, both co-located and over a link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ArtifactStore,
  Registry,
  type FileInputMember,
  type FileInputWire,
  type ToolDefinition,
} from "@argent/registry";
import { resolveFileInputs } from "../../src/file-inputs";
import {
  createRunFlowTool,
  resolveFlowSource,
  type FlowPrerequisiteNotice,
  type FlowRunResult,
} from "../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowFinishRecordingTool } from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";
import { resolveRunTarget, type ProjectAccess } from "../../src/tools/flows/project-access";

let root: string;

beforeEach(async () => {
  __resetRecordingsForTesting();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "e2e-dirs-")));
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

const e2e = (name: string) => path.join(root, ".argent", "e2e", name);
const legacy = (name: string) => path.join(root, ".argent", "flows", name);

async function write(file: string, text: string): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
  return file;
}

const echoes = (...messages: string[]) =>
  `steps:\n${messages.map((m) => `  - echo: ${m}\n`).join("")}`;

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

/** A registry with flow-execute, so a nested `tool: e2e-execute` step runs. */
function runTool(): ToolDefinition<Record<string, unknown>, unknown> {
  const registry = new Registry();
  registry.registerTool(createRunFlowTool(registry));
  registry.registerTool({
    id: "list-devices",
    description: "",
    zodSchema: z.object({}),
    services: () => ({}),
    execute: async () => ({ devices: [] }),
  });
  return registry.getTool("e2e-execute") as unknown as ToolDefinition<
    Record<string, unknown>,
    unknown
  >;
}

function asRun(result: unknown): FlowRunResult {
  if (!result || typeof result !== "object" || !("steps" in result)) {
    throw new Error(`expected a run result, got ${JSON.stringify(result)}`);
  }
  return result as FlowRunResult;
}

/** Each step as `kind status message-or-reason`. */
function lines(result: FlowRunResult): string[] {
  return result.steps.map((s) => `${s.kind} ${s.status} ${s.message ?? s.reason ?? ""}`.trim());
}

async function runColocated(args: Record<string, unknown>): Promise<FlowRunResult> {
  return asRun(await runTool().execute({}, { project_root: root, device: DEVICE, ...args }));
}

/** The call as the argent client sends it over a link, from the client's own source. */
async function clientWire(
  fileInputs: unknown,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const client = path.resolve(__dirname, "../../../argent-tools-client/src");
  const { prepareFileInputs } = (await import(path.join(client, "file-inputs.ts"))) as {
    prepareFileInputs(specs: unknown, args: unknown, opts: object): Promise<unknown>;
  };
  const { collectFlowMembers } = (await import(path.join(client, "flow-files.ts"))) as {
    collectFlowMembers: unknown;
  };
  return (await prepareFileInputs(fileInputs, args, {
    includeContent: true,
    collectMembers: collectFlowMembers,
  })) as Record<string, unknown>;
}

/** A run over a link: the client's wire, this server's boundary, and the members it sent. */
async function runLinked(
  args: Record<string, unknown>
): Promise<{ result: FlowRunResult; wire: FileInputWire }> {
  const tool = runTool();
  const call = { project_root: root, device: DEVICE, ...args };
  const sent = await clientWire(tool.fileInputs, call);
  const boundary = await resolveFileInputs(tool, sent);
  try {
    const result = asRun(
      await tool.execute({}, boundary.args, {
        artifacts: new ArtifactStore(),
        fileInputs: boundary.fileInputs,
      })
    );
    const wire = (sent.flow_file ?? sent.flow_path) as FileInputWire;
    return { result, wire };
  } finally {
    await boundary.cleanup();
  }
}

describe("a test addressed by name", () => {
  it("runs from .argent/flows when it is saved only there", async () => {
    await write(legacy("old.yaml"), echoes("legacy"));

    const result = await runColocated({ name: "old" });

    expect(result.ok).toBe(true);
    expect(lines(result)).toEqual(["echo pass legacy"]);
    expect(result.warning).toBeUndefined();
  });

  it("runs from .argent/e2e", async () => {
    await write(e2e("new.yaml"), echoes("new"));

    expect(lines(await runColocated({ name: "new" }))).toEqual(["echo pass new"]);
  });

  it("takes .argent/e2e over a same-named .argent/flows test, and names the hidden one", async () => {
    await write(e2e("both.yaml"), echoes("from e2e"));
    await write(legacy("both.yaml"), echoes("from flows"));

    const result = await runColocated({ name: "both" });

    expect(lines(result)).toEqual(["echo pass from e2e"]);
    expect(result.warning).toBe(
      `${legacy("both.yaml")} is not used: ${e2e("both.yaml")} has the same name and is read first.`
    );
  });

  it("names the hidden test with a prerequisite notice too", async () => {
    await write(e2e("frag.yaml"), "executionPrerequisite: App open\nsteps:\n  - echo: hi\n");
    await write(legacy("frag.yaml"), echoes("hidden"));

    const notice = (await runTool().execute(
      {},
      { name: "frag", project_root: root }
    )) as FlowPrerequisiteNotice;

    expect(notice.notice).toContain("execution prerequisite");
    expect(notice.warning).toContain(`${legacy("frag.yaml")} is not used`);
  });

  it("reads the .argent/e2e prerequisite and names the hidden test", async () => {
    await write(e2e("dup.yaml"), "executionPrerequisite: From e2e\nsteps:\n  - echo: hi\n");
    await write(legacy("dup.yaml"), "executionPrerequisite: From flows\nsteps:\n  - echo: hi\n");
    await write(e2e("solo.yaml"), "executionPrerequisite: Solo\nsteps:\n  - echo: hi\n");

    const read = (name: string) =>
      flowReadPrerequisiteTool.execute({}, { name, project_root: root });

    await expect(read("dup")).resolves.toEqual({
      flow: "dup",
      executionPrerequisite: "From e2e",
      warning: `${legacy("dup.yaml")} is not used: ${e2e("dup.yaml")} has the same name and is read first.`,
    });
    await expect(read("solo")).resolves.toEqual({ flow: "solo", executionPrerequisite: "Solo" });
  });

  it("reports a missing test at the .argent/e2e path", async () => {
    await expect(resolveFlowSource({ name: "nowhere", project_root: root })).resolves.toEqual({
      filePath: e2e("nowhere.yaml"),
      flowName: "nowhere",
      viaUpload: false,
    });
  });

  it("accepts a client-derived flow_file in either directory, and no other path", async () => {
    await write(e2e("a.yaml"), echoes("a"));
    await write(legacy("b.yaml"), echoes("b"));

    await expect(
      resolveFlowSource({ name: "a", project_root: root, flow_file: e2e("a.yaml") })
    ).resolves.toMatchObject({ filePath: e2e("a.yaml") });
    await expect(
      resolveFlowSource({ name: "b", project_root: root, flow_file: legacy("b.yaml") })
    ).resolves.toMatchObject({ filePath: legacy("b.yaml") });
    await expect(
      resolveFlowSource({
        name: "b",
        project_root: root,
        flow_file: path.join(root, "elsewhere", "b.yaml"),
      })
    ).rejects.toThrow(`("${e2e("b.yaml")}" or "${legacy("b.yaml")}")`);
  });

  it("is derived by the client from the first directory that has it", async () => {
    await write(legacy("old.yaml"), echoes("legacy"));
    await write(e2e("both.yaml"), echoes("from e2e"));
    await write(legacy("both.yaml"), echoes("from flows"));

    const old = await runLinked({ name: "old" });
    const both = await runLinked({ name: "both" });

    expect(old.wire.path).toBe(legacy("old.yaml"));
    expect(lines(old.result)).toEqual(["echo pass legacy"]);
    expect(both.wire.path).toBe(e2e("both.yaml"));
    expect(lines(both.result)).toEqual(["echo pass from e2e"]);
  });
});

describe("recording", () => {
  it("saves a new test in .argent/e2e and leaves a same-named legacy test alone", async () => {
    await write(legacy("rec.yaml"), echoes("legacy"));

    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    const finished = await flowFinishRecordingTool.execute({}, { name: "rec", project_root: root });

    expect(finished.path).toBe(e2e("rec.yaml"));
    await expect(fs.readFile(e2e("rec.yaml"), "utf8")).resolves.toContain("steps: []");
    await expect(fs.readFile(legacy("rec.yaml"), "utf8")).resolves.toBe(echoes("legacy"));
  });

  /** Records "rec" with one nested e2e-execute of `frag`, the live call answering `result`. */
  async function recordNested(result: unknown): Promise<{ message: string; yaml: string }> {
    const registry = {
      invokeTool: vi.fn(async () => result),
      getTool: vi.fn(() => ({})),
    } as unknown as Registry;
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    const out = (await createFlowAddStepTool(registry).execute(
      {},
      {
        name: "rec",
        project_root: root,
        command: "e2e-execute",
        args: JSON.stringify({ name: "frag", project_root: root }),
      }
    )) as { message: string };
    return { message: out.message, yaml: await fs.readFile(e2e("rec.yaml"), "utf8") };
  }

  const NOTICE = {
    flow: "frag",
    notice: "This e2e test has an execution prerequisite",
    executionPrerequisite: "App open",
  };

  it.each([
    ["ran", { ok: true, steps: [] }],
    ["returned the prerequisite notice", NOTICE],
  ])(
    "records a nested fragment saved only in .argent/flows as run: (live call %s)",
    async (_label, result) => {
      await write(legacy("frag.yaml"), "executionPrerequisite: App open\nsteps:\n  - echo: hi\n");

      const { message, yaml } = await recordNested(result);

      expect(parseFlow(yaml).steps).toEqual([{ kind: "run", flow: "../flows/frag.yaml" }]);
      expect(message).not.toContain("ENOENT");
      expect(lines(await runColocated({ name: "rec" }))).toEqual(["run pass", "echo pass hi"]);
    }
  );

  it("keeps replaying the .argent/flows fragment it recorded after a same-named test is saved in .argent/e2e", async () => {
    await write(legacy("frag.yaml"), echoes("from flows"));
    await recordNested({ ok: true, steps: [] });
    await write(e2e("frag.yaml"), echoes("from e2e"));

    expect(lines(await runColocated({ name: "rec" }))).toEqual([
      "run pass",
      "echo pass from flows",
    ]);
  });

  it("records a nested flow_path in .argent/flows as run: of its path from the recording", async () => {
    await write(legacy("frag.yaml"), echoes("hi"));
    const invokeTool = vi.fn(async () => ({ ok: true, steps: [] }));
    const registry = { invokeTool, getTool: vi.fn(() => ({})) } as unknown as Registry;
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });

    await createFlowAddStepTool(registry).execute(
      {},
      {
        name: "rec",
        project_root: root,
        command: "e2e-execute",
        args: JSON.stringify({ flow_path: legacy("frag.yaml"), project_root: root }),
      }
    );

    expect(invokeTool).toHaveBeenCalledWith("e2e-execute", { name: "frag", project_root: root });
    const yaml = await fs.readFile(e2e("rec.yaml"), "utf8");
    expect(parseFlow(yaml).steps).toEqual([{ kind: "run", flow: "../flows/frag.yaml" }]);
  });

  it("refuses a nested flow_path in .argent/flows that a same-named .argent/e2e test hides", async () => {
    await write(legacy("frag.yaml"), echoes("old"));
    await write(e2e("frag.yaml"), echoes("new"));
    const registry = { invokeTool: vi.fn(), getTool: vi.fn(() => ({})) } as unknown as Registry;
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });

    await expect(
      createFlowAddStepTool(registry).execute(
        {},
        {
          name: "rec",
          project_root: root,
          command: "e2e-execute",
          args: JSON.stringify({ flow_path: legacy("frag.yaml"), project_root: root }),
        }
      )
    ).rejects.toThrow(`resolves "frag" to "${e2e("frag.yaml")}" instead`);
  });

  it.each([
    ["name", () => ({ name: "frag", project_root: root })],
    ["flow_path", () => ({ flow_path: legacy("frag.yaml"), project_root: root })],
  ])(
    "over a link, records a nested fragment in .argent/flows by %s as run: of its path",
    async (_by, nestedArgs) => {
      await write(legacy("frag.yaml"), echoes("hi"));
      const invokeTool = vi.fn(async () => ({ ok: true, steps: [] }));
      const registry = { invokeTool, getTool: vi.fn(() => ({})) } as unknown as Registry;
      const addStep = createFlowAddStepTool(registry);
      await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
      const client = path.resolve(__dirname, "../../../argent-tools-client/src");
      const { prepareFileInputs } = (await import(path.join(client, "file-inputs.ts"))) as {
        prepareFileInputs(specs: unknown, args: unknown, opts: object): Promise<unknown>;
      };
      const { collectStepMembers } = (await import(path.join(client, "flow-files.ts"))) as {
        collectStepMembers: unknown;
      };
      const call = {
        name: "rec",
        project_root: root,
        command: "e2e-execute",
        args: JSON.stringify(nestedArgs()),
      };
      const sent = (await prepareFileInputs(addStep.fileInputs, call, {
        includeContent: true,
        collectStepMembers,
      })) as Record<string, unknown>;
      const boundary = await resolveFileInputs(
        addStep as unknown as ToolDefinition<Record<string, unknown>, unknown>,
        sent
      );
      try {
        await addStep.execute({}, boundary.args as typeof call, {
          artifacts: new ArtifactStore(),
          linked: true,
          fileInputs: boundary.fileInputs,
        });
      } finally {
        await boundary.cleanup();
      }

      expect(invokeTool).toHaveBeenCalledWith(
        "e2e-execute",
        expect.objectContaining({ name: "frag", project_root: root })
      );
      const yaml = await fs.readFile(e2e("rec.yaml"), "utf8");
      expect(parseFlow(yaml).steps).toEqual([{ kind: "run", flow: "../flows/frag.yaml" }]);
    }
  );

  it("records run: for a fragment saved in both directories and replays the .argent/e2e copy", async () => {
    await write(e2e("frag.yaml"), echoes("from e2e"));
    await write(legacy("frag.yaml"), echoes("from flows"));

    const { yaml } = await recordNested({ ok: true, steps: [] });

    expect(parseFlow(yaml).steps).toEqual([{ kind: "run", flow: "frag.yaml" }]);
    expect(lines(await runColocated({ name: "rec" }))).toEqual(["run pass", "echo pass from e2e"]);
  });

  it("keeps the raw step for a fragment saved in neither directory, without a made-up ENOENT", async () => {
    const { message, yaml } = await recordNested({ ok: true, steps: [] });

    expect(parseFlow(yaml).steps).toEqual([
      expect.objectContaining({ kind: "tool", name: "e2e-execute" }),
    ]);
    expect(message).toContain(
      'could not resolve "frag" as a sibling fragment (no frag.yaml beside the recording or in ' +
        "the project's other e2e test directory); kept the raw e2e-execute step"
    );
    expect(message).not.toContain("ENOENT");
  });
});

describe("run: across the two directories", () => {
  beforeEach(async () => {
    await write(e2e("main.yaml"), "steps:\n  - run: login\n  - echo: main done\n");
    await write(legacy("login.yaml"), echoes("logged in"));
    await write(legacy("old.yaml"), "steps:\n  - run: helper\n  - echo: old done\n");
    await write(e2e("helper.yaml"), echoes("helped"));
    await write(e2e("nested.yaml"), "steps:\n  - run: sub/login\n");
    await write(legacy("sub/login.yaml"), echoes("never"));
  });

  it("finds a fragment in .argent/flows from a test in .argent/e2e, and the reverse", async () => {
    expect(lines(await runColocated({ name: "main" }))).toEqual([
      "run pass",
      "echo pass logged in",
      "echo pass main done",
    ]);
    expect(lines(await runColocated({ name: "old" }))).toEqual([
      "run pass",
      "echo pass helped",
      "echo pass old done",
    ]);
  });

  it("prefers the fragment beside the file that names it", async () => {
    await write(e2e("login.yaml"), echoes("beside"));

    expect(lines(await runColocated({ name: "main" }))).toEqual([
      "run pass",
      "echo pass beside",
      "echo pass main done",
    ]);
  });

  it("looks only beside the file for a target with a directory", async () => {
    const result = await runColocated({ name: "nested" });

    expect(result.ok).toBe(false);
    expect(result.steps[0]!.reason).toContain(
      `ENOENT: no such file or directory, open '${e2e("sub/login.yaml")}'`
    );
  });

  it("composes the same way over a link, with the fragments of both directories sent", async () => {
    for (const name of ["main", "old"]) {
      const { result, wire } = await runLinked({ name });

      expect(lines(result)).toEqual(lines(await runColocated({ name })));
      // The target beside the file, which is missing, then the one found.
      const members = (wire.members ?? []) as FileInputMember[];
      expect(members.map((m) => [m.role, m.path, m.state])).toEqual(
        name === "main"
          ? [
              ["flow", e2e("login.yaml"), "missing"],
              ["flow", legacy("login.yaml"), undefined],
            ]
          : [
              ["flow", legacy("helper.yaml"), "missing"],
              ["flow", e2e("helper.yaml"), undefined],
            ]
      );
    }
  });

  it("reports a mis-cased fragment in the other directory as mis-cased, also on a case-sensitive filesystem", async () => {
    // Stands in for a case-sensitive filesystem: beside the file nothing
    // matches, and in .argent/flows only a case-folded entry, whose canonical
    // path does not exist.
    const project: ProjectAccess = {
      mode: "host",
      resolveFlowFile: async (anchorDir, target) => ({
        canonical: path.join(anchorDir, target),
        spelling:
          anchorDir === path.dirname(legacy("x.yaml"))
            ? { state: "case_folded", actual: "legacy_frag.yaml", addressable: true }
            : { state: "absent" },
        read: async () => null,
      }),
      readFile: async () => null,
      writeBaseline: async () => ({ replaced: false }),
    };

    const hop = await resolveRunTarget(project, path.dirname(e2e("main.yaml")), "Legacy_Frag.yaml");

    expect(hop.spelling).toEqual({
      state: "case_folded",
      actual: "legacy_frag.yaml",
      addressable: true,
    });
    expect(hop.anchorDir).toBe(path.dirname(legacy("x.yaml")));
  });

  it("over a link, fails a missing fragment as the co-located run does", async () => {
    await fs.rm(legacy("login.yaml"));

    const linked = await runLinked({ name: "main" });
    const colocated = await runColocated({ name: "main" });

    expect(linked.result.ok).toBe(false);
    expect(lines(linked.result)).toEqual(lines(colocated));
  });
});

describe("a nested tool: e2e-execute step that names a test", () => {
  it("runs a test saved only in .argent/flows, co-located and over a link", async () => {
    await write(
      e2e("outer.yaml"),
      `steps:\n  - tool: e2e-execute\n    args: { name: inner, project_root: ${JSON.stringify(root)} }\n`
    );
    await write(legacy("inner.yaml"), echoes("inner ran"));

    const colocated = await runColocated({ name: "outer" });
    const { result, wire } = await runLinked({ name: "outer" });

    expect(colocated.ok).toBe(true);
    expect(result.ok).toBe(true);
    const nested = result.steps[0]!.result as FlowRunResult;
    expect(lines(nested)).toEqual(["echo pass inner ran"]);
    expect(((wire.members ?? []) as FileInputMember[]).map((m) => m.path)).toEqual([
      legacy("inner.yaml"),
    ]);
  });

  it("takes the .argent/e2e test over a same-named legacy one over a link", async () => {
    await write(
      e2e("outer.yaml"),
      `steps:\n  - tool: flow-execute\n    args: { name: inner, project_root: ${JSON.stringify(root)} }\n`
    );
    await write(e2e("inner.yaml"), echoes("new inner"));
    await write(legacy("inner.yaml"), echoes("old inner"));

    const { result } = await runLinked({ name: "outer" });

    expect(lines(result.steps[0]!.result as FlowRunResult)).toEqual(["echo pass new inner"]);
  });
});

describe("a fragment found in the other directory", () => {
  it("goes through POST /upload past the inline budget, as any member does", async () => {
    const big = `steps:\n  - echo: ${"x".repeat(300 * 1024)}\n`;
    await write(e2e("main.yaml"), "steps:\n  - run: login\n  - echo: main done\n");
    await write(legacy("login.yaml"), big);
    const uploads: string[] = [];
    const client = path.resolve(__dirname, "../../../argent-tools-client/src");
    const { prepareFileInputs } = (await import(path.join(client, "file-inputs.ts"))) as {
      prepareFileInputs(specs: unknown, args: unknown, opts: object): Promise<unknown>;
    };
    const { collectFlowMembers } = (await import(path.join(client, "flow-files.ts"))) as {
      collectFlowMembers: unknown;
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      uploads.push(String(url));
      return new Response(JSON.stringify({ uploadId: `u${uploads.length}` }), { status: 200 });
    });
    try {
      const tool = runTool();
      const sent = (await prepareFileInputs(
        tool.fileInputs,
        { name: "main", project_root: root },
        {
          includeContent: true,
          collectMembers: collectFlowMembers,
          uploadEndpoint: { url: "http://tool-server.test", token: "" },
        }
      )) as Record<string, unknown>;
      const members = ((sent.flow_file as FileInputWire).members ?? []) as FileInputMember[];

      expect((sent.flow_file as FileInputWire).path).toBe(e2e("main.yaml"));
      expect(members).toEqual([
        expect.objectContaining({ role: "flow", path: e2e("login.yaml"), state: "missing" }),
        expect.objectContaining({ role: "flow", path: legacy("login.yaml"), uploadId: "u1" }),
      ]);
      expect(uploads).toEqual(["http://tool-server.test/upload"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
