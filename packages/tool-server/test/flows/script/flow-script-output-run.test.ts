import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import {
  createRunFlowTool,
  type FlowRunResult,
  type StepReport,
} from "../../../src/tools/flows/flow-run";
import * as scriptStep from "../../../src/tools/flows/flow-script-step";
import { InvalidToolInputError } from "../../../src/utils/capability";
import { resolveHostBash } from "../../helpers/host-bash";
import { scopeTempHome } from "../../helpers/temp-home";

// A pass-through spy: the runner merges through the real function, and a test
// can ask which documents reached the merge. A failed script stops the run, so
// nothing after it can read the document; the merge calls are the one place
// its exclusion is observable from outside the runner.
vi.mock("../../../src/tools/flows/flow-script-step", async (importOriginal) => {
  const actual = await importOriginal<typeof scriptStep>();
  return { ...actual, mergeScriptOutput: vi.fn(actual.mergeScriptOutput) };
});

vi.setConfig({ testTimeout: 60_000 });

scopeTempHome("argent-flow-output-run-home-");

const mergeSpy = vi.mocked(scriptStep.mergeScriptOutput);

let root: string;

const DEVICE = "00000000-0000-0000-0000-0000000000ac";

type InvokeHook = (id: string, params: unknown) => unknown;

function mockRegistry(opts: { booted?: boolean; invoke?: InvokeHook } = {}) {
  const invokeTool = vi.fn(async (id: string, params?: unknown) => {
    if (id === "list-devices") {
      return {
        devices: opts.booted ? [{ platform: "ios", udid: DEVICE, state: "Booted" }] : [],
      };
    }
    return opts.invoke ? opts.invoke(id, params) : { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn(() => ({
      inputSchema: { properties: { udid: {}, name: {}, project_root: {}, env: {} } },
    })),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
  return { registry, invokeTool };
}

type InvokeMock = ReturnType<typeof mockRegistry>["invokeTool"];

async function write(relative: string, contents: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}

function flow(name: string, ...lines: string[]): Promise<string> {
  return write(path.join(".argent", "flows", `${name}.yaml`), `${lines.join("\n")}\n`);
}

/** A script under `<root>/scripts`, as a flow in `.argent/flows` spells its path. */
function script(name: string): string {
  return `../../scripts/${name}`;
}

function markPath(mark: string): string {
  return path.join(root, `${mark}.mark`);
}

function shellMarkPath(mark: string): string {
  return markPath(mark).replace(/\\/g, "/");
}

function readMark(mark: string): string | undefined {
  try {
    return fsSync.readFileSync(markPath(mark), "utf8");
  } catch {
    return undefined;
  }
}

function reporter(mark: string, names: readonly string[]): string {
  return (
    `import fs from "node:fs";\n` +
    `const seen = {};\n` +
    `for (const name of ${JSON.stringify(names)}) seen[name] = process.env[name] ?? null;\n` +
    `fs.writeFileSync(${JSON.stringify(markPath(mark))}, JSON.stringify(seen));`
  );
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

function startRun(
  name: string,
  opts: { booted?: boolean; invoke?: InvokeHook } = {}
): { run: Promise<FlowRunResult>; invokeTool: InvokeMock } {
  const { registry, invokeTool } = mockRegistry(opts);
  const run = createRunFlowTool(registry)
    .execute({}, { project_root: root, name } as never)
    .then(asRun);
  return { run, invokeTool };
}

async function runFlow(
  name: string,
  opts: { booted?: boolean; invoke?: InvokeHook } = {}
): Promise<{ result: FlowRunResult; invokeTool: InvokeMock }> {
  const { run, invokeTool } = startRun(name, opts);
  return { result: await run, invokeTool };
}

function argsSentTo(invokeTool: InvokeMock, tool: string): Array<Record<string, unknown>> {
  return invokeTool.mock.calls
    .filter((call) => call[0] === tool)
    .map((call) => call[1] as Record<string, unknown>);
}

function toolsCalled(invokeTool: InvokeMock): string[] {
  return invokeTool.mock.calls.map((call) => call[0]);
}

function echoes(result: FlowRunResult): StepReport[] {
  return result.steps.filter((step) => step.kind === "echo");
}

let noBash: string | undefined;

beforeAll(async () => {
  const found = await resolveHostBash();
  if (!("path" in found)) noBash = found.problem;
});

function skipWithoutBash(ctx: { skip: (note?: string) => void }): void {
  if (noBash) ctx.skip(`this host has no bash to run a .sh step with: ${noBash}`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-output-run-"));
  await fs.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
  mergeSpy.mockClear();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("the run's output document: lifecycle and merge", () => {
  it("starts a root run with an empty document, so a fallback gives the value", async () => {
    await flow("empty", "steps:", `  - echo: "{{output:x ?? 'empty'}}"`);

    const { result } = await runFlow("empty");

    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: "echo", status: "pass", message: "empty" });
  });

  it("merges what a .mjs writes to output.user, and an echo prints it resolved", async () => {
    await write("scripts/create-user.mjs", `output.user = { id: "u_1" };\n`);
    await flow(
      "create-user",
      "steps:",
      `  - script: { path: ${script("create-user.mjs")} }`,
      `  - echo: "Created user {{output:user.id}}"`
    );

    const { result } = await runFlow("create-user");

    expect(result.ok).toBe(true);
    expect(result.steps[1]).toMatchObject({
      kind: "echo",
      status: "pass",
      message: "Created user u_1",
    });
  });

  it("merges the .mjs replace form (output = { user, orderId }) instead of replacing the document", async () => {
    await write("scripts/seed.mjs", `output.seed = "kept";\n`);
    await write(
      "scripts/replace.mjs",
      `const user = { id: "u_1" };\nconst orderId = 42;\noutput = { user, orderId };\n`
    );
    await flow(
      "replace",
      "steps:",
      `  - script: { path: ${script("seed.mjs")} }`,
      `  - script: { path: ${script("replace.mjs")} }`,
      `  - echo: "user {{output:user.id}} order {{output:orderId}} seed {{output:seed}}"`
    );

    const { result } = await runFlow("replace");

    expect(result.ok).toBe(true);
    expect(result.steps[2].message).toBe("user u_1 order 42 seed kept");
  });

  it("keeps a .mjs key when a later .sh writes a full document holding only its own key", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/user.mjs", `output.user = { id: "u_1" };\n`);
    await write("scripts/order.sh", `printf '{"order":{"id":"o_1"}}' > "$ARGENT_OUTPUT"\n`);
    await flow(
      "mjs-then-sh",
      "steps:",
      `  - script: { path: ${script("user.mjs")} }`,
      `  - script: { path: ${script("order.sh")} }`,
      `  - echo: "user {{output:user.id}} order {{output:order.id}}"`
    );

    const { result } = await runFlow("mjs-then-sh");

    expect(result.ok).toBe(true);
    expect(result.steps[2].message).toBe("user u_1 order o_1");
  });

  it("keeps a .sh key when a later .mjs replaces its whole document with only its own key", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/order.sh", `printf '{"order":{"id":"o_1"}}' > "$ARGENT_OUTPUT"\n`);
    await write("scripts/user.mjs", `output = { user: { id: "u_1" } };\n`);
    await flow(
      "sh-then-mjs",
      "steps:",
      `  - script: { path: ${script("order.sh")} }`,
      `  - script: { path: ${script("user.mjs")} }`,
      `  - echo: "user {{output:user.id}} order {{output:order.id}}"`
    );

    const { result } = await runFlow("sh-then-mjs");

    expect(result.ok).toBe(true);
    expect(result.steps[2].message).toBe("user u_1 order o_1");
  });

  it("hands the current document to a .sh in $ARGENT_OUTPUT and to a .mjs as the output global", async (ctx) => {
    skipWithoutBash(ctx);
    await write(
      "scripts/first.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(markPath("first-saw"))}, JSON.stringify(output));\n` +
        `output.user = { id: "u_1" };\n`
    );
    await write("scripts/copy.sh", `cp "$ARGENT_OUTPUT" "${shellMarkPath("sh-saw")}"\n`);
    await write(
      "scripts/read.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(markPath("mjs-saw"))}, JSON.stringify(output));\n`
    );
    await flow(
      "handed",
      "steps:",
      `  - script: { path: ${script("first.mjs")} }`,
      `  - script: { path: ${script("copy.sh")} }`,
      `  - script: { path: ${script("read.mjs")} }`
    );

    const { result } = await runFlow("handed");

    expect(result.ok).toBe(true);
    expect(JSON.parse(readMark("first-saw") ?? "null")).toEqual({});
    expect(JSON.parse(readMark("sh-saw") ?? "null")).toEqual({ user: { id: "u_1" } });
    expect(JSON.parse(readMark("mjs-saw") ?? "null")).toEqual({ user: { id: "u_1" } });
  });

  it("replaces a written top-level key whole, keeps an unwritten one, and clears a key set to null", async () => {
    await write(
      "scripts/step1.mjs",
      `output.user = { id: "u_1", name: "Ada" };\noutput.keep = "kept";\noutput.clear = "soon";\n`
    );
    // The replace form, so the returned documents hold only the keys named:
    // a mutated `output` would hand back every key it was given.
    await write("scripts/step2.mjs", `output = { user: { id: "u_2" } };\n`);
    await write("scripts/step3.mjs", `output = { clear: null };\n`);
    await flow(
      "merge-rule",
      "steps:",
      `  - script: { path: ${script("step1.mjs")} }`,
      `  - script: { path: ${script("step2.mjs")} }`,
      `  - script: { path: ${script("step3.mjs")} }`,
      `  - echo: "{{output:user.name ?? 'gone'}}"`,
      `  - echo: "{{output:user.id}}"`,
      `  - echo: "{{output:keep}}"`,
      `  - echo: "{{output:clear ?? 'cleared'}}"`
    );

    const { result } = await runFlow("merge-rule");

    expect(result.ok).toBe(true);
    expect(echoes(result).map((step) => step.message)).toEqual(["gone", "u_2", "kept", "cleared"]);
  });

  it("merges the pure rule { ...current, ...returned } and refuses a merged document over 1 MiB", () => {
    // `vi.mocked` wraps the real function, so this is the real rule.
    expect(
      scriptStep.mergeScriptOutput(
        { a: 1, user: { id: "u_1", name: "Ada" } },
        { user: { id: "u_2" }, c: null }
      )
    ).toEqual({ output: { a: 1, user: { id: "u_2" }, c: null } });
    const merged = scriptStep.mergeScriptOutput(
      { a: "x".repeat(600 * 1024) },
      { b: "y".repeat(600 * 1024) }
    );
    // The spec spells the limit `1 MiB`; the shared `describeBytes` formatter
    // prints `1.0 MiB`, as the per-script limit message has since PR 1.
    expect("problem" in merged && merged.problem).toMatch(
      /^After this step the flow output is 1\.2 MiB encoded; the limit is 1\.0 MiB\. A script cannot remove a key, so set one the flow no longer reads to null\.$/
    );
  });

  // Not observable end to end: the run stops at the failed script, so no later
  // step reads the document. The merge spy shows the failed script's document
  // never reached the merge.
  it("merges nothing from a .mjs that writes output and then throws", async () => {
    await write("scripts/a.mjs", `output.a = 1;\n`);
    await write("scripts/b.mjs", `output.b = 2;\nthrow new Error("b failed after writing");\n`);
    await flow(
      "throws-after-writing",
      "steps:",
      `  - script: { path: ${script("a.mjs")} }`,
      `  - script: { path: ${script("b.mjs")} }`,
      `  - echo: "{{output:b ?? 'none'}}"`
    );

    const { result } = await runFlow("throws-after-writing");

    expect(result.steps.map((step) => step.status)).toEqual(["pass", "fail", "skip"]);
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy.mock.calls[0]).toEqual([{}, { a: 1 }]);
  });

  it("merges nothing from a .sh that writes $ARGENT_OUTPUT and then exits 1", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/a.mjs", `output.a = 1;\n`);
    await write("scripts/b.sh", `printf '{"a":1,"b":2}' > "$ARGENT_OUTPUT"\nexit 1\n`);
    await flow(
      "exits-after-writing",
      "steps:",
      `  - script: { path: ${script("a.mjs")} }`,
      `  - script: { path: ${script("b.sh")} }`,
      `  - echo: "{{output:b ?? 'none'}}"`
    );

    const { result } = await runFlow("exits-after-writing");

    expect(result.steps.map((step) => step.status)).toEqual(["pass", "fail", "skip"]);
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy.mock.calls[0]).toEqual([{}, { a: 1 }]);
  });

  it("shares the root document with a run: fragment, both ways", async () => {
    await write("scripts/user.mjs", `output.user = { id: "u_1" };\n`);
    await write("scripts/token.mjs", `output.token = "t_1";\n`);
    await flow(
      "outer",
      "steps:",
      `  - script: { path: ${script("user.mjs")} }`,
      "  - run: inner.yaml",
      `  - echo: "token {{output:token}}"`
    );
    await flow(
      "inner",
      "steps:",
      `  - echo: "fragment sees {{output:user.id}}"`,
      `  - script: { path: ${script("token.mjs")} }`
    );

    const { result } = await runFlow("outer", { booted: true });

    expect(result.ok).toBe(true);
    expect(echoes(result).map((step) => step.message)).toEqual(["fragment sees u_1", "token t_1"]);
  });

  it("keeps what a script inside a when: { platform: ios } block merged after the block ends", async () => {
    await write("scripts/flag.mjs", `output.flag = "set";\n`);
    await flow(
      "when-merge",
      "steps:",
      "  - when: { platform: ios }",
      "    steps:",
      `      - script: { path: ${script("flag.mjs")} }`,
      `  - echo: "flag {{output:flag}}"`
    );

    const { result } = await runFlow("when-merge", { booted: true });

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => [step.kind, step.status])).toEqual([
      ["when", "pass"],
      ["script", "pass"],
      ["echo", "pass"],
    ]);
    expect(result.steps[2].message).toBe("flag set");
  });

  it("gives two runs executing at the same time documents that do not see each other's keys", async () => {
    // Each run's second script waits for the other run's second script to
    // start, which happens only after the other run's first script merged. So
    // both merges have landed before either echo resolves.
    const waitFor = (self: string, other: string): string =>
      `import fs from "node:fs";\n` +
      `fs.writeFileSync(${JSON.stringify(markPath(self))}, "started");\n` +
      `const deadline = Date.now() + 30_000;\n` +
      `while (!fs.existsSync(${JSON.stringify(markPath(other))})) {\n` +
      `  if (Date.now() > deadline) throw new Error("the other run never reached its second script");\n` +
      `  await new Promise((resolve) => setTimeout(resolve, 20));\n` +
      `}\n`;
    await write("scripts/left-set.mjs", `output.left = "L";\n`);
    await write("scripts/right-set.mjs", `output.right = "R";\n`);
    await write("scripts/left-wait.mjs", waitFor("left-wait", "right-wait"));
    await write("scripts/right-wait.mjs", waitFor("right-wait", "left-wait"));
    for (const [self, other] of [
      ["left", "right"],
      ["right", "left"],
    ] as const) {
      await flow(
        self,
        "steps:",
        `  - script: { path: ${script(`${self}-set.mjs`)} }`,
        `  - script: { path: ${script(`${self}-wait.mjs`)} }`,
        `  - echo: "${self} {{output:${self}}} ${other} {{output:${other} ?? 'unseen'}}"`
      );
    }

    const [left, right] = await Promise.all([runFlow("left"), runFlow("right")]);

    expect(left.result.ok).toBe(true);
    expect(right.result.ok).toBe(true);
    expect(left.result.steps[2].message).toBe("left L right unseen");
    expect(right.result.steps[2].message).toBe("right R left unseen");
  });

  it("resolves a nested tool: flow-execute step's args.env in the parent, and reports the reference", async () => {
    await write("scripts/user.mjs", `output.user = { id: "u_1" };\n`);
    await flow(
      "parent",
      "steps:",
      `  - script: { path: ${script("user.mjs")} }`,
      "  - tool: flow-execute",
      "    args:",
      "      name: child",
      `      project_root: ${JSON.stringify(root)}`,
      `      env: { USER_ID: "{{output:user.id}}" }`
    );

    const { result, invokeTool } = await runFlow("parent", { booted: true });

    expect(result.ok).toBe(true);
    const sent = argsSentTo(invokeTool, "flow-execute");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ name: "child", project_root: root, env: { USER_ID: "u_1" } });
    const report = result.steps[1];
    expect(report).toMatchObject({ kind: "tool", tool: "flow-execute", status: "pass" });
    expect(report.args).toMatchObject({ env: { USER_ID: "{{output:user.id}}" } });
  });

  it("fails the step whose merge takes the document over 1 MiB, and skips what follows", async () => {
    await write("scripts/big-a.mjs", `output.a = "x".repeat(600 * 1024);\n`);
    // The replace form: this script's own document holds only `b`, so it
    // passes the child's per-document limit and only the merge exceeds it.
    await write("scripts/big-b.mjs", `output = { b: "y".repeat(600 * 1024) };\n`);
    await flow(
      "too-big",
      "steps:",
      `  - script: { path: ${script("big-a.mjs")} }`,
      `  - script: { path: ${script("big-b.mjs")} }`,
      "  - echo: after"
    );

    const { result } = await runFlow("too-big");

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("pass");
    expect(result.steps[1].status).toBe("fail");
    expect(result.steps[1].reason).toMatch(/^After this step the flow output is /);
    // The spec spells this `1 MiB`; the shared formatter prints `1.0 MiB`.
    expect(result.steps[1].reason).toContain("the limit is 1.0 MiB");
    expect(result.steps[2]).toMatchObject({ kind: "echo", status: "skip", message: "after" });
  });

  it("drops the large-integer warning of a step whose merge goes over 1 MiB, and keeps it when the merge fits", async () => {
    await write("scripts/big-a.mjs", `output.a = "x".repeat(600 * 1024);\n`);
    // The literal is rounded when the .mjs parses it, and the rounded value is
    // still past 2^53, so the warning fires as it does for a .sh's JSON text.
    await write(
      "scripts/big-id.mjs",
      `output = { b: "y".repeat(600 * 1024), id: 12345678901234567891 };\n`
    );
    await flow(
      "too-big-warned",
      "steps:",
      `  - script: { path: ${script("big-a.mjs")} }`,
      `  - script: { path: ${script("big-id.mjs")} }`
    );
    await flow("fits-warned", "steps:", `  - script: { path: ${script("big-id.mjs")} }`);
    const warning =
      "output.id is 12345678901234567000, past the largest integer a JSON number holds exactly " +
      "(9007199254740991), so it may have been rounded; write an identifier as a string.";

    const tooBig = (await runFlow("too-big-warned")).result;

    expect(tooBig.steps[1].status).toBe("fail");
    expect(tooBig.steps[1].reason).toMatch(/^After this step the flow output is /);
    expect(tooBig.steps[1].warning).toBeUndefined();

    const fits = (await runFlow("fits-warned")).result;

    expect(fits.ok).toBe(true);
    expect(fits.steps[0].status).toBe("pass");
    expect(fits.steps[0].warning).toBe(warning);
  });
});

describe("output references in steps", () => {
  it("prints an echo's object reference as one-line JSON, ?? null as null, and cuts a long message", async () => {
    await write(
      "scripts/doc.mjs",
      `output.user = { id: "u_1", name: "Ada" };\noutput.long = "z".repeat(70000);\n`
    );
    await flow(
      "echo-values",
      "steps:",
      `  - script: { path: ${script("doc.mjs")} }`,
      `  - echo: "{{output:user}}"`,
      `  - echo: "user is {{output:user}}"`,
      `  - echo: "{{output:missing ?? null}}"`,
      `  - echo: "{{output:long}}"`
    );

    const { result } = await runFlow("echo-values");

    expect(result.ok).toBe(true);
    const [whole, embedded, fallback, long] = echoes(result);
    expect(whole.message).toBe('{"id":"u_1","name":"Ada"}');
    expect(embedded.message).toBe('user is {"id":"u_1","name":"Ada"}');
    expect(fallback.message).toBe("null");
    expect(long.message).toBe(`${"z".repeat(65536)}…(+4464 chars)`);
  });

  it("errors an echo whose path is missing, keeping its authored message, and stops the run", async () => {
    await write("scripts/user.mjs", `output.user = { id: "u_1", name: "Ada" };\n`);
    await write(
      "scripts/later.mjs",
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(markPath("later"))}, "ran");\n`
    );
    await flow(
      "missing-promo",
      "steps:",
      `  - script: { path: ${script("user.mjs")} }`,
      `  - echo: "Promo {{output:user.promo}}"`,
      "  - echo: after",
      `  - script: { path: ${script("later.mjs")} }`
    );

    const { result } = await runFlow("missing-promo");

    expect(result.steps[1]).toMatchObject({
      kind: "echo",
      status: "error",
      message: "Promo {{output:user.promo}}",
      reason:
        "`echo`: {{output:user.promo}} did not resolve: `output.user` has no `promo` (its keys: id, name)",
    });
    expect(result.steps.slice(2).map((step) => step.status)).toEqual(["skip", "skip"]);
    expect(readMark("later")).toBeUndefined();
    expect(result).toMatchObject({ ok: false, passed: 1, errored: 1, skipped: 1, failed: 0 });
  });

  it("invokes a tool step with resolved args, keeping each whole-field JSON type, and reports the authored args", async () => {
    await write("scripts/codes.mjs", `output.code = "123456";\noutput.n = 42;\n`);
    await flow(
      "tool-args",
      "steps:",
      `  - script: { path: ${script("codes.mjs")} }`,
      "  - tool: keyboard",
      `    args: { text: "{{output:code}}" }`,
      "  - tool: keyboard",
      `    args: { text: "{{output:n}}" }`,
      "  - tool: keyboard",
      `    args: { text: "{{output:missing ?? null}}" }`,
      "  - tool: keyboard",
      `    args: { text: "id-{{output:n}}" }`
    );

    const { result, invokeTool } = await runFlow("tool-args", { booted: true });

    expect(result.ok).toBe(true);
    expect(argsSentTo(invokeTool, "keyboard").map((args) => args.text)).toEqual([
      "123456",
      42,
      null,
      "id-42",
    ]);
    expect(
      result.steps
        .filter((step) => step.kind === "tool")
        .map((step) => (step.args as { text: unknown }).text)
    ).toEqual(["{{output:code}}", "{{output:n}}", "{{output:missing ?? null}}", "id-{{output:n}}"]);
  });

  it("errors a tool step whose reference does not resolve without invoking the tool", async () => {
    await flow(
      "tool-missing",
      "steps:",
      "  - tool: keyboard",
      `    args: { text: "{{output:code}}" }`
    );

    const { result, invokeTool } = await runFlow("tool-missing", { booted: true });

    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      tool: "keyboard",
      status: "error",
      reason:
        "`args.text`: {{output:code}} did not resolve: `output` has no `code` (it has no keys)",
    });
    expect(toolsCalled(invokeTool).filter((id) => id !== "list-devices")).toEqual([]);
  });

  it("names the whole-field reference and its type when a tool rejects the typed value", async () => {
    await write("scripts/code.mjs", `output.code = 123456;\n`);
    await flow(
      "typed-reject",
      "steps:",
      `  - script: { path: ${script("code.mjs")} }`,
      "  - tool: keyboard",
      `    args: { text: "{{output:code}}" }`
    );

    const { result } = await runFlow("typed-reject", {
      booted: true,
      invoke: (id, params) => {
        if (id === "keyboard" && typeof (params as { text?: unknown }).text !== "string") {
          throw new InvalidToolInputError("keyboard needs `text` to be a string");
        }
        return { ok: true };
      },
    });

    const report = result.steps[1];
    expect(report.status).toBe("error");
    expect(report.reason).toContain("keyboard needs `text` to be a string");
    expect(report.reason).toContain(
      '`args.text` is "{{output:code}}" alone, so it received a number'
    );
    expect(report.reason).toContain("enter it with a `type:` step");
  });

  it("names the whole-field reference and its type when a run-sequence step fails, and not for a string value", async () => {
    await write("scripts/number.mjs", `output.code = 123456;\n`);
    await write("scripts/string.mjs", `output.code = "123456";\n`);
    for (const value of ["number", "string"]) {
      await flow(
        `sequence-${value}`,
        "steps:",
        `  - script: { path: ${script(`${value}.mjs`)} }`,
        "  - tool: run-sequence",
        "    args:",
        "      steps:",
        "        - tool: keyboard",
        `          args: { text: "{{output:code}}" }`
      );
    }
    // run-sequence reports an inner tool's refusal in its result, never by
    // throwing, so the refusal's failure code never reaches the runner.
    const refusesInside: InvokeHook = (id) =>
      id === "run-sequence"
        ? {
            completed: 0,
            total: 1,
            steps: [{ tool: "keyboard", error: "keyboard needs `text` to be a string" }],
          }
        : { ok: true };
    const innerText = (invokeTool: InvokeMock): unknown[] =>
      argsSentTo(invokeTool, "run-sequence").map(
        (args) => (args.steps as Array<{ args: { text: unknown } }>)[0]!.args.text
      );

    const asNumber = await runFlow("sequence-number", { booted: true, invoke: refusesInside });

    expect(innerText(asNumber.invokeTool)).toEqual([123456]);
    const report = asNumber.result.steps[1];
    expect(report).toMatchObject({ kind: "tool", tool: "run-sequence", status: "fail" });
    expect(report.reason).toMatch(
      /^run-sequence stopped at keyboard after 0 of 1 steps: keyboard needs `text` to be a string/
    );
    expect(report.reason).toContain(
      '`args.steps[0].args.text` is "{{output:code}}" alone, so it received a number'
    );
    expect(report.reason).toContain("If a tool refused that type");

    const asString = await runFlow("sequence-string", { booted: true, invoke: refusesInside });

    expect(innerText(asString.invokeTool)).toEqual(["123456"]);
    expect(asString.result.steps[1]).toMatchObject({ tool: "run-sequence", status: "fail" });
    expect(asString.result.steps[1].reason).not.toContain("alone, so it received");
    expect(asString.result.steps[1].reason).not.toContain("If a tool refused that type");
  });

  it("appends the value a failing .mjs script step's env reference resolved to", async () => {
    await write("scripts/token.mjs", `output.token = "abc";\n`);
    await write("scripts/reject.mjs", `throw new Error("token rejected");\n`);
    await flow(
      "script-fails",
      "steps:",
      `  - script: { path: ${script("token.mjs")} }`,
      `  - script: { path: ${script("reject.mjs")}, env: { TOKEN: "{{output:token}}" } }`
    );

    const { result } = await runFlow("script-fails");

    expect(result.steps[1].status).toBe("fail");
    expect(result.steps[1].reason).toContain("token rejected");
    expect(result.steps[1].reason?.endsWith(' (output.token = "abc")')).toBe(true);
  });

  it("appends each distinct resolved value to a tool step the tool makes throw", async () => {
    await write("scripts/code.mjs", `output.code = "123456";\n`);
    await flow(
      "tool-throws",
      "steps:",
      `  - script: { path: ${script("code.mjs")} }`,
      "  - tool: keyboard",
      `    args: { text: "{{output:code}}-{{output:code}}", note: "{{output:user.name ?? 'x'}}" }`
    );

    const { result } = await runFlow("tool-throws", {
      booted: true,
      invoke: (id) => {
        if (id === "keyboard") throw new Error("device went away");
        return { ok: true };
      },
    });

    expect(result.steps[1]).toMatchObject({
      status: "error",
      reason: `device went away (output.code = "123456") (output.user.name ?? 'x' = "x")`,
    });
  });

  it("errors an assert whose ?? '' leaves no visible text, without reading the screen", async () => {
    await flow("empty-assert", "steps:", `  - assert: { visible: "{{output:missing ?? ''}}" }`);

    const { result, invokeTool } = await runFlow("empty-assert", { booted: true });

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain("`assert.visible.text`");
    expect(result.steps[0].reason).toContain("visible character");
    expect(toolsCalled(invokeTool).filter((id) => id !== "list-devices")).toEqual([]);
  });

  it("passes an echo whose ?? '' sits between other text", async () => {
    await flow("empty-between", "steps:", `  - echo: "x{{output:missing ?? ''}}y"`);

    const { result } = await runFlow("empty-between");

    expect(result.ok).toBe(true);
    expect(result.steps[0]).toMatchObject({ status: "pass", message: "xy" });
  });

  it("errors a when guard whose reference does not resolve, skips its block and the rest, and summarizes", async () => {
    await flow(
      "guard",
      "steps:",
      `  - when: { visible: { id: "{{output:row}}" } }`,
      "    steps:",
      "      - echo: inside",
      "      - tap: Row",
      "  - echo: after",
      "  - tap: Done"
    );

    const { result, invokeTool } = await runFlow("guard", { booted: true });

    expect(result.steps[0].kind).toBe("when");
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/^could not resolve when guard \(/);
    expect(result.steps[0].reason).toContain(
      "`when.visible.id`: {{output:row}} did not resolve: `output` has no `row` (it has no keys)"
    );
    expect(result.steps.slice(1, 3).map((step) => [step.status, step.reason])).toEqual([
      ["skip", "when guard errored"],
      ["skip", "when guard errored"],
    ]);
    expect(result.steps.slice(3).map((step) => step.status)).toEqual(["skip", "skip"]);
    expect(result).toMatchObject({ ok: false, errored: 1 });
    expect(toolsCalled(invokeTool).filter((id) => id !== "list-devices")).toEqual([]);
  });

  it("sets a script env value from a reference to what an earlier script wrote", async () => {
    await write("scripts/login.mjs", `output.auth = { token: "tok_1" };\n`);
    await write("scripts/probe.mjs", reporter("probe", ["TOKEN"]));
    await flow(
      "env-ref",
      "steps:",
      `  - script: { path: ${script("login.mjs")} }`,
      `  - script: { path: ${script("probe.mjs")}, env: { TOKEN: "{{output:auth.token}}" } }`
    );

    const { result } = await runFlow("env-ref");

    expect(result.ok).toBe(true);
    expect(JSON.parse(readMark("probe") ?? "{}")).toEqual({ TOKEN: "tok_1" });
  });

  it("resolves a {{secret:NAME}} written next to a reference in one env value", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write("scripts/user.mjs", `output.user = { id: "u_1" };\n`);
    await write("scripts/probe.mjs", reporter("probe", ["AUTH"]));
    await flow(
      "env-secret",
      "steps:",
      `  - script: { path: ${script("user.mjs")} }`,
      `  - script: { path: ${script("probe.mjs")}, env: { AUTH: "Bearer {{secret:API_KEY}} for {{output:user.id}}" } }`
    );

    const { result } = await runFlow("env-secret");

    expect(result.ok).toBe(true);
    expect(JSON.parse(readMark("probe") ?? "{}")).toEqual({
      AUTH: "Bearer sk-live-9d3f0a1b for u_1",
    });
  });

  it("errors a script step whose env reference would spell a secret placeholder, without running it", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write(
      "scripts/half.mjs",
      `output.half = "{{secret:API_KEY}}";\noutput.first = "{{secre";\noutput.last = "t:API_KEY}}";\n`
    );
    await write("scripts/probe.mjs", reporter("probe", ["X"]));
    await flow(
      "whole-placeholder",
      "steps:",
      `  - script: { path: ${script("half.mjs")} }`,
      `  - script: { path: ${script("probe.mjs")}, env: { X: "{{output:half}}" } }`
    );
    await flow(
      "split-placeholder",
      "steps:",
      `  - script: { path: ${script("half.mjs")} }`,
      `  - script: { path: ${script("probe.mjs")}, env: { X: "{{output:first}}{{output:last}}" } }`
    );

    for (const name of ["whole-placeholder", "split-placeholder"]) {
      const { result } = await runFlow(name);

      expect(result.steps[1].status).toBe("error");
      expect(result.steps[1].reason).toMatch(/^`script\.env\.X`: /);
      expect(result.steps[1].reason).toContain(
        "would spell the secret placeholder {{secret:API_KEY}}"
      );
      expect(readMark("probe")).toBeUndefined();
    }
  });

  it("passes a .sh that writes an integer past 2^53, with a warning naming the path", async (ctx) => {
    skipWithoutBash(ctx);
    await write(
      "scripts/order.sh",
      `printf '{"order":{"id":12345678901234567891}}' > "$ARGENT_OUTPUT"\n`
    );
    await flow("big-int", "steps:", `  - script: { path: ${script("order.sh")} }`);

    const { result } = await runFlow("big-int");

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(result.steps[0].warning).toBe(
      "output.order.id is 12345678901234567000, past the largest integer a JSON number holds " +
        "exactly (9007199254740991), so it may have been rounded; write an identifier as a string."
    );
  });

  it("passes a .sh document 4,096 levels deep with an integer past 2^53 at the deepest level, with a warning", async (ctx) => {
    skipWithoutBash(ctx);
    const nested = (levels: number): string =>
      `${'{"a":'.repeat(levels)}12345678901234567891${"}".repeat(levels)}`;
    await write("deep-4096.json", nested(4096));
    await write("deep-4097.json", nested(4097));
    const copier = (file: string): string =>
      `cat "${path.join(root, file).replace(/\\/g, "/")}" > "$ARGENT_OUTPUT"\n`;
    await write("scripts/deep-4096.sh", copier("deep-4096.json"));
    await write("scripts/deep-4097.sh", copier("deep-4097.json"));
    await flow("deep-4096", "steps:", `  - script: { path: ${script("deep-4096.sh")} }`);
    await flow("deep-4097", "steps:", `  - script: { path: ${script("deep-4097.sh")} }`);

    const { result } = await runFlow("deep-4096");

    expect(result.ok).toBe(true);
    expect(result.steps[0].status).toBe("pass");
    expect(result.steps[0].warning).toMatch(/^output\.a\.a\.a/);
    expect(result.steps[0].warning).toContain(
      "is 12345678901234567000, past the largest integer a JSON number holds exactly (9007199254740991)"
    );

    // One level more is refused, so the document above sits AT the limit.
    const over = (await runFlow("deep-4097")).result;
    expect(over.steps[0].status).toBe("fail");
    expect(over.steps[0].reason).toContain("nests deeper than 4096 levels");
  });

  it("refuses a root flow with a malformed reference before its first script runs, naming the echo", async () => {
    await write(
      "scripts/mark.mjs",
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(markPath("ran"))}, "ran");\n`
    );
    await flow(
      "malformed",
      "steps:",
      `  - script: { path: ${script("mark.mjs")} }`,
      `  - echo: "{{output:user.id || 'x'}}"`
    );

    const { run, invokeTool } = startRun("malformed");
    const error = await run.then(
      () => undefined,
      (err: unknown) => err
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Step 2 (`echo`): `echo` holds a malformed output reference: `||` is not supported; " +
        "`??` is the only operator (character 18, in \"{{output:user.id || 'x'}}\")"
    );
    expect(readMark("ran")).toBeUndefined();
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("stops at a run: step whose fragment holds a malformed reference, after an earlier script already ran", async () => {
    await write(
      "scripts/mark.mjs",
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(markPath("ran"))}, "ran");\n`
    );
    await flow(
      "outer-malformed",
      "steps:",
      `  - script: { path: ${script("mark.mjs")} }`,
      "  - run: bad.yaml",
      "  - echo: after"
    );
    await flow("bad", "steps:", `  - echo: "{{output:user.id || 'x'}}"`);

    const { result } = await runFlow("outer-malformed", { booted: true });

    expect(readMark("ran")).toBe("ran");
    expect(result.ok).toBe(false);
    expect(result.steps[1]).toMatchObject({ kind: "run", status: "error" });
    expect(result.steps[1].reason).toMatch(/^could not load fragment "bad\.yaml": /);
    expect(result.steps[1].reason).toContain(
      "Step 1 (`echo`): `echo` holds a malformed output reference"
    );
    expect(result.steps[2]).toMatchObject({ kind: "echo", status: "skip" });
  });

  it("counts an errored echo inside a run: fragment in the root summary", async () => {
    await flow("outer-echo", "steps:", "  - run: inner-echo.yaml", "  - echo: after");
    await flow("inner-echo", "steps:", `  - echo: "{{output:missing}}"`);

    const { result } = await runFlow("outer-echo", { booted: true });

    expect(result.steps[1]).toMatchObject({ kind: "echo", status: "error", depth: 1 });
    expect(result).toMatchObject({ ok: false, errored: 1, failed: 0 });
  });
});
