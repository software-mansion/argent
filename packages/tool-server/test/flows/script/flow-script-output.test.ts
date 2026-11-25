import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { __resetRecordingsForTesting, parseFlow } from "../../../src/tools/flows/flow-utils";

/**
 * `{{output:...}}` references through a real run: what a script leaves in
 * `output` reaches the steps after it, as a tool argument, an env value, text
 * and a check.
 */

vi.setConfig({ testTimeout: 30_000 });

let root: string;

const invokeTool = vi.fn(async (id: string) =>
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
  return (invokeTool.mock.calls as unknown as [string, unknown][])
    .filter(([called]) => called === id)
    .map(([, args]) => args);
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

  it("errors a selector that resolves to nothing rather than matching everything", async () => {
    const seed = await script("seed", 'output.row = "";');
    const result = await run("empty", [seed, `tap: { text: "{{output:row}}" }`]);

    expect(result.steps[1]).toMatchObject({ status: "error" });
    expect(result.steps[1]!.reason).toContain("resolved to an empty value");
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
      "assert: { output: user.count, equals: 3 }",
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
});
