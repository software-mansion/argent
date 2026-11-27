import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { createFlowAddStepTool } from "../../../src/tools/flows/flow-add-step";
import { flowSetEnvTool } from "../../../src/tools/flows/flow-set-env";
import { __resetRecordingsForTesting, parseFlow } from "../../../src/tools/flows/flow-utils";

/**
 * `{{output:...}}` references through a real run: what a script leaves in
 * `output` reaches the steps after it, as a tool argument, an env value, text
 * and a check.
 */

vi.setConfig({ testTimeout: 30_000 });

let root: string;

const invokeTool = vi.fn(async (id: string, _args?: unknown) =>
  id === "list-devices"
    ? {
        devices: [
          { platform: "ios", udid: "00000000-0000-0000-0000-0000000000ab", state: "Booted" },
        ],
      }
    : { ok: true }
);
const registry = {
  invokeTool,
  getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
  resolveService: vi.fn(async () => ({
    isConnected: () => true,
    listConnectedBundleIds: () => [],
  })),
} as unknown as Registry;

async function write(relative: string, contents: string): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
}

async function run(name: string, steps: string[]): Promise<FlowRunResult> {
  await write(`.argent/e2e/${name}.yaml`, `steps:\n${steps.map((s) => `  - ${s}`).join("\n")}\n`);
  const result = await createRunFlowTool(registry).execute({}, {
    project_root: root,
    name,
  } as never);
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return result;
}

/** A script step whose body is `source`. */
async function script(name: string, source: string): Promise<string> {
  await write(`scripts/${name}.mjs`, source);
  return `script: { path: ../../scripts/${name}.mjs }`;
}

/** A `tool:` step that hands `value` to the probe tool, to read back what it resolved to. */
const probe = (value: string) => `tool: probe-tool\n    args: { v: ${JSON.stringify(value)} }`;

function probed(): unknown[] {
  return toolCalls("probe-tool").map((args) => (args as { v: unknown }).v);
}

function toolCalls(id: string): unknown[] {
  return invokeTool.mock.calls.filter(([called]) => called === id).map(([, args]) => args);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-output-"));
  invokeTool.mockClear();
  __resetRecordingsForTesting();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("a script's output in later steps", () => {
  it("fills a tool argument with its type, text, an env value and a fallback", async () => {
    const seed = await script("seed", `output.user = { id: 7, name: "Ann", tags: ["a"] };`);
    await write("scripts/print.mjs", "console.log(process.env.UID);");
    const result = await run("fill", [
      seed,
      `script: { path: ../../scripts/print.mjs, env: { UID: "u-{{output:user.id}}" } }`,
      `tool: probe-tool\n    args: { n: "{{output:user.id}}", s: "{{output:user.name}} #{{output:user.id}}", tags: "{{output:user.tags}}", f: "{{output:user.age ?? 0.5}}", q: '{{output:user.age ?? "3"}}' }`,
    ]);

    expect(result.ok).toBe(true);
    expect(result.steps[1]!.scriptLog!.trim()).toBe("u-7");
    expect(toolCalls("probe-tool")).toEqual([
      expect.objectContaining({ n: 7, s: "Ann #7", tags: ["a"], f: 0.5, q: "3" }),
    ]);
  });

  it("hands each script the document, and keeps what the script leaves", async () => {
    const first = await script("first", "output.a = 1; output.b = 2;");
    const second = await script("second", "delete output.a; output.c = output.b + 1;");
    const print = await script("print", "console.log(JSON.stringify(output));");
    const result = await run("chain", [first, second, print]);

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.steps[2]!.scriptLog!)).toEqual({ b: 2, c: 3 });
  });

  it("shares the document with a run: fragment, both ways", async () => {
    await write("scripts/inner.mjs", "output.inner = output.outer + 1;");
    await write(
      ".argent/e2e/fragment.yaml",
      "steps:\n  - script: { path: ../../scripts/inner.mjs }\n"
    );
    const outer = await script("outer", "output.outer = 1;");
    const result = await run("composed", [outer, "run: fragment.yaml", probe("{{output:inner}}")]);

    expect(result.ok).toBe(true);
    expect(probed()).toEqual([2]);
  });

  it("uses the fallback for a missing key, an index past the end and null", async () => {
    const seed = await script("seed", "output.v = null; output.list = [];");
    const result = await run("fallbacks", [
      seed,
      probe("{{output:v ?? none}}|{{output:list.0 ?? empty}}|{{output:w.x ?? }}|"),
    ]);

    expect(result.ok).toBe(true);
    expect(probed()).toEqual(["none|empty||"]);
  });

  it("errors the step that holds a missing reference and stops the run", async () => {
    const seed = await script("seed", 'output.user = { name: "Ann" };');
    const result = await run("missing", [seed, probe("{{output:user.id}}"), "echo: after"]);

    expect(result.ok).toBe(false);
    expect(result.steps[1]).toMatchObject({ status: "error" });
    expect(result.steps[1]!.reason).toBe(
      '{{output:user.id}} has no value: output.user has no key "id" (keys: name)'
    );
    expect(result.steps[2]).toMatchObject({ status: "skip" });
    expect(probed()).toEqual([]);
  });

  it("errors a reference to an object inside text", async () => {
    const seed = await script("seed", "output.user = { id: 1 };");
    const result = await run("object", [seed, probe("user {{output:user}}")]);

    expect(result.steps[1]!.reason).toContain("is an object, which cannot be part of text");
  });

  it.each([
    ["an empty selector", 'output.v = "";', 'tap: { text: "{{output:v}}" }', "no visible text"],
    ["a blank selector", 'output.v = " \u200b";', 'tap: { id: "{{output:v}}" }', "no visible text"],
    [
      "empty typed text",
      'output.v = "";',
      'type: { into: { id: f }, text: "{{output:v}}" }',
      "empty value",
    ],
    [
      "an empty UI expectation",
      "output.v = 1;",
      `assert: { text: { in: { id: total }, contains: '{{output:w ?? ""}}' } }`,
      "empty value",
    ],
    [
      "an empty output expectation",
      'output.name = "Alice";',
      `assert: { output: name, contains: '{{output:w ?? ""}}' }`,
      "empty value",
    ],
  ])("errors %s rather than matching anything", async (_label, source, step, reason) => {
    const seed = await script("seed", source);
    const result = await run("empty", [seed, step]);

    expect(result.steps[1]).toMatchObject({ status: "error" });
    expect(result.steps[1]!.reason).toContain(reason);
  });

  it("keeps a nested run's env values text, and a whole map a map", async () => {
    const seed = await script("seed", 'output.port = 8080; output.env = { MODE: "fast" };');
    await run("nested", [
      seed,
      `tool: e2e-execute\n    args: { name: a, env: { PORT: "{{output:port}}" } }`,
    ]);
    await run("whole", [seed, `tool: e2e-execute\n    args: { name: a, env: "{{output:env}}" }`]);

    const envs = toolCalls("e2e-execute").map((args) => (args as { env: unknown }).env);
    expect(envs).toEqual([{ PORT: "8080" }, { MODE: "fast" }]);
  });

  it("writes a fallback number in text as the file spells it", async () => {
    const seed = await script("seed", "");
    await run("spelled", [seed, probe('v{{output:v ?? 1.10}} {{output:w ?? "x ?? y"}}')]);
    expect(probed()).toEqual(["v1.10 x ?? y"]);
  });

  it("gives an env reference its own error before the script starts", async () => {
    await write("scripts/mark.mjs", `import fs from "node:fs"; fs.writeFileSync("MARK", "ran");`);
    const result = await run("envmiss", [
      `script: { path: ../../scripts/mark.mjs, env: { UID: "{{output:user.id}}" } }`,
    ]);

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain("The value of UID: {{output:user.id}} has no value");
    await expect(fs.access(path.join(root, "MARK"))).rejects.toThrow();
  });
});

describe("env layers other than a script step's", () => {
  // Their values reach every script, the first one included, which runs
  // before any script returned a value: a reference there would error it.
  const refused = "has an {{output:...}} reference in the value of USER_ID";

  it("refuses a reference in the test file's env", async () => {
    await write(
      ".argent/e2e/t.yaml",
      'env:\n  USER_ID: "{{output:user.id}}"\nsteps:\n  - echo: hi\n'
    );
    await expect(
      createRunFlowTool(registry).execute({}, { project_root: root, name: "t" } as never)
    ).rejects.toThrow(refused);
  });

  it("refuses a reference in a fragment's env", async () => {
    await write(
      ".argent/e2e/frag.yaml",
      'env:\n  USER_ID: "{{output:user.id ?? 0}}"\nsteps:\n  - echo: hi\n'
    );
    const result = await run("t", ["run: frag.yaml"]);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.steps)).toContain(refused);
  });

  it("refuses a reference in the run's env", async () => {
    await write(".argent/e2e/t.yaml", "steps:\n  - echo: hi\n");
    const parsed = createRunFlowTool(registry).zodSchema!.safeParse({
      project_root: root,
      name: "t",
      env: { USER_ID: "{{output:user.id}}" },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(refused);
  });

  it("refuses a reference in a recording's env", async () => {
    await expect(
      flowStartRecordingTool.execute(
        {},
        { name: "rec", project_root: root, env: { USER_ID: "{{output:user.id}}" } }
      )
    ).rejects.toThrow(refused);
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    await expect(
      flowSetEnvTool.execute(
        {},
        { name: "rec", project_root: root, env: { USER_ID: "{{output:user.id}}" } }
      )
    ).rejects.toThrow(refused);
  });

  it("still runs the script that sets the value, with the reference in a later step's env", async () => {
    const seed = await script("seed", "output.user = { id: 42 };");
    await write("scripts/print.mjs", "console.log(process.env.USER_ID);");
    const result = await run("t", [
      seed,
      'script: { path: ../../scripts/print.mjs, env: { USER_ID: "{{output:user.id}}" } }',
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("secrets and output", () => {
  it("never turns an output into a secret, held or formed", async () => {
    await write(".argent/secrets.env", "TOKEN=hunter2-secret-value\n");
    const named = await script("named", 'output.name = "TOKEN"; output.held = "{{secret:TOKEN}}";');
    await write("scripts/print.mjs", "console.log(process.env.X);");
    const formed = await run("formed", [
      named,
      `script: { path: ../../scripts/print.mjs, env: { X: "{{secret:{{output:name}}}}" } }`,
    ]);
    expect(formed.steps[1]).toMatchObject({ status: "error" });
    expect(formed.steps[1]!.reason).toContain("never resolves a secret");

    const held = await run("held", [
      named,
      `tool: keyboard\n    args: { text: "{{output:held}}" }`,
    ]);
    expect(held.steps[1]).toMatchObject({ status: "error" });
    expect(toolCalls("keyboard")).toEqual([]);
  });

  it("refuses a secret a script copied into its output", async () => {
    await write(".argent/secrets.env", "TOKEN=hunter2-secret-value\n");
    await write("scripts/copy.mjs", "output.copy = process.env.T;");
    const result = await run("copied", [
      `script: { path: ../../scripts/copy.mjs, env: { T: "{{secret:TOKEN}}" } }`,
      probe("{{output:copy}}"),
    ]);

    expect(result.steps[1]).toMatchObject({ status: "error" });
    expect(JSON.stringify(result)).not.toContain("hunter2-secret-value");
  });
});

describe("output checks", () => {
  it("passes, fails with the value, and needs no device", async () => {
    const seed = await script("seed", 'output.user = { role: "Admin", count: 3 };');
    const passing = await run("checks", [
      seed,
      "assert: { output: user.role, equals: Admin }",
      "assert: { output: user.count, equals: '3' }",
      "assert: { output: user.email, exists: false }",
      "assert: { output: user.role, matches: '^Ad' }",
    ]);
    expect(passing.ok).toBe(true);

    const failing = await run("failing", [seed, "assert: { output: user.role, equals: admin }"]);
    expect(failing.steps[1]).toMatchObject({
      status: "fail",
      reason: 'output.user.role is "Admin"',
    });
    expect(toolCalls("list-devices")).toEqual([]);
  });

  it("guards a when block on a value without a device", async () => {
    const seed = await script("seed", "output.beta = false;");
    const result = await run("guarded", [
      seed,
      "when: { output: beta, equals: 'true' }\n    steps:\n      - echo: in beta",
      "when: { output: beta, equals: 'false' }\n    steps:\n      - echo: not in beta",
    ]);

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.kind, s.status])).toEqual([
      ["script", "pass"],
      ["when", "skip"],
      ["echo", "skip"],
      ["when", "pass"],
      ["echo", "pass"],
    ]);
    expect(result.steps[1]!.reason).toContain('output.beta is "false"');
    expect(toolCalls("list-devices")).toEqual([]);
  });

  it("compares with another output", async () => {
    const seed = await script("seed", 'output.a = "x"; output.b = "x";');
    const result = await run("pair", [seed, `assert: { output: a, equals: "{{output:b}}" }`]);
    expect(result.ok).toBe(true);
  });
});

describe("recording with output", () => {
  it("hands a recorded script what the earlier ones returned, and keeps the reference", async () => {
    await write("scripts/seed.mjs", "output.user = { id: 7 };");
    await write("scripts/use.mjs", "console.log(output.user.id, process.env.UID);");
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    const add = (scriptPath: string, env?: Record<string, string>) =>
      flowAddScriptTool.execute(
        {},
        { name: "rec", project_root: root, path: scriptPath, ...(env ? { env } : {}) }
      );

    await add("../../scripts/seed.mjs");
    const used = await add("../../scripts/use.mjs", { UID: "u{{output:user.id}}" });

    expect(used.status).toBe("pass");
    expect(used.log?.trim()).toBe("7 u7");
    const recorded = parseFlow(await fs.readFile(path.join(root, ".argent/e2e/rec.yaml"), "utf8"));
    expect(recorded.steps[1]).toMatchObject({ env: { UID: "u{{output:user.id}}" } });
  });

  it("shares the document with a test it records as a run: step", async () => {
    await write("scripts/seed.mjs", "output.user = { id: 7 };");
    await write(".argent/e2e/seed.yaml", "steps:\n  - script: { path: ../../scripts/seed.mjs }\n");
    const nested = {
      ...registry,
      invokeTool: vi.fn(async (id: string, args: unknown, options?: unknown) =>
        id === "e2e-execute"
          ? createRunFlowTool(nested).execute({}, args as never, options as never)
          : invokeTool(id, args)
      ),
    } as unknown as Registry;
    const addStep = createFlowAddStepTool(nested);
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });

    const ran = await addStep.execute(
      {},
      {
        name: "rec",
        project_root: root,
        command: "e2e-execute",
        args: JSON.stringify({ name: "seed", project_root: root }),
      }
    );
    await addStep.execute(
      {},
      { name: "rec", project_root: root, command: "probe-tool", args: '{"v":"{{output:user.id}}"}' }
    );

    expect(ran.recorded).toBe("1. run: seed.yaml");
    expect(probed()).toEqual([7]);
  });

  it("gives a nested run it keeps as a raw step an empty document, as its replay does", async () => {
    await write("scripts/seed.mjs", "output.user = { id: 7 };");
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "flow-output-other-"));
    try {
      await fs.mkdir(path.join(other, ".argent/e2e"), { recursive: true });
      await fs.writeFile(
        path.join(other, "peek.mjs"),
        'import fs from "node:fs"; fs.writeFileSync("PEEK", JSON.stringify(output));'
      );
      await fs.writeFile(
        path.join(other, ".argent/e2e/peek.yaml"),
        "steps:\n  - script: { path: ../../peek.mjs }\n"
      );
      const nested = {
        ...registry,
        invokeTool: vi.fn(async (id: string, args: unknown, options?: unknown) =>
          id === "e2e-execute"
            ? createRunFlowTool(nested).execute({}, args as never, options as never)
            : invokeTool(id, args)
        ),
      } as unknown as Registry;
      await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
      await flowAddScriptTool.execute(
        {},
        { name: "rec", project_root: root, path: "../../scripts/seed.mjs" }
      );
      const added = await createFlowAddStepTool(nested).execute(
        {},
        {
          name: "rec",
          project_root: root,
          command: "e2e-execute",
          args: JSON.stringify({ name: "peek", project_root: other }),
        }
      );

      expect(added.recorded).toMatch(/^2\. tool: e2e-execute/);
      expect(await fs.readFile(path.join(other, "PEEK"), "utf8")).toBe("{}");
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("warns in the reply about a wait that never held, as without a reference", async () => {
    const waits = {
      ...registry,
      invokeTool: vi.fn(async () => ({ success: false, elapsed: 1500, cause: "unmet" })),
    } as unknown as Registry;
    await write("scripts/seed.mjs", "output.name = 'Ann';");
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    await flowAddScriptTool.execute(
      {},
      { name: "rec", project_root: root, path: "../../scripts/seed.mjs" }
    );
    const add = (text: string) =>
      createFlowAddStepTool(waits).execute(
        {},
        {
          name: "rec",
          project_root: root,
          command: "await-ui-element",
          args: JSON.stringify({ condition: "visible", selector: { text } }),
        }
      );

    const literal = await add("Ann");
    const referenced = await add("{{output:name}}");

    expect(literal.message).toContain(" — ");
    expect(referenced.message).toBe(literal.message);
  });

  it("keeps a nested run's document out of the recording when its step fails to append", async () => {
    await write("scripts/seed.mjs", "output.user = { id: 7 };");
    await write(".argent/e2e/seed.yaml", "steps:\n  - script: { path: ../../scripts/seed.mjs }\n");
    const nested = {
      ...registry,
      invokeTool: vi.fn(async (id: string, args: unknown, options?: unknown) =>
        id === "e2e-execute"
          ? createRunFlowTool(nested).execute({}, args as never, options as never)
          : invokeTool(id, args)
      ),
    } as unknown as Registry;
    const addStep = createFlowAddStepTool(nested);
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    const file = path.join(root, ".argent/e2e/rec.yaml");
    const recording = await fs.readFile(file, "utf8");

    await fs.writeFile(file, "steps: [", "utf8");
    await expect(
      addStep.execute(
        {},
        {
          name: "rec",
          project_root: root,
          command: "e2e-execute",
          args: JSON.stringify({ name: "seed", project_root: root }),
        }
      )
    ).rejects.toThrow();
    await fs.writeFile(file, recording, "utf8");

    await expect(
      addStep.execute(
        {},
        {
          name: "rec",
          project_root: root,
          command: "probe-tool",
          args: '{"v":"{{output:user.id}}"}',
        }
      )
    ).rejects.toThrow("Nothing ran and no step was recorded");
  });

  it("records a file-panel stub's panel kind when the action is a reference", async () => {
    const panels = {
      ...registry,
      invokeTool: vi.fn(async () => ({ panelKind: "save" })),
    } as unknown as Registry;
    await write("scripts/seed.mjs", "output.action = 'stub';");
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    await flowAddScriptTool.execute(
      {},
      { name: "rec", project_root: root, path: "../../scripts/seed.mjs" }
    );
    await createFlowAddStepTool(panels).execute(
      {},
      {
        name: "rec",
        project_root: root,
        command: "file-panel",
        args: '{"action":"{{output:action}}","paths":["/tmp/new.txt"]}',
      }
    );

    const recorded = parseFlow(await fs.readFile(path.join(root, ".argent/e2e/rec.yaml"), "utf8"));
    expect(recorded.steps[1]).toMatchObject({
      args: { action: "{{output:action}}", panelKind: "save" },
    });
  });

  it("records a file-panel stub's panel kind with a reference too", async () => {
    const panels = {
      ...registry,
      invokeTool: vi.fn(async () => ({ panelKind: "save" })),
    } as unknown as Registry;
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    await createFlowAddStepTool(panels).execute(
      {},
      {
        name: "rec",
        project_root: root,
        command: "file-panel",
        args: '{"action":"stub","paths":["{{output:file ?? /tmp/new.txt}}"]}',
      }
    );

    const recorded = parseFlow(await fs.readFile(path.join(root, ".argent/e2e/rec.yaml"), "utf8"));
    expect(recorded.steps[0]).toMatchObject({
      args: { action: "stub", paths: ["{{output:file ?? /tmp/new.txt}}"], panelKind: "save" },
    });
  });
});
