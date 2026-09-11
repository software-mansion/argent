import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../../src/tools/flows/flow-insert-echo";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { createFlowAddStepTool } from "../../../src/tools/flows/flow-add-step";
import { flowFinishRecordingTool } from "../../../src/tools/flows/flow-finish-recording";
import { parseFlow, serializeFlow } from "../../../src/tools/flows/flow-utils";
import { resolveHostBash } from "../../helpers/host-bash";
import { scopeTempHome } from "../../helpers/temp-home";

vi.setConfig({ testTimeout: 30_000 });

scopeTempHome("argent-flow-env-home-");

let root: string;

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

function mockRegistry(opts: { booted?: boolean } = {}) {
  const invokeTool = vi.fn(async (id: string, _params?: unknown) => {
    if (id === "list-devices") {
      return {
        devices: opts.booted ? [{ platform: "ios", udid: DEVICE, state: "Booted" }] : [],
      };
    }
    return { ok: true };
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

async function write(relative: string, contents: string): Promise<string> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
  return file;
}

function flow(name: string, yaml: string): Promise<string> {
  return write(path.join(".argent", "flows", `${name}.yaml`), yaml);
}

function markPath(mark: string): string {
  return path.join(root, `${mark}.mark`);
}

/**
 * The same path as a `.sh` redirection target. Forward slashes, because a
 * Windows path inside a bash double-quoted string is a run of backslash
 * escapes waiting to happen — and Git Bash resolves `C:/…` the same as `C:\…`.
 */
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

function seen(mark: string): Record<string, string | null> {
  return JSON.parse(readMark(mark) ?? "{}") as Record<string, string | null>;
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function runFlow(
  name: string,
  params: Record<string, unknown> = {},
  opts: { booted?: boolean } = {}
): Promise<{ result: FlowRunResult; invokeTool: ReturnType<typeof mockRegistry>["invokeTool"] }> {
  const { registry, invokeTool } = mockRegistry(opts);
  const result = asRun(
    await createRunFlowTool(registry).execute({}, { project_root: root, name, ...params } as never)
  );
  return { result, invokeTool };
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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-env-"));
  await fs.mkdir(path.join(root, ".argent", "flows"), { recursive: true });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("environment precedence", () => {
  it("layers flow, nested flow, run-time and step maps in that order", async () => {
    await write("scripts/probe.mjs", reporter("probe", ["ONLY_FLOW", "OVERRIDDEN", "FROM_STEP"]));
    await flow(
      "outer",
      "env:\n" +
        "  ONLY_FLOW: root-value\n" +
        "  OVERRIDDEN: from-root\n" +
        "  FROM_STEP: from-root\n" +
        "steps:\n" +
        "  - run: inner.yaml\n"
    );
    await flow(
      "inner",
      "env:\n" +
        "  OVERRIDDEN: from-nested\n" +
        "  FROM_STEP: from-nested\n" +
        "steps:\n" +
        "  - script:\n" +
        "      path: ../../scripts/probe.mjs\n" +
        "      env: { FROM_STEP: from-step }\n"
    );

    const { result } = await runFlow(
      "outer",
      { env: { OVERRIDDEN: "from-run" } },
      { booted: true }
    );

    expect(result.ok).toBe(true);
    expect(seen("probe")).toEqual({
      ONLY_FLOW: "root-value",
      OVERRIDDEN: "from-run",
      FROM_STEP: "from-step",
    });
  });

  it("layers three nesting levels and restores each parent on the way out", async () => {
    for (const mark of ["d0-before", "d1-before", "d2", "d1-after", "d0-after"]) {
      await write(`scripts/${mark}.mjs`, reporter(mark, ["LEVEL"]));
    }
    await flow(
      "d0",
      "env: { LEVEL: outer }\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/d0-before.mjs }\n" +
        "  - run: d1.yaml\n" +
        "  - script: { path: ../../scripts/d0-after.mjs }\n"
    );
    await flow(
      "d1",
      "env: { LEVEL: mid }\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/d1-before.mjs }\n" +
        "  - run: d2.yaml\n" +
        "  - script: { path: ../../scripts/d1-after.mjs }\n"
    );
    await flow("d2", "env: { LEVEL: inner }\nsteps:\n  - script: { path: ../../scripts/d2.mjs }\n");

    const { result } = await runFlow("d0", {}, { booted: true });

    expect(result.ok).toBe(true);
    expect(seen("d0-before")).toEqual({ LEVEL: "outer" });
    expect(seen("d1-before")).toEqual({ LEVEL: "mid" });
    expect(seen("d2")).toEqual({ LEVEL: "inner" });
    expect(seen("d1-after")).toEqual({ LEVEL: "mid" });
    expect(seen("d0-after")).toEqual({ LEVEL: "outer" });
  });

  it("gives a script inside a when: block the environment in force", async () => {
    await write("scripts/guarded.mjs", reporter("guarded", ["FROM_FLOW", "FROM_STEP"]));
    await flow(
      "guarded",
      "env: { FROM_FLOW: flow-value, FROM_STEP: flow-value }\n" +
        "steps:\n" +
        "  - when:\n" +
        "      platform: ios\n" +
        "    steps:\n" +
        "      - script:\n" +
        "          path: ../../scripts/guarded.mjs\n" +
        "          env: { FROM_STEP: step-value }\n"
    );

    const { result } = await runFlow("guarded", {}, { booted: true });

    expect(result.ok).toBe(true);
    expect(seen("guarded")).toEqual({ FROM_FLOW: "flow-value", FROM_STEP: "step-value" });
  });

  it("lets a fragment's own env beat the parent's default for a recorded step", async () => {
    await write("scripts/frag.mjs", reporter("fragment", ["SHARED", "ONLY_PARENT"]));
    await flow(
      "parent",
      "env: { SHARED: parent-value, ONLY_PARENT: parent-only }\n" +
        "steps:\n" +
        "  - run: fragment.yaml\n"
    );
    await flow(
      "fragment",
      "env: { SHARED: fragment-value }\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/frag.mjs }\n"
    );

    const { result } = await runFlow("parent", {}, { booted: true });

    expect(result.ok).toBe(true);
    expect(seen("fragment")).toEqual({
      SHARED: "fragment-value",
      ONLY_PARENT: "parent-only",
    });
  });

  it("restores the parent's values after a nested flow that overrode them", async () => {
    await write("scripts/probe.mjs", reporter("before", ["PROBE"]));
    await write("scripts/after.mjs", reporter("after", ["PROBE"]));
    await write("scripts/nested.mjs", reporter("nested", ["PROBE"]));
    await flow(
      "outer",
      "env: { PROBE: parent }\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/probe.mjs }\n" +
        "  - run: inner.yaml\n" +
        "  - script: { path: ../../scripts/after.mjs }\n"
    );
    await flow(
      "inner",
      "env: { PROBE: child }\nsteps:\n  - script: { path: ../../scripts/nested.mjs }\n"
    );

    const { result } = await runFlow("outer", {}, { booted: true });

    expect(result.ok).toBe(true);
    expect(seen("before")).toEqual({ PROBE: "parent" });
    expect(seen("nested")).toEqual({ PROBE: "child" });
    expect(seen("after")).toEqual({ PROBE: "parent" });
  });

  it("gives a nested `tool: flow-execute` only its own args.env", async () => {
    await flow(
      "outer",
      "env: { PROBE: parent }\n" +
        "steps:\n" +
        "  - tool: flow-execute\n" +
        "    args: { name: child, project_root: /elsewhere, env: { OWN: mine } }\n"
    );

    const { result, invokeTool } = await runFlow(
      "outer",
      { env: { RUNTIME: "yes" } },
      { booted: true }
    );

    expect(result.ok).toBe(true);
    const call = invokeTool.mock.calls.find((c) => c[0] === "flow-execute");
    expect((call?.[1] as { env?: unknown } | undefined)?.env).toEqual({ OWN: "mine" });
  });
});

describe("environment shape rules", () => {
  it("refuses a reserved name in a flow file's own env, printing it whole", async () => {
    await flow("bad", "env: { NODE_OPTIONS: --inspect }\nsteps:\n  - echo: hi\n");

    await expect(runFlow("bad")).rejects.toThrow(/NODE_OPTIONS/);
  });

  it("refuses a YAML tag that builds something the entry walk cannot read", async () => {
    await flow("omap", "env: !!omap\n  - A: one\nsteps:\n  - echo: hi\n");
    await expect(runFlow("omap")).rejects.toThrow(/a Map \(`!!omap`\).*plain map/s);

    await flow("set", "env: !!set\n  ? A\nsteps:\n  - echo: hi\n");
    await expect(runFlow("set")).rejects.toThrow(/a Set \(`!!set`\).*plain map/s);

    await flow("stamp", "env: !!timestamp 2020-01-01\nsteps:\n  - echo: hi\n");
    await expect(runFlow("stamp")).rejects.toThrow(/a Date \(`!!timestamp`\).*plain map/s);
  });

  it("refuses a NUL character in an authored value, naming the key", async () => {
    await write("scripts/probe.mjs", "");
    await flow(
      "nul",
      'steps:\n  - script: { path: ../../scripts/probe.mjs, env: { TOK: "a\\0b" } }\n'
    );

    await expect(runFlow("nul")).rejects.toThrow(/holds a NUL character in the value of TOK/);
  });

  it("refuses a reserved name in a step's env", async () => {
    await write("scripts/probe.mjs", "");
    await flow(
      "bad",
      "steps:\n" +
        "  - script: { path: ../../scripts/probe.mjs, env: { ELECTRON_RUN_AS_NODE: '1' } }\n"
    );

    await expect(runFlow("bad")).rejects.toThrow(/ELECTRON_RUN_AS_NODE/);
  });

  it("refuses a reserved name in the run-time env parameter", async () => {
    await flow("ok", "steps:\n  - echo: hi\n");

    await expect(runFlow("ok", { env: { NODE_CHANNEL_FD: "9" } })).rejects.toThrow(
      /NODE_CHANNEL_FD/
    );
  });

  it("refuses ARGENT_OUTPUT in every env channel", async () => {
    await flow("file-env", "env: { ARGENT_OUTPUT: /tmp/x }\nsteps:\n  - echo: hi\n");
    await expect(runFlow("file-env")).rejects.toThrow(/ARGENT_OUTPUT/);

    await write("scripts/probe.mjs", "");
    await flow(
      "step-env",
      "steps:\n  - script: { path: ../../scripts/probe.mjs, env: { ARGENT_OUTPUT: /tmp/y } }\n"
    );
    await expect(runFlow("step-env")).rejects.toThrow(/ARGENT_OUTPUT/);

    await flow("ok", "steps:\n  - echo: hi\n");
    const runTime = runFlow("ok", { env: { ARGENT_OUTPUT: "/tmp/z" } });
    await expect(runTime).rejects.toThrow(/ARGENT_OUTPUT/);
    // The CODE, not just the sentence. A run-time refusal is about the CALL,
    // not about the file, and `argent flow run <dir>` keys on exactly this to
    // stop the batch instead of failing each flow in turn — but the CLI's own
    // case hand-builds the rejection it expects, so nothing joined that check
    // to the server that emits it. This is that join, from the server's side.
    expect(getFailureSignal(await runTime.catch((e: unknown) => e))?.error_code).toBe(
      FAILURE_CODES.TOOL_INPUT_INVALID
    );

    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    await expect(
      flowAddScriptTool.execute(
        {},
        {
          name: "rec",
          project_root: root,
          path: "../../scripts/probe.mjs",
          env: { ARGENT_OUTPUT: "/tmp/w" },
        }
      )
    ).rejects.toThrow(/ARGENT_OUTPUT/);
  });

  it("passes ARGENT_REASON to the script like any other name, in every env channel", async () => {
    await write("scripts/reason.mjs", reporter("reason", ["ARGENT_REASON"]));

    await flow(
      "reason-file",
      "env: { ARGENT_REASON: from-file }\nsteps:\n  - script: { path: ../../scripts/reason.mjs }\n"
    );
    expect((await runFlow("reason-file")).result.ok).toBe(true);
    expect(seen("reason")).toEqual({ ARGENT_REASON: "from-file" });

    await flow(
      "reason-step",
      "steps:\n  - script: { path: ../../scripts/reason.mjs, env: { ARGENT_REASON: from-step } }\n"
    );
    expect((await runFlow("reason-step")).result.ok).toBe(true);
    expect(seen("reason")).toEqual({ ARGENT_REASON: "from-step" });

    await flow("reason-run", "steps:\n  - script: { path: ../../scripts/reason.mjs }\n");
    const runTime = await runFlow("reason-run", { env: { ARGENT_REASON: "from-run" } });
    expect(runTime.result.ok).toBe(true);
    expect(seen("reason")).toEqual({ ARGENT_REASON: "from-run" });

    await flowStartRecordingTool.execute({}, { name: "reason-rec", project_root: root });
    const added = (await flowAddScriptTool.execute(
      {},
      {
        name: "reason-rec",
        project_root: root,
        path: "../../scripts/reason.mjs",
        env: { ARGENT_REASON: "from-recording" },
      }
    )) as { status: string };
    expect(added.status).toBe("pass");
    expect(seen("reason")).toEqual({ ARGENT_REASON: "from-recording" });
  });

  it("refuses a reserved name in a nested fragment's own env, mid-run", async () => {
    await write("scripts/probe.mjs", "");
    await flow("outer-reserved", "steps:\n  - echo: before\n  - run: inner-reserved.yaml\n");
    await flow(
      "inner-reserved",
      "env: { ARGENT_OUTPUT: /tmp/x }\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/probe.mjs }\n"
    );

    const { result } = await runFlow("outer-reserved", {}, { booted: true });

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("pass");
    expect(JSON.stringify(result.steps)).toContain("ARGENT_OUTPUT");

    await write("scripts/reason.mjs", reporter("fragment-reason", ["ARGENT_REASON"]));
    await flow("outer-reason", "steps:\n  - echo: before\n  - run: inner-reason.yaml\n");
    await flow(
      "inner-reason",
      "env: { ARGENT_REASON: from-fragment }\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/reason.mjs }\n"
    );

    const reasonRun = (await runFlow("outer-reason", {}, { booted: true })).result;

    expect(reasonRun.ok).toBe(true);
    expect(seen("fragment-reason")).toEqual({ ARGENT_REASON: "from-fragment" });
  });

  it("refuses a non-string value and an illegal name", async () => {
    await flow("numeric", "env: { RETRIES: 3 }\nsteps:\n  - echo: hi\n");
    await expect(runFlow("numeric")).rejects.toThrow(/an environment carries strings only/);

    await flow("named", 'env: { "2FA": x }\nsteps:\n  - echo: hi\n');
    await expect(runFlow("named")).rejects.toThrow(/not an environment variable name/);
  });

  it("calls a reserved name reserved, in every spelling npm gives it", async () => {
    const spellings = [
      "npm_config_node-options",
      "npm_config_node_options",
      "NPM_CONFIG_NODE_OPTIONS",
    ];
    for (const [at, name] of spellings.entries()) {
      // Numbered rather than named after the spelling: a case-insensitive
      // filesystem reads two of the three as one flow file.
      await flow(`npmres${at}`, `env: { "${name}": x }\nsteps:\n  - echo: hi\n`);
      const refused = runFlow(`npmres${at}`);
      await expect(refused, name).rejects.toThrow(/steers the runner's own process/);
      await expect(refused, name).rejects.not.toThrow(/not an environment variable name/);
    }
    await flow("stillmalformed", 'env: { "2FA": x }\nsteps:\n  - echo: hi\n');
    await expect(runFlow("stillmalformed")).rejects.toThrow(/not an environment variable name/);
  });

  it("refuses a {{output:...}} reference in every env channel", async () => {
    await write("scripts/probe.mjs", "");
    await flow("out-file", 'env: { X: "{{output:user.id}}" }\nsteps:\n  - echo: hi\n');
    await expect(runFlow("out-file")).rejects.toThrow(/env.X` uses unsupported template syntax/);

    await flow(
      "out-step",
      'steps:\n  - script: { path: ../../scripts/probe.mjs, env: { X: "{{output:user.id}}" } }\n'
    );
    await expect(runFlow("out-step")).rejects.toThrow(/env.X` uses unsupported template syntax/);

    await flow("out-ok", "steps:\n  - echo: hi\n");
    await expect(runFlow("out-ok", { env: { X: "{{output:user.id}}" } })).rejects.toThrow(
      /This run's `env.X` uses unsupported template syntax/
    );

    await flowStartRecordingTool.execute({}, { name: "out-rec", project_root: root });
    await expect(
      flowAddScriptTool.execute(
        {},
        {
          name: "out-rec",
          project_root: root,
          path: "../../scripts/probe.mjs",
          env: { X: "{{output:user.id}}" },
        }
      )
    ).rejects.toThrow(/This call's `env.X` uses unsupported template syntax/);
  });

  it("refuses __proto__, which a merge would drop rather than carry", async () => {
    await flow("proto", "env: { __proto__: x }\nsteps:\n  - echo: hi\n");

    await expect(runFlow("proto")).rejects.toThrow(/__proto__/);
  });
});

describe("serialization", () => {
  it("round-trips a flow whose env holds an empty map and a multi-line value", () => {
    const parsed = parseFlow(
      "env:\n" +
        '  PEM: "-----BEGIN-----\\nline one\\n \\nline two\\n-----END-----"\n' +
        "steps:\n" +
        "  - script: { path: seed.mjs, env: {} }\n"
    );

    const round = parseFlow(serializeFlow(parsed));

    expect(round).toEqual(parsed);
    expect(round.env?.PEM).toContain("\n \n");
    expect(round.steps[0]).toEqual({ kind: "script", path: "seed.mjs", env: {} });
  });

  it("keeps a top-level `env: {}` through the round trip", () => {
    const parsed = parseFlow("env: {}\nsteps:\n  - echo: hi\n");
    expect(parsed.env).toEqual({});

    const text = serializeFlow(parsed);
    expect(text).toContain("env: {}");
    expect(parseFlow(text)).toEqual(parsed);

    expect(serializeFlow(parseFlow("env:\nsteps:\n  - echo: hi\n"))).toBe(text);
  });

  // A minimized real failure: the emitter FOLDS a long double-quoted scalar,
  // and a fold placed between an escaped space and an escaped newline eats the
  // space — `…aaa  a \n…` came back `…aaa  a\n…`, one character shorter than
  // the author wrote and with nothing to say so. Rare (about 437 in 40,000
  // random values built from runs of `a`, spaces and newlines) and silent,
  // which is the combination `serializeFlow`'s `lineWidth: 0` exists for. This
  // value is a local minimum: no character of it can be dropped and still fail.
  it("keeps a folded value's spaces through the round trip", () => {
    const value =
      " \n\na\na\naaaaaaaaaaaa\na  aaaa\naaaaaaaaaaaaaaaaaaaaaaaa\na\na\n \naaa  a \n  a " +
      "\n \n\naaaaaaaaaa  a\naaaaaaaaaaaaaaaaaaaaaaaa\naaaaaaaaaaa \n\n";

    const atFlow = parseFlow(
      serializeFlow({ executionPrerequisite: "", env: { K: value }, steps: [] })
    );
    const atStep = parseFlow(
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "script", path: "seed.mjs", env: { K: value } }],
      })
    );

    expect(atFlow.env?.K).toBe(value);
    expect(atStep.steps[0]).toEqual({ kind: "script", path: "seed.mjs", env: { K: value } });
  });

  it("keeps `env` through a real recorder append", async () => {
    await flowStartRecordingTool.execute({}, { name: "append", project_root: root });
    const filePath = path.join(root, ".argent/flows/append.yaml");
    await fs.writeFile(
      filePath,
      "env: { API_URL: https://example.com }\n" +
        "steps:\n" +
        "  - script: { path: seed.mjs, env: { USER_TYPE: premium } }\n",
      "utf8"
    );

    await flowInsertEchoTool.execute(
      {},
      { name: "append", project_root: root, message: "appended" }
    );

    const after = parseFlow(await fs.readFile(filePath, "utf8"));
    expect(after.env).toEqual({ API_URL: "https://example.com" });
    expect(after.steps[0]).toEqual({
      kind: "script",
      path: "seed.mjs",
      env: { USER_TYPE: "premium" },
    });
    expect(after.steps[1]).toEqual({ kind: "echo", message: "appended" });
  });

  it("says an echo went unrecorded when the FILE's env is what refused it", async () => {
    await flowStartRecordingTool.execute({}, { name: "echorefuse", project_root: root });
    await fs.writeFile(
      path.join(root, ".argent/flows/echorefuse.yaml"),
      'env:\n  TOKEN: "{{output:1.token}}"\nsteps: []\n',
      "utf8"
    );

    const rejection = flowInsertEchoTool.execute(
      {},
      { name: "echorefuse", project_root: root, message: "note" }
    );

    await expect(rejection).rejects.toThrow(/The echo was not recorded/);
    await expect(rejection).rejects.toThrow(/already in the file, not in this call/);
    await expect(rejection).rejects.toThrow(/unsupported template syntax/);
  });

  it("says the call already ran when a PARSE-stage env fault refuses the append", async () => {
    for (const [name, header] of [
      ["parse-reserved", 'env:\n  NODE_OPTIONS: "--inspect"\nsteps: []\n'],
      ["parse-number", "env:\n  RETRIES: 5\nsteps: []\n"],
    ] as const) {
      await flowStartRecordingTool.execute({}, { name, project_root: root });
      await write(`.argent/flows/${name}.yaml`, header);

      await expect(
        flowInsertEchoTool.execute({}, { name, project_root: root, message: "note" })
      ).rejects.toThrow(/The echo was not recorded\..*already in the file, not in this call/s);

      const { registry } = mockRegistry({ booted: true });
      await expect(
        createFlowAddStepTool(registry).execute({}, {
          name,
          project_root: root,
          command: "gesture-tap",
          args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.5 }),
        } as never)
      ).rejects.toThrow(/call ran, but something already in the flow file failed validation/);
    }
  });

  it("opens every env refusal with the two words the decision rule reads", async () => {
    await write("scripts/noop.mjs", "output.ok = true;");
    await flowStartRecordingTool.execute({}, { name: "wording", project_root: root });
    for (const env of [
      { NODE_OPTIONS: "--inspect" },
      { "not a name": "x" },
      { A: "{{output:x}}" },
      JSON.parse('{"__proto__":"x","A":"y"}') as Record<string, string>,
    ]) {
      const refused = await flowAddScriptTool
        .execute({}, {
          name: "wording",
          project_root: root,
          path: "../../scripts/noop.mjs",
          env,
        } as never)
        .then(
          () => "",
          (err: unknown) => (err instanceof Error ? err.message : String(err))
        );
      expect(refused, JSON.stringify(env)).toMatch(/^This call's `env/);
      expect(refused).not.toContain("was NOT run and nothing was recorded");
    }
  }, 30_000);

  it("says the script already ran when a PARSE-stage env fault refuses its append", async () => {
    await write(
      "scripts/slow.mjs",
      "await new Promise((r) => setTimeout(r, 1200));\noutput.ok = true;"
    );
    for (const [name, header] of [
      ["script-parse-reserved", 'env:\n  NODE_OPTIONS: "--inspect"\nsteps: []\n'],
      ["script-parse-number", "env:\n  RETRIES: 5\nsteps: []\n"],
      ["script-output-ref", 'env:\n  TOKEN: "{{output:1.token}}"\nsteps: []\n'],
    ] as const) {
      await flowStartRecordingTool.execute({}, { name, project_root: root });

      const rejection = flowAddScriptTool.execute({}, {
        name,
        project_root: root,
        path: "../../scripts/slow.mjs",
      } as never);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await write(`.argent/flows/${name}.yaml`, header);

      await expect(rejection).rejects.toThrow(/passed, but the step was not recorded/);
      await expect(rejection).rejects.toThrow(/already in the file, not in this script/);
      await expect(rejection).rejects.not.toThrow(/Check the script's changes before you retry/);
    }
  }, 30_000);

  it("truncates a checked-in `env:` with the rest of the file", async () => {
    await write(
      ".argent/flows/header.yaml",
      'env:\n  API_URL: https://example.com\n  BUILD: "42"\n' + "steps:\n  - echo: hello\n"
    );

    const started = (await flowStartRecordingTool.execute(
      {},
      { name: "header", project_root: root }
    )) as { message: string; flowFile: string };

    expect(started.flowFile).toBe("steps: []\n");
    expect(started.message).not.toContain("API_URL");
  });

  it("keeps `env` through a flow-add-step append", async () => {
    await flowStartRecordingTool.execute({}, { name: "addstep", project_root: root });
    const filePath = path.join(root, ".argent/flows/addstep.yaml");
    await fs.writeFile(
      filePath,
      "env: { API_URL: https://example.com }\n" +
        "steps:\n" +
        "  - script: { path: seed.mjs, env: { USER_TYPE: premium } }\n",
      "utf8"
    );

    const { registry } = mockRegistry({ booted: true });
    await createFlowAddStepTool(registry).execute({}, {
      name: "addstep",
      project_root: root,
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.5 }),
    } as never);

    const after = parseFlow(await fs.readFile(filePath, "utf8"));
    expect(after.env).toEqual({ API_URL: "https://example.com" });
    expect(after.steps[0]).toEqual({
      kind: "script",
      path: "seed.mjs",
      env: { USER_TYPE: "premium" },
    });
    expect(after.steps).toHaveLength(2);
  });

  it("keeps `env` through a serialize round trip", async () => {
    await flow(
      "kept",
      "env: { API_URL: https://example.com }\n" +
        "steps:\n" +
        "  - script: { path: seed.mjs, env: { USER_TYPE: premium } }\n"
    );
    const parsed = parseFlow(await fs.readFile(path.join(root, ".argent/flows/kept.yaml"), "utf8"));
    parsed.steps.push({ kind: "echo", message: "appended" });

    const round = parseFlow(serializeFlow(parsed));

    expect(round.env).toEqual({ API_URL: "https://example.com" });
    expect(round.steps[0]).toEqual({
      kind: "script",
      path: "seed.mjs",
      env: { USER_TYPE: "premium" },
    });
  });
});

describe("a tool env parameter that carries __proto__", () => {
  const withProto = (): Record<string, string> =>
    JSON.parse('{"__proto__":"x","A":"y"}') as Record<string, string>;

  it("refuses it on the run-time parameter", async () => {
    await flow("proto", "steps:\n  - echo: hi\n");
    const { registry } = mockRegistry();

    await expect(
      createRunFlowTool(registry).execute({}, {
        project_root: root,
        name: "proto",
        env: withProto(),
      } as never)
    ).rejects.toThrow(/`env` holds __proto__/);
  });

  it("refuses it on flow-add-script", async () => {
    await write("scripts/noop.mjs", "output.ok = true;");
    await flowStartRecordingTool.execute({}, { name: "proto-rec", project_root: root });

    await expect(
      flowAddScriptTool.execute({}, {
        name: "proto-rec",
        project_root: root,
        path: "../../scripts/noop.mjs",
        env: withProto(),
      } as never)
    ).rejects.toThrow(/`env` holds __proto__/);
  });
});

describe("the host allowlist extension", () => {
  it("adds a configured name and drops an ARGENT_ one, naming it in a note", async () => {
    process.env.PROJECT_DB_URL = "postgres://fixture";
    process.env.ARGENT_AUTH_TOKEN = "host-token";
    try {
      await write(
        ".argent/config.json",
        JSON.stringify({ scripts: { env: { allow: ["PROJECT_DB_URL", "ARGENT_AUTH_TOKEN"] } } })
      );
      await write("scripts/probe.mjs", reporter("allow", ["PROJECT_DB_URL", "ARGENT_AUTH_TOKEN"]));
      await flow("allow", "steps:\n  - script: { path: ../../scripts/probe.mjs }\n");

      const { result } = await runFlow("allow");

      expect(result.ok).toBe(true);
      expect(seen("allow")).toEqual({
        PROJECT_DB_URL: "postgres://fixture",
        ARGENT_AUTH_TOKEN: null,
      });
      expect(result.steps[0].reason).toContain("ARGENT_AUTH_TOKEN");
      expect(result.steps[0].reason).toContain("scripts.env.allow");
    } finally {
      delete process.env.PROJECT_DB_URL;
      delete process.env.ARGENT_AUTH_TOKEN;
    }
  });

  it("drops an ARGENT_ name written in another case, and says so", async () => {
    process.env.Argent_Auth_Token = "host-token";
    try {
      await write(
        ".argent/config.json",
        JSON.stringify({ scripts: { env: { allow: ["Argent_Auth_Token"] } } })
      );
      await write("scripts/probe.mjs", reporter("mixedcase", ["Argent_Auth_Token"]));
      await flow("mixedcase", "steps:\n  - script: { path: ../../scripts/probe.mjs }\n");

      const { result } = await runFlow("mixedcase");

      expect(result.ok).toBe(true);
      expect(seen("mixedcase")).toEqual({ Argent_Auth_Token: null });
      expect(result.steps[0].reason).toContain("Argent_Auth_Token");
      expect(result.steps[0].reason).toContain("scripts.env.allow");
    } finally {
      delete process.env.Argent_Auth_Token;
    }
  });

  it("reads the list from the global scope as well, and takes the union", async () => {
    process.env.FROM_GLOBAL_CFG = "global-value";
    process.env.FROM_PROJECT_CFG = "project-value";
    try {
      await write(
        ".argent/config.json",
        JSON.stringify({ scripts: { env: { allow: ["FROM_PROJECT_CFG"] } } })
      );
      await fs.mkdir(path.join(os.homedir(), ".argent"), { recursive: true });
      await fs.writeFile(
        path.join(os.homedir(), ".argent", "config.json"),
        JSON.stringify({ scripts: { env: { allow: ["FROM_GLOBAL_CFG"] } } }),
        "utf8"
      );
      await write("scripts/probe.mjs", reporter("scopes", ["FROM_GLOBAL_CFG", "FROM_PROJECT_CFG"]));
      await flow("scopes", "steps:\n  - script: { path: ../../scripts/probe.mjs }\n");

      const { result } = await runFlow("scopes");

      expect(result.ok).toBe(true);
      expect(seen("scopes")).toEqual({
        FROM_GLOBAL_CFG: "global-value",
        FROM_PROJECT_CFG: "project-value",
      });
    } finally {
      delete process.env.FROM_GLOBAL_CFG;
      delete process.env.FROM_PROJECT_CFG;
    }
  });

  it("says which file lists a dropped name when two are configured", async () => {
    await write(
      ".argent/config.json",
      JSON.stringify({ scripts: { env: { allow: ["PROJECT_OK"] } } })
    );
    await fs.mkdir(path.join(os.homedir(), ".argent"), { recursive: true });
    const globalFile = path.join(os.homedir(), ".argent", "config.json");
    await fs.writeFile(
      globalFile,
      JSON.stringify({ scripts: { env: { allow: ["NODE_OPTIONS"] } } }),
      "utf8"
    );
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow("whichfile", "steps:\n  - script: { path: ../../scripts/noop.mjs }\n");

    const { result } = await runFlow("whichfile");

    const reason = result.steps[0].reason ?? "";
    expect(reason).toContain("NODE_OPTIONS");
    expect(reason).toContain(`Listed in ${globalFile.replace(/\\/g, "\\\\")}.`);
  });

  it("stays silent about which file when only one is configured", async () => {
    await write(
      ".argent/config.json",
      JSON.stringify({ scripts: { env: { allow: ["NODE_OPTIONS"] } } })
    );
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow("onefile", "steps:\n  - script: { path: ../../scripts/noop.mjs }\n");

    const { result } = await runFlow("onefile");

    const reason = result.steps[0].reason ?? "";
    expect(reason).toContain("NODE_OPTIONS");
    expect(reason).not.toContain("Listed in");
  });

  it("says a config file that does not parse lost everything in it", async () => {
    await write(".argent/config.json", '{ "scripts": { "env": { "allow": ["DB_URL"] } } ,,, }');
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow("badjson", "steps:\n  - script: { path: ../../scripts/noop.mjs }\n");

    const { result } = await runFlow("badjson");

    const reason = result.steps[0].reason ?? "";
    expect(result.ok).toBe(true);
    expect(reason).toContain("is not valid JSON");
    expect(reason).toContain("read nothing from it at all");
  });

  it("answers a reserved entry and an ARGENT_ one differently", async () => {
    await write(
      ".argent/config.json",
      JSON.stringify({
        scripts: { env: { allow: ["NODE_OPTIONS", "npm_config_userconfig", "ARGENT_PORT"] } },
      })
    );
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow("buckets", "steps:\n  - script: { path: ../../scripts/noop.mjs }\n");

    const { result } = await runFlow("buckets");

    const reason = result.steps[0].reason ?? "";
    expect(result.ok).toBe(true);
    expect(reason).toContain(
      "names ARGENT_PORT, which argent keeps out of the copy it takes from its own environment"
    );
    expect(reason).toContain(
      "names NODE_OPTIONS, npm_config_userconfig, which steer the runner's own process"
    );
    expect(reason).toMatch(/ARGENT_PORT[\s\S]*under a name of your own/);
    expect(reason).not.toMatch(/steer the runner's own process[\s\S]*under a name of your own/);
  });

  it("says so when scripts.env.allow is not a list", async () => {
    await write(
      ".argent/config.json",
      JSON.stringify({ scripts: { env: { allow: "DATABASE_URL" } } })
    );
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow("notalist", "steps:\n  - script: { path: ../../scripts/noop.mjs }\n");

    const { result } = await runFlow("notalist");

    expect(result.ok).toBe(true);
    expect(result.steps[0].reason).toContain("is not a list");
    expect(result.steps[0].reason).toContain('e.g. ["DATABASE_URL"]');
  });

  it("names a malformed entry and a __proto__ one apart", async () => {
    await write(
      ".argent/config.json",
      JSON.stringify({ scripts: { env: { allow: ["9LIVES", "__proto__"] } } })
    );
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow("badnames", "steps:\n  - script: { path: ../../scripts/noop.mjs }\n");

    const { result } = await runFlow("badnames");

    const reason = result.steps[0].reason ?? "";
    expect(result.ok).toBe(true);
    expect(reason).toContain('"9LIVES"');
    expect(reason).toContain("is not an environment variable name");
    expect(reason).toContain("__proto__, which argent cannot carry");
  });

  it("names an allowlist entry that is not a name at all", async () => {
    await write(
      ".argent/config.json",
      JSON.stringify({
        scripts: { env: { allow: ["DB_URL", ["AWS_PROFILE", "AWS_REGION"], 42, ""] } },
      })
    );
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow("badentries", "steps:\n  - script: { path: ../../scripts/noop.mjs }\n");

    const { result } = await runFlow("badentries");

    const reason = result.steps[0].reason ?? "";
    expect(result.ok).toBe(true);
    expect(reason).toContain("scripts.env.allow");
    expect(reason).toContain('["AWS_PROFILE","AWS_REGION"]');
    expect(reason).toContain("42");
    expect(reason).toContain("Those entries were ignored");
  });

  it("names a reserved allowlist entry reserved, not malformed", async () => {
    await write(
      ".argent/config.json",
      JSON.stringify({ scripts: { env: { allow: ["npm_config_node-options"] } } })
    );
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow("npmallow", "steps:\n  - script: { path: ../../scripts/noop.mjs }\n");

    const { result } = await runFlow("npmallow");

    const reason = result.steps[0].reason ?? "";
    expect(result.ok).toBe(true);
    expect(reason).toContain("npm_config_node-options");
    expect(reason).toContain("steers the runner's own process rather than reaching the script");
    expect(reason).not.toContain("is not an environment variable name");
  });
  it("says a note once per run, not once per step", async () => {
    await write(
      ".argent/config.json",
      JSON.stringify({ scripts: { env: { allow: ["ARGENT_PORT"] } } })
    );
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow(
      "once",
      "steps:\n" +
        "  - script: { path: ../../scripts/noop.mjs }\n" +
        "  - script: { path: ../../scripts/noop.mjs }\n"
    );

    const { result } = await runFlow("once");

    expect(result.ok).toBe(true);
    expect(result.steps[0].reason).toContain("ARGENT_PORT");
    expect(result.steps[1].reason).toBeUndefined();

    const second = (await runFlow("once")).result;
    expect(second.steps[0].reason).toContain("ARGENT_PORT");
  });
});

describe("a bash step's environment", () => {
  it("observes the same precedence through printenv", async (ctx) => {
    skipWithoutBash(ctx);
    await write(
      "scripts/probe.sh",
      `printenv PROBE_FLOW > "${shellMarkPath("flow")}"\n` +
        `printenv PROBE_RUN > "${shellMarkPath("run")}"\n` +
        `printenv PROBE_STEP > "${shellMarkPath("step")}"\n`
    );
    await flow(
      "sh",
      "env:\n" +
        "  PROBE_FLOW: from-flow\n" +
        "  PROBE_RUN: from-flow\n" +
        "  PROBE_STEP: from-flow\n" +
        "steps:\n" +
        "  - script:\n" +
        "      path: ../../scripts/probe.sh\n" +
        "      env: { PROBE_STEP: from-step }\n"
    );

    const { result } = await runFlow("sh", { env: { PROBE_RUN: "from-run" } });

    expect(result.ok).toBe(true);
    expect(readMark("flow")).toBe("from-flow\n");
    expect(readMark("run")).toBe("from-run\n");
    expect(readMark("step")).toBe("from-step\n");
  });

  it("observes a fragment's layer through printenv too", async (ctx) => {
    skipWithoutBash(ctx);
    await write(
      "scripts/frag.sh",
      `printenv PROBE_FRAGMENT > "${shellMarkPath("sh-fragment")}"\n` +
        `printenv PROBE_FLOW > "${shellMarkPath("sh-inherited")}"\n`
    );
    await write("scripts/after.sh", `printenv PROBE_FRAGMENT > "${shellMarkPath("sh-after")}"\n`);
    await flow(
      "sh-parent",
      "env:\n" +
        "  PROBE_FLOW: from-flow\n" +
        "  PROBE_FRAGMENT: from-flow\n" +
        "steps:\n" +
        "  - run: sh-fragment.yaml\n" +
        "  - script: { path: ../../scripts/after.sh }\n"
    );
    await flow(
      "sh-fragment",
      "env: { PROBE_FRAGMENT: from-fragment }\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/frag.sh }\n"
    );

    const { result } = await runFlow("sh-parent", {}, { booted: true });

    expect(result.ok).toBe(true);
    expect(readMark("sh-fragment")).toBe("from-fragment\n");
    expect(readMark("sh-inherited")).toBe("from-flow\n");
    expect(readMark("sh-after")).toBe("from-flow\n");
  });

  it("carries a run-time value holding a space, whole, to both languages", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/space.mjs", reporter("space-mjs", ["AUTH"]));
    await write("scripts/space.sh", `printenv AUTH > "${shellMarkPath("space-sh")}"\n`);
    await flow(
      "space",
      "steps:\n" +
        "  - script: { path: ../../scripts/space.mjs }\n" +
        "  - script: { path: ../../scripts/space.sh }\n"
    );

    const { result } = await runFlow("space", { env: { AUTH: "Bearer abc" } });

    expect(result.ok).toBe(true);
    expect(seen("space-mjs")).toEqual({ AUTH: "Bearer abc" });
    expect(readMark("space-sh")).toBe("Bearer abc\n");
  });
});

describe("secret placeholders in an env value", () => {
  async function writeProjectSecret(name: string, value: string): Promise<void> {
    await write(".argent/secrets.env", `${name}=${value}\n`);
  }

  it("resolves a project secret while the tool server's cwd points elsewhere", async () => {
    expect(path.resolve(process.cwd()).startsWith(root)).toBe(false);
    await writeProjectSecret("API_KEY", "sk-live-9d3f0a1b");
    await write("scripts/probe.mjs", reporter("secret", ["API_KEY"]));
    await flow(
      "secret",
      "steps:\n" +
        '  - script: { path: ../../scripts/probe.mjs, env: { API_KEY: "{{secret:API_KEY}}" } }\n'
    );

    const { result } = await runFlow("secret");

    expect(result.ok).toBe(true);
    expect(seen("secret")).toEqual({ API_KEY: "sk-live-9d3f0a1b" });
  });

  it("reaches a .sh as $NAME", async (ctx) => {
    skipWithoutBash(ctx);
    await writeProjectSecret("API_KEY", "sk-live-9d3f0a1b");
    await write("scripts/probe.sh", `printenv API_KEY > "${shellMarkPath("sh-secret")}"\n`);
    await flow(
      "sh-secret",
      "steps:\n" +
        '  - script: { path: ../../scripts/probe.sh, env: { API_KEY: "{{secret:API_KEY}}" } }\n'
    );

    const { result } = await runFlow("sh-secret");

    expect(result.ok).toBe(true);
    expect(readMark("sh-secret")).toBe("sk-live-9d3f0a1b\n");
  });

  it("replaces the resolved value in the reason and the stack a .mjs throws", async () => {
    await writeProjectSecret("API_KEY", "sk-live-9d3f0a1b");
    await write(
      "scripts/fail.mjs",
      `throw new Error("401 from " + process.env.API_URL + " for key " + process.env.API_KEY);`
    );
    await flow(
      "throws",
      "env: { API_URL: https://api.example.com }\n" +
        "steps:\n" +
        '  - script: { path: ../../scripts/fail.mjs, env: { API_KEY: "{{secret:API_KEY}}" } }\n'
    );

    const { result } = await runFlow("throws");

    const reason = result.steps[0].reason ?? "";
    expect(result.steps[0].status).toBe("fail");
    expect(reason).not.toContain("sk-live-9d3f0a1b");
    expect(reason).toContain("401 from https://api.example.com for key {{secret:API_KEY}}");
    expect(reason).toContain("fail.mjs");
  });

  it("replaces the resolved value a .sh wrote to stderr, in the reason and the log", async (ctx) => {
    skipWithoutBash(ctx);
    await writeProjectSecret("API_KEY", "sk-live-9d3f0a1b");
    await write("scripts/fail.sh", `printf 'the call with %s failed\\n' "$API_KEY" >&2\nexit 1\n`);
    await flow(
      "sh-throws",
      "steps:\n" +
        '  - script: { path: ../../scripts/fail.sh, env: { API_KEY: "{{secret:API_KEY}}" } }\n'
    );

    const { result } = await runFlow("sh-throws");

    const reason = result.steps[0].reason ?? "";
    const log = result.steps[0].scriptLog ?? "";
    expect(result.steps[0].status).toBe("fail");
    expect(reason).not.toContain("sk-live-9d3f0a1b");
    expect(reason).toContain("the call with {{secret:API_KEY}} failed");
    expect(log).not.toContain("sk-live-9d3f0a1b");
    expect(log).toContain("the call with {{secret:API_KEY}} failed");
  });

  it("redacts a one-character secret like any other — there is no floor", async () => {
    await writeProjectSecret("PIN", "7");
    await write("scripts/fail.mjs", `throw new Error("pin was " + process.env.PIN);`);
    await flow(
      "tiny",
      'steps:\n  - script: { path: ../../scripts/fail.mjs, env: { PIN: "{{secret:PIN}}" } }\n'
    );

    const { result } = await runFlow("tiny");

    expect(result.steps[0].reason).toContain("pin was {{secret:PIN}}");
  });

  it("errors the step on an unknown name, listing the names that resolve", async () => {
    await writeProjectSecret("KNOWN", "value");
    await write("scripts/probe.mjs", "");
    await flow(
      "unknown",
      'steps:\n  - script: { path: ../../scripts/probe.mjs, env: { X: "{{secret:MISSING}}" } }\n'
    );

    const { result } = await runFlow("unknown");

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain("env value X");
    expect(result.steps[0].reason).toContain('Unknown secret "MISSING"');
    expect(result.steps[0].reason).toContain("KNOWN");
  });

  it("refuses an unknown name in the RUN's own env as caller input", async () => {
    // A flow file's `env:` is that file's own text, so an unknown name there is
    // one flow's fault and stays a per-step error. The run's map is one
    // argument every flow in a directory takes, so the same name there is ONE
    // fault: left to the step it repeated a ~900-character refusal once per
    // file and ended `0 passed, N failed`, naming N files for one typo.
    //
    // The error CODE is the fix, not the wording: the CLI stops a directory run
    // on `TOOL_INPUT_INVALID` and on nothing else, so a more granular code here
    // would silently put the batch back to blaming every file.
    await writeProjectSecret("KNOWN", "value");
    await write("scripts/probe.mjs", "");
    await flow("runsecret", "steps:\n  - script: { path: ../../scripts/probe.mjs }\n");

    const refused = runFlow("runsecret", { env: { AUTH: "{{secret:MISSING}}" } });
    await expect(refused).rejects.toThrow(/This run's env value AUTH/);
    await expect(refused).rejects.toThrow(/Unknown secret "MISSING"/);
    expect(getFailureSignal(await refused.catch((err: unknown) => err))?.error_code).toBe(
      FAILURE_CODES.TOOL_INPUT_INVALID
    );

    await flow(
      "filesecret",
      'env: { AUTH: "{{secret:MISSING}}" }\nsteps:\n  - script: { path: ../../scripts/probe.mjs }\n'
    );
    const { result } = await runFlow("filesecret");
    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain('Unknown secret "MISSING"');
  });

  it("resolves a RUN-level secret against the run's project, not the server's cwd", async () => {
    expect(path.resolve(process.cwd()).startsWith(root)).toBe(false);
    await writeProjectSecret("RUN_TOKEN", "sk-run-4b21");
    await write("scripts/probe.mjs", reporter("runanchor", ["AUTH"]));
    await flow("runanchor", "steps:\n  - script: { path: ../../scripts/probe.mjs }\n");

    const { result } = await runFlow("runanchor", { env: { AUTH: "{{secret:RUN_TOKEN}}" } });

    expect(result.ok).toBe(true);
    expect(seen("runanchor")).toEqual({ AUTH: "sk-run-4b21" });
  });

  it("refuses an unpaired surrogate in an env value", async () => {
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow(
      "lone",
      "steps:\n" + '  - script: { path: ../../scripts/noop.mjs, env: { LONE: "\\uD800abc" } }\n'
    );

    await expect(runFlow("lone")).rejects.toThrow(
      /script `env` holds an unpaired surrogate in the value of LONE/
    );
  });

  it("refuses a resolved value an environment cannot carry, without quoting it", async () => {
    await write(".argent/secrets.env", 'NULKEY="sec\u0000ret-9d3f"\n');
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow(
      "nulsec",
      "steps:\n" +
        '  - script: { path: ../../scripts/noop.mjs, env: { TOK: "{{secret:NULKEY}}" } }\n'
    );

    const { result } = await runFlow("nulsec");

    const reason = result.steps[0].reason ?? "";
    expect(result.steps[0].status).toBe("error");
    expect(reason).toContain("env value TOK");
    expect(reason).toContain("holds a NUL character");
    expect(reason).not.toContain("ret-9d3f");
  });

  it("hands a near-spelling to the script as literal text, unresolved", async () => {
    await writeProjectSecret("X", "resolved-value");
    await write("scripts/probe.mjs", reporter("spelling", ["A", "B", "C"]));
    await flow(
      "spelling",
      "steps:\n" +
        "  - script:\n" +
        "      path: ../../scripts/probe.mjs\n" +
        '      env: { A: "{{ secret: X }}", B: "{{SECRET:X}}", C: "{secret:X}" }\n'
    );

    const { result } = await runFlow("spelling");

    expect(result.ok).toBe(true);
    expect(seen("spelling")).toEqual({
      A: "{{ secret: X }}",
      B: "{{SECRET:X}}",
      C: "{secret:X}",
    });
  });
});

describe("the shell-environment note", () => {
  it("explains a command a .mjs could not find, and stays off an unrelated failure", async () => {
    await write(
      "scripts/missing.mjs",
      `import { execSync } from "node:child_process";\n` + `execSync("argent-no-such-command-xyz");`
    );
    await write("scripts/fixture.mjs", `throw new Error("fixture: users.json: not found");`);
    await flow("notes", "steps:\n  - script: { path: ../../scripts/missing.mjs }\n");
    await flow("unrelated", "steps:\n  - script: { path: ../../scripts/fixture.mjs }\n");

    const missing = (await runFlow("notes")).result;
    const unrelated = (await runFlow("unrelated")).result;

    expect(missing.steps[0].reason).toContain("A command was not found.");
    expect(missing.steps[0].reason).toContain("snapshot");
    expect(missing.steps[0].reason).toContain("`scripts.env.allow` cannot widen it");
    expect(unrelated.steps[0].reason).toContain("fixture: users.json: not found");
    expect(unrelated.steps[0].reason).not.toContain("A command was not found");
    expect(unrelated.steps[0].reason).not.toContain("snapshot");
  });

  it("reads dash's wording without reading a three-part application error", async () => {
    await write(
      "scripts/dash.mjs",
      `throw new Error("Command failed: adb devices\\n/bin/sh: 1: adb: not found\\n");`
    );
    await write(
      "scripts/three-part.mjs",
      `throw new Error("fixtures/orders.json: 12: customerId: not found");`
    );
    await write(
      "scripts/http-part.mjs",
      `throw new Error("seed failed for api/v1/users: 404: user: not found");`
    );
    await write("scripts/named.mjs", `throw new Error("/tmp/run tests.sh: 3: adb: not found");`);
    await flow("dash-line", "steps:\n  - script: { path: ../../scripts/dash.mjs }\n");
    await flow("dash-named", "steps:\n  - script: { path: ../../scripts/named.mjs }\n");
    await flow("three-part", "steps:\n  - script: { path: ../../scripts/three-part.mjs }\n");
    await flow("http-part", "steps:\n  - script: { path: ../../scripts/http-part.mjs }\n");

    const dash = (await runFlow("dash-line")).result;
    const named = (await runFlow("dash-named")).result;
    const threePart = (await runFlow("three-part")).result;
    const httpPart = (await runFlow("http-part")).result;

    expect(dash.steps[0].reason).toContain("A command was not found.");
    expect(named.steps[0].reason).toContain("A command was not found.");
    expect(threePart.steps[0].reason).toContain("fixtures/orders.json");
    expect(threePart.steps[0].reason).not.toContain("A command was not found");
    expect(threePart.steps[0].reason).not.toContain("tool server");
    expect(httpPart.steps[0].reason).not.toContain("A command was not found");
    expect(httpPart.steps[0].reason).not.toContain("tool server");
  });

  it("asks for a shell writer in the longer wording too, not only in dash's", async () => {
    await write("scripts/tenant.mjs", `throw new Error("tenant acme: seed: command not found");`);
    await write("scripts/first.mjs", `throw new Error("tenant acme: command not found: seed");`);
    await write("scripts/bare.mjs", `throw new Error("sh: adb: command not found");`);
    await write(
      "scripts/lined.mjs",
      `throw new Error("/tmp/run.sh: line 3: adb: command not found");`
    );
    await write("scripts/zsh.mjs", `throw new Error("zsh:1: command not found: adb");`);
    for (const name of ["tenant", "first", "bare", "lined", "zsh"]) {
      await flow(name, `steps:\n  - script: { path: ../../scripts/${name}.mjs }\n`);
    }

    const reason = async (name: string) => (await runFlow(name)).result.steps[0].reason ?? "";

    expect(await reason("tenant")).not.toContain("A command was not found");
    expect(await reason("tenant")).not.toContain("tool server");
    expect(await reason("first")).not.toContain("A command was not found");
    expect(await reason("first")).not.toContain("tool server");
    expect(await reason("bare")).toContain("A command was not found.");
    expect(await reason("lined")).toContain("A command was not found.");
    expect(await reason("zsh")).toContain("A command was not found.");
  });

  it("says a shell's words may be the far end's, and does not say it of Node's", async () => {
    await write(
      "scripts/relayed.mjs",
      `throw new Error("Command failed: adb shell pm list packages\\n/system/bin/sh: pm: command not found\\n");`
    );
    await write("scripts/local-enoent.mjs", `throw new Error("spawnSync adb ENOENT");`);
    await flow("relayed", "steps:\n  - script: { path: ../../scripts/relayed.mjs }\n");
    await flow("local-enoent", "steps:\n  - script: { path: ../../scripts/local-enoent.mjs }\n");

    const relayed = (await runFlow("relayed")).result.steps[0].reason ?? "";
    const local = (await runFlow("local-enoent")).result.steps[0].reason ?? "";

    expect(relayed).toContain("A command was not found.");
    expect(relayed).toContain("on the OTHER end in these same words");
    expect(local).toContain("A command was not found — or the working directory");
    expect(local).not.toContain("OTHER end");
  });

  it("reads Node's own ENOENT spelling without reading a sentence holding the word", async () => {
    await write("scripts/spawn-enoent.mjs", `throw new Error("spawnSync adb ENOENT");`);
    await write(
      "scripts/sentence-enoent.mjs",
      `throw new Error("could not spawn the seeder because the fixture directory is missing ENOENT");`
    );
    await flow("spawn-enoent", "steps:\n  - script: { path: ../../scripts/spawn-enoent.mjs }\n");
    await flow(
      "sentence-enoent",
      "steps:\n  - script: { path: ../../scripts/sentence-enoent.mjs }\n"
    );

    const spawned = (await runFlow("spawn-enoent")).result;
    const sentence = (await runFlow("sentence-enoent")).result;

    expect(spawned.steps[0].reason).toContain("A command was not found — or the working directory");
    expect(sentence.steps[0].reason).toContain("fixture directory is missing");
    expect(sentence.steps[0].reason).not.toContain("A command was not found");
    expect(sentence.steps[0].reason).not.toContain("tool server");
  });

  it("names the run's own PATH when the run is what set it", async () => {
    await write(
      "scripts/own-path.mjs",
      `import { execSync } from "node:child_process";\n` + `execSync("git --version");`
    );
    await flow(
      "own-path",
      "env: { PATH: /nonexistent/bin }\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/own-path.mjs }\n"
    );

    const { result } = await runFlow("own-path");

    const reason = result.steps[0].reason ?? "";
    expect(reason).toContain("A command was not found.");
    expect(reason).toContain("This run sets `PATH` itself");
    expect(reason).not.toContain("/nonexistent/bin");
    expect(reason).not.toContain("Restart the tool server");
    expect(reason).not.toContain("snapshot");
  });

  it("reads exit 127 from a .sh without repeating the runner's own hint", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/missing.sh", `argent-no-such-command-xyz\n`);
    await flow("sh-missing", "steps:\n  - script: { path: ../../scripts/missing.sh }\n");

    const { result } = await runFlow("sh-missing");

    const reason = result.steps[0].reason ?? "";
    expect(reason).toContain("exited with code 127");
    expect(reason).toContain("The tool server keeps the environment it started with");
    expect(reason).not.toContain("A command was not found.");
  });

  it("keeps the note for a .sh whose stderr line is the shell's own wording", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/not-found.sh", `argent-no-such-command-xyz\n`);
    await flow("sh-not-found", "steps:\n  - script: { path: ../../scripts/not-found.sh }\n");

    const { result } = await runFlow("sh-not-found");

    const reason = result.steps[0].reason ?? "";
    expect(reason).toContain("exited with code 127");
    expect(reason).toContain("argent-no-such-command-xyz: command not found");
    expect(reason).toContain("The tool server keeps the environment it started with");
    expect(reason).not.toContain("A command was not found.");
  });

  it("keeps the note when the shell's line names the script by a Windows path", async (ctx) => {
    skipWithoutBash(ctx);
    await write(
      "scripts/win-not-found.sh",
      `echo "C:/Users/dev/project/scripts/win-not-found.sh: line 1: adb: command not found" >&2\n` +
        `exit 127\n`
    );
    await flow(
      "sh-win-not-found",
      "steps:\n  - script: { path: ../../scripts/win-not-found.sh }\n"
    );

    const { result } = await runFlow("sh-win-not-found");

    const reason = result.steps[0].reason ?? "";
    expect(reason).toContain("exited with code 127");
    expect(reason).toContain("The tool server keeps the environment it started with");
  });

  it("leaves a .sh that chose 127 and explained itself alone", async (ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/own-127.sh", `echo "no such tenant" >&2\nexit 127\n`);
    await flow("sh-own-127", "steps:\n  - script: { path: ../../scripts/own-127.sh }\n");

    const { result } = await runFlow("sh-own-127");

    const reason = result.steps[0].reason ?? "";
    expect(reason).toContain("exited with code 127");
    expect(reason).toContain("no such tenant");
    expect(reason).not.toContain("The tool server keeps the environment it started with");
  });
});

describe("what is NOT hidden", () => {
  it("leaves a passing step's report untouched", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write("scripts/pass.mjs", `output.token = process.env.API_KEY;`);
    await flow(
      "passing",
      "env: { API_URL: https://api.example.com }\n" +
        "steps:\n" +
        '  - script: { path: ../../scripts/pass.mjs, env: { API_KEY: "{{secret:API_KEY}}" } }\n' +
        "  - echo: Calling https://api.example.com\n"
    );

    const { result } = await runFlow("passing");

    expect(result.ok).toBe(true);
    expect(result.steps[1].message).toBe("Calling https://api.example.com");
    expect(JSON.stringify(result.steps[0])).not.toContain("…");
  });

  it("returns the output document as the script wrote it, resolved secret and all", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write("scripts/doc.mjs", `output.token = process.env.API_KEY;`);
    await flowStartRecordingTool.execute({}, { name: "document", project_root: root });

    const added = (await flowAddScriptTool.execute(
      {},
      {
        name: "document",
        project_root: root,
        path: "../../scripts/doc.mjs",
        env: { API_KEY: "{{secret:API_KEY}}" },
      }
    )) as { status: string; outputJson?: string };

    expect(added.status).toBe("pass");
    expect(added.outputJson).toBe(JSON.stringify({ token: "sk-live-9d3f0a1b" }));
  });

  it("proceeds when a plaintext env value equals a value in the secret chain", async () => {
    await write(".argent/secrets.env", "SHARED=https://api.example.com\n");
    await write("scripts/probe.mjs", reporter("plain", ["FROM_FILE", "FROM_RUN", "FROM_STEP"]));
    await flow(
      "plain",
      "env: { FROM_FILE: https://api.example.com }\n" +
        "steps:\n" +
        "  - script:\n" +
        "      path: ../../scripts/probe.mjs\n" +
        "      env: { FROM_STEP: https://api.example.com }\n"
    );

    const { result } = await runFlow("plain", { env: { FROM_RUN: "https://api.example.com" } });

    expect(result.ok).toBe(true);
    expect(seen("plain")).toEqual({
      FROM_FILE: "https://api.example.com",
      FROM_RUN: "https://api.example.com",
      FROM_STEP: "https://api.example.com",
    });
  });
});

describe("recording a script step with env", () => {
  it("runs the live script under a header written back after the reset", async () => {
    await write("scripts/dump.mjs", reporter("kept", ["PLAIN"]));
    await flow(
      "qa",
      "env:\n" +
        "  PLAIN: checked-in-default\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/dump.mjs }\n"
    );

    const started = (await flowStartRecordingTool.execute(
      {},
      { name: "qa", project_root: root }
    )) as { message: string; flowFile: string };

    expect(started.flowFile).toBe("steps: []\n");
    expect(started.message).toBe('Started recording "qa" flow');

    await fs.writeFile(
      path.join(root, ".argent/flows/qa.yaml"),
      "env:\n  PLAIN: checked-in-default\nsteps: []\n",
      "utf8"
    );

    const added = (await flowAddScriptTool.execute(
      {},
      { name: "qa", project_root: root, path: "../../scripts/dump.mjs" }
    )) as { status: string };

    expect(added.status).toBe("pass");
    expect(seen("kept")).toEqual({ PLAIN: "checked-in-default" });
  });

  it("tells a gone, an unreadable and a malformed flow file apart", async () => {
    await write("scripts/dump.mjs", reporter("branches", ["A"]));
    await flowStartRecordingTool.execute({}, { name: "gone", project_root: root });
    const gonePath = path.join(root, ".argent/flows/gone.yaml");
    await fs.rm(gonePath);

    await expect(
      flowAddScriptTool.execute(
        {},
        { name: "gone", project_root: root, path: "../../scripts/dump.mjs" }
      )
    ).rejects.toThrow(/is gone\..*Start the recording again/s);

    await flowStartRecordingTool.execute({}, { name: "broken", project_root: root });
    const brokenPath = path.join(root, ".argent/flows/broken.yaml");
    await fs.writeFile(brokenPath, "steps:\n  - script: { path: x.mjs, env: { A: 3 } }\n", "utf8");

    await expect(
      flowAddScriptTool.execute(
        {},
        { name: "broken", project_root: root, path: "../../scripts/dump.mjs" }
      )
    ).rejects.toThrow(/is not a flow argent can use as it stands/);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable flow file as unreadable, not as malformed",
    async () => {
      await write("scripts/dump.mjs", reporter("locked", ["A"]));
      await flowStartRecordingTool.execute({}, { name: "locked", project_root: root });
      const lockedPath = path.join(root, ".argent/flows/locked.yaml");
      await fs.chmod(lockedPath, 0o000);
      try {
        await expect(
          flowAddScriptTool.execute(
            {},
            {
              name: "locked",
              project_root: root,
              path: "../../scripts/dump.mjs",
            }
          )
        ).rejects.toThrow(/could not be read\..*Make the file readable/s);
      } finally {
        await fs.chmod(lockedPath, 0o644);
      }
    }
  );

  it("layers the file's env under the call's, and records the call's map", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write(
      "scripts/seed.mjs",
      reporter("recorded", ["API_URL", "USER_TYPE", "API_KEY"]) + "\noutput.ok = true;"
    );
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: root });
    const filePath = path.join(root, ".argent/flows/rec.yaml");
    await fs.writeFile(
      filePath,
      "env:\n  API_URL: https://api.example.com\n  USER_TYPE: from-file\nsteps: []\n",
      "utf8"
    );

    const added = (await flowAddScriptTool.execute(
      {},
      {
        name: "rec",
        project_root: root,
        path: "../../scripts/seed.mjs",
        env: { USER_TYPE: "premium", API_KEY: "{{secret:API_KEY}}" },
      }
    )) as { status: string; message: string };

    expect(added.status).toBe("pass");
    expect(added.message).toBe('Added script step to "rec" flow.');
    expect(seen("recorded")).toEqual({
      API_URL: "https://api.example.com",
      USER_TYPE: "premium",
      API_KEY: "sk-live-9d3f0a1b",
    });

    const finished = (await flowFinishRecordingTool.execute(
      {},
      { name: "rec", project_root: root }
    )) as { flowFile: string; summary: string[] };

    expect(finished.flowFile).toContain("{{secret:API_KEY}}");
    expect(finished.flowFile).not.toContain("sk-live-9d3f0a1b");
  });

  it("redacts a failure the recorded script raised, exactly as a replay would", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write(
      "scripts/fail.mjs",
      `throw new Error("401 from " + process.env.API_URL + " for key " + process.env.API_KEY);`
    );
    await flowStartRecordingTool.execute({}, { name: "recfail", project_root: root });
    await fs.writeFile(
      path.join(root, ".argent/flows/recfail.yaml"),
      "env: { API_URL: https://api.example.com }\nsteps: []\n",
      "utf8"
    );

    const failed = (await flowAddScriptTool.execute(
      {},
      {
        name: "recfail",
        project_root: root,
        path: "../../scripts/fail.mjs",
        env: { API_KEY: "{{secret:API_KEY}}" },
      }
    )) as { status: string; reason?: string; stepCount: number };

    expect(failed.status).toBe("fail");
    expect(failed.reason).not.toContain("sk-live-9d3f0a1b");
    expect(failed.reason).toContain("401 from https://api.example.com for key {{secret:API_KEY}}");
    expect(failed.stepCount).toBe(0);
  });

  it("withdraws the layering promise when the file's env changed during the run", async () => {
    const filePath = path.join(root, ".argent/flows/drift.yaml");
    await write(
      "scripts/edit.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(filePath)}, "env: { LATER: added }\\nsteps: []\\n");\n` +
        `output.ok = true;`
    );
    await flowStartRecordingTool.execute({}, { name: "drift", project_root: root });
    await fs.writeFile(filePath, "env: { EARLY: original }\nsteps: []\n", "utf8");

    const added = (await flowAddScriptTool.execute(
      {},
      { name: "drift", project_root: root, path: "../../scripts/edit.mjs" }
    )) as { status: string; message: string };

    expect(added.status).toBe("pass");
    expect(added.message).toContain("the flow file's own `env` changed while the script");
    expect(added.message).toContain("it ran with env EARLY");
    expect(added.message).toContain("will replay with env LATER");
    expect(added.message).toContain("would append a SECOND one");
  });

  it("shows the recorded env in the step summary", async () => {
    await write("scripts/seed.mjs", "output.ok = true;");
    await flowStartRecordingTool.execute({}, { name: "summary", project_root: root });

    const added = (await flowAddScriptTool.execute(
      {},
      {
        name: "summary",
        project_root: root,
        path: "../../scripts/seed.mjs",
        env: { USER_TYPE: "premium" },
      }
    )) as { recorded: string };

    expect(added.recorded).toBe('1. script: ../../scripts/seed.mjs env {"USER_TYPE":"premium"}');

    const finished = (await flowFinishRecordingTool.execute(
      {},
      { name: "summary", project_root: root }
    )) as { summary: string[] };

    expect(finished.summary).toEqual([
      '1. script: ../../scripts/seed.mjs env {"USER_TYPE":"premium"}',
    ]);
  });

  it("reads a case-only rename as drift on POSIX and as no change on Windows", async () => {
    const filePath = path.join(root, ".argent/flows/casedrift.yaml");
    await write(
      "scripts/recase.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(filePath)}, "env: { PATHY: /a }\\nsteps: []\\n");\n` +
        `output.ok = true;`
    );

    const drift = async (platform: NodeJS.Platform): Promise<string> => {
      const real = process.platform;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      try {
        await flowStartRecordingTool.execute({}, { name: "casedrift", project_root: root });
        await fs.writeFile(filePath, "env: { Pathy: /a }\nsteps: []\n", "utf8");
        const added = (await flowAddScriptTool.execute(
          {},
          { name: "casedrift", project_root: root, path: "../../scripts/recase.mjs" }
        )) as { message: string };
        return added.message;
      } finally {
        Object.defineProperty(process, "platform", { value: real, configurable: true });
        await flowFinishRecordingTool.execute({}, { name: "casedrift", project_root: root });
      }
    };

    expect(await drift("linux")).toContain("changed while the script");
    expect(await drift("win32")).not.toContain("changed while the script");
  });

  it("says which way the drift went when the names did not change", async () => {
    const filePath = path.join(root, ".argent/flows/valuedrift.yaml");
    await write(
      "scripts/edit.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(filePath)}, "env: { A: after }\\nsteps: []\\n");\n` +
        `output.ok = true;`
    );
    await flowStartRecordingTool.execute({}, { name: "valuedrift", project_root: root });
    await fs.writeFile(filePath, "env: { A: before }\nsteps: []\n", "utf8");

    const added = (await flowAddScriptTool.execute(
      {},
      { name: "valuedrift", project_root: root, path: "../../scripts/edit.mjs" }
    )) as { status: string; message: string };

    expect(added.status).toBe("pass");
    expect(added.message).toContain("it ran with env A and the recorded step will replay with");
    expect(added.message).toContain("those same names, at least one of them carrying a different");
  });

  it("treats an empty env map and no env key as the same environment", async () => {
    const filePath = path.join(root, ".argent/flows/emptyenv.yaml");
    await write(
      "scripts/edit.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(filePath)}, "steps: []\\n");\n` +
        `output.ok = true;`
    );
    await flowStartRecordingTool.execute({}, { name: "emptyenv", project_root: root });
    await fs.writeFile(filePath, "env: {}\nsteps: []\n", "utf8");

    const added = (await flowAddScriptTool.execute(
      {},
      { name: "emptyenv", project_root: root, path: "../../scripts/edit.mjs" }
    )) as { status: string; message: string };

    expect(added.status).toBe("pass");
    expect(added.message).toBe('Added script step to "emptyenv" flow.');
  });

  it("stays quiet when a concurrent edit touched everything but env", async () => {
    const filePath = path.join(root, ".argent/flows/otheredit.yaml");
    await write(
      "scripts/edit.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(filePath)}, "env: { A: same }\\nexecutionPrerequisite: Settings open\\nsteps: []\\n");\n` +
        `output.ok = true;`
    );
    await flowStartRecordingTool.execute({}, { name: "otheredit", project_root: root });
    await fs.writeFile(filePath, "env: { A: same }\nsteps: []\n", "utf8");

    const added = (await flowAddScriptTool.execute(
      {},
      { name: "otheredit", project_root: root, path: "../../scripts/edit.mjs" }
    )) as { status: string; message: string };

    expect(added.status).toBe("pass");
    expect(added.message).toBe('Added script step to "otheredit" flow.');
  });

  it("stays quiet when the step's own env provably shadows the change", async () => {
    const filePath = path.join(root, ".argent/flows/shadow.yaml");
    await write(
      "scripts/edit.mjs",
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(filePath)}, "env: { A: flow-two }\\nsteps: []\\n");\n` +
        `output.ok = true;`
    );
    await flowStartRecordingTool.execute({}, { name: "shadow", project_root: root });
    await fs.writeFile(filePath, "env: { A: flow-one }\nsteps: []\n", "utf8");

    const added = (await flowAddScriptTool.execute(
      {},
      {
        name: "shadow",
        project_root: root,
        path: "../../scripts/edit.mjs",
        env: { A: "step-wins" },
      }
    )) as { status: string; message: string };

    expect(added.status).toBe("pass");
    expect(added.message).toBe('Added script step to "shadow" flow.');
  });

  it("replays a recorded step under a run-time env, over the file's own default", async () => {
    await write("scripts/probe.mjs", reporter("replayed", ["FROM_FILE", "FROM_STEP"]));
    await flowStartRecordingTool.execute({}, { name: "roundtrip", project_root: root });
    await fs.writeFile(
      path.join(root, ".argent/flows/roundtrip.yaml"),
      "env: { FROM_FILE: file-default }\nsteps: []\n",
      "utf8"
    );

    await flowAddScriptTool.execute(
      {},
      {
        name: "roundtrip",
        project_root: root,
        path: "../../scripts/probe.mjs",
        env: { FROM_STEP: "step-value" },
      }
    );
    expect(seen("replayed")).toEqual({ FROM_FILE: "file-default", FROM_STEP: "step-value" });
    await flowFinishRecordingTool.execute({}, { name: "roundtrip", project_root: root });

    const { result } = await runFlow("roundtrip", {
      env: { FROM_FILE: "from-run", FROM_STEP: "from-run" },
    });

    expect(result.ok).toBe(true);
    expect(seen("replayed")).toEqual({ FROM_FILE: "from-run", FROM_STEP: "step-value" });
  });

  it("proceeds when flow-add-script is given a plaintext value equal to a secret", async () => {
    await write(".argent/secrets.env", "SHARED=https://api.example.com\n");
    await write("scripts/plain.mjs", reporter("recplain", ["API_URL"]));
    await flowStartRecordingTool.execute({}, { name: "recplain", project_root: root });

    const added = (await flowAddScriptTool.execute(
      {},
      {
        name: "recplain",
        project_root: root,
        path: "../../scripts/plain.mjs",
        env: { API_URL: "https://api.example.com" },
      }
    )) as { status: string; message: string };

    expect(added.status).toBe("pass");
    expect(added.message).toBe('Added script step to "recplain" flow.');
    expect(seen("recplain")).toEqual({ API_URL: "https://api.example.com" });

    const finished = (await flowFinishRecordingTool.execute(
      {},
      { name: "recplain", project_root: root }
    )) as { flowFile: string };
    expect(finished.flowFile).toContain("https://api.example.com");
  });

  it("caps a long env value in what the recorder echoes back", async () => {
    const huge = "s".repeat(10_054);
    await write("scripts/big.mjs", "output.ok = true;");
    await flowStartRecordingTool.execute({}, { name: "bigenv", project_root: root });

    const added = (await flowAddScriptTool.execute(
      {},
      {
        name: "bigenv",
        project_root: root,
        path: "../../scripts/big.mjs",
        env: { SERVICE_ACCOUNT_JSON: huge },
      }
    )) as { recorded: string };
    const finished = (await flowFinishRecordingTool.execute(
      {},
      { name: "bigenv", project_root: root }
    )) as { summary: string[]; flowFile: string };

    expect(added.recorded.length).toBeLessThan(400);
    expect(added.recorded).toContain("…(+9881 chars)");
    expect(finished.summary.join("\n").length).toBeLessThan(400);
    expect(finished.flowFile).toContain(huge);
  });

  it("proceeds when a run-time env value equals a secret's value", async () => {
    await write(".argent/secrets.env", "SHARED=https://api.example.com\n");
    await write("scripts/runplain.mjs", reporter("runplain", ["API_URL"]));
    await flow("runplain", "steps:\n  - script: { path: ../../scripts/runplain.mjs }\n");

    const { result } = await runFlow("runplain", {
      env: { API_URL: "https://api.example.com" },
    });

    expect(result.ok).toBe(true);
    expect(seen("runplain")).toEqual({ API_URL: "https://api.example.com" });
    expect(JSON.stringify(result.steps[0])).not.toContain("{{secret:");
  });

  it("returns a recorded env map verbatim, plaintext and placeholder alike", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write("scripts/seed.mjs", "output.ok = true;");
    await flowStartRecordingTool.execute({}, { name: "verbatim", project_root: root });
    await flowAddScriptTool.execute(
      {},
      {
        name: "verbatim",
        project_root: root,
        path: "../../scripts/seed.mjs",
        env: { API_URL: "https://example.com", API_KEY: "{{secret:API_KEY}}" },
      }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "verbatim", project_root: root, message: "Calling https://example.com" }
    );

    const finished = (await flowFinishRecordingTool.execute(
      {},
      { name: "verbatim", project_root: root }
    )) as { flowFile: string; summary: string[] };

    expect(finished.flowFile).toContain("https://example.com");
    expect(finished.flowFile).toContain("{{secret:API_KEY}}");
    expect(finished.summary.join("\n")).toContain("https://example.com");
    expect(finished.summary.join("\n")).toContain("{{secret:API_KEY}}");
    expect(finished.summary.join("\n")).not.toContain("sk-live-9d3f0a1b");
    expect(finished.summary.join("\n")).not.toContain("…");
  });
});
