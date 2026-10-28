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

function e2ePath(name: string): string {
  return path.join(root, ".argent", "e2e", `${name}.yaml`);
}

function flow(name: string, yaml: string): Promise<string> {
  return write(path.join(".argent", "e2e", `${name}.yaml`), yaml);
}

/** A flow of one step that runs `scripts/<script>`, with `env` as the step's own map. */
function scriptFlow(name: string, script: string, env?: string): Promise<string> {
  const stepEnv = env ? `, env: ${env}` : "";
  return flow(name, `steps:\n  - script: { path: ../../scripts/${script}${stepEnv} }\n`);
}

function markPath(mark: string): string {
  return path.join(root, `${mark}.mark`);
}

/** Forward slashes: a Windows path in a bash double-quoted string is a run of escapes. */
function shellMarkPath(mark: string): string {
  return markPath(mark).replace(/\\/g, "/");
}

function printenv(name: string, mark: string): string {
  return `printenv ${name} > "${shellMarkPath(mark)}"\n`;
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

/** The reason of a flow's first step, run without a device. */
async function firstReason(name: string): Promise<string> {
  return (await runFlow(name)).result.steps[0].reason ?? "";
}

type Added = {
  status: string;
  message: string;
  reason?: string;
  recorded: string;
  stepCount: number;
  outputJson?: string;
};

type Finished = { message: string; flowFile: string; summary: string[] };

/** Starts a recording, then replaces the reset file with `header` when given. */
async function startRecording(name: string, header?: string) {
  const started = (await flowStartRecordingTool.execute({}, { name, project_root: root })) as {
    message: string;
    flowFile: string;
  };
  if (header !== undefined) await fs.writeFile(e2ePath(name), header, "utf8");
  return started;
}

function addScript(name: string, script: string, env?: Record<string, string>): Promise<Added> {
  return flowAddScriptTool.execute({}, {
    name,
    project_root: root,
    path: `../../scripts/${script}`,
    ...(env ? { env } : {}),
  } as never) as Promise<Added>;
}

function finishRecording(name: string): Promise<Finished> {
  return flowFinishRecordingTool.execute({}, { name, project_root: root }) as Promise<Finished>;
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
  const fileEnv = (env: string) => `env: ${env}\nsteps:\n  - echo: hi\n`;
  const stepEnv = (env: string) =>
    `steps:\n  - script: { path: ../../scripts/probe.mjs, env: ${env} }\n`;
  const noEnv = "steps:\n  - echo: hi\n";

  const STEERS = /steers the runner's own process/;
  const TEMPLATE = /env.X` uses unsupported template syntax/;

  it.each<[string, string, RegExp]>([
    ["a reserved name", fileEnv("{ NODE_OPTIONS: --inspect }"), /NODE_OPTIONS/],
    ["a step's reserved name", stepEnv("{ ELECTRON_RUN_AS_NODE: '1' }"), /ELECTRON_RUN_AS_NODE/],
    ["ARGENT_OUTPUT", fileEnv("{ ARGENT_OUTPUT: /tmp/x }"), /ARGENT_OUTPUT/],
    ["a step's ARGENT_OUTPUT", stepEnv("{ ARGENT_OUTPUT: /tmp/y }"), /ARGENT_OUTPUT/],
    ["npm's dashed spelling", fileEnv('{ "npm_config_node-options": x }'), STEERS],
    ["npm's underscored spelling", fileEnv('{ "npm_config_node_options": x }'), STEERS],
    ["npm's upper-case spelling", fileEnv('{ "NPM_CONFIG_NODE_OPTIONS": x }'), STEERS],
    ["a !!omap", fileEnv("!!omap\n  - A: one"), /a Map \(`!!omap`\).*plain map/s],
    ["a !!set", fileEnv("!!set\n  ? A"), /a Set \(`!!set`\).*plain map/s],
    ["a !!timestamp", fileEnv("!!timestamp 2020-01-01"), /a Date \(`!!timestamp`\).*plain map/s],
    ["a number", fileEnv("{ RETRIES: 3 }"), /an environment carries strings only/],
    ["a name that is not one", fileEnv('{ "2FA": x }'), /not an environment variable name/],
    ["a NUL character", stepEnv('{ TOK: "a\\0b" }'), /holds a NUL character in the value of TOK/],
    [
      "a lone surrogate",
      stepEnv('{ LONE: "\\uD800abc" }'),
      /script `env` holds an unpaired surrogate in the value of LONE/,
    ],
    ["{{output:}}", fileEnv('{ X: "{{output:user.id}}" }'), TEMPLATE],
    ["a step's {{output:}}", stepEnv('{ X: "{{output:user.id}}" }'), TEMPLATE],
    ["__proto__", fileEnv("{ __proto__: x }"), /__proto__/],
  ])("refuses %s in a flow's env before the run starts", async (_case, yaml, error) => {
    await write("scripts/probe.mjs", "");
    await flow("bad", yaml);

    await expect(runFlow("bad")).rejects.toThrow(error);
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ["a reserved name", { NODE_CHANNEL_FD: "9" }, /NODE_CHANNEL_FD/],
    [
      "{{output:}}",
      { X: "{{output:user.id}}" },
      /This run's `env.X` uses unsupported template syntax/,
    ],
    [
      "__proto__",
      JSON.parse('{"__proto__":"x","A":"y"}') as Record<string, string>,
      /`env` holds __proto__/,
    ],
  ])("refuses %s in the run's env", async (_case, env, error) => {
    await flow("ok", noEnv);

    await expect(runFlow("ok", { env })).rejects.toThrow(error);
  });

  it("refuses a bad run-time env as the caller's input, not a file's fault", async () => {
    // `argent e2e run <dir>` stops the batch on this code instead of failing every file.
    await write(".argent/secrets.env", "KNOWN=value\n");
    await flow("ok", noEnv);

    for (const [env, error] of [
      [{ ARGENT_OUTPUT: "/tmp/z" }, /ARGENT_OUTPUT/],
      [{ AUTH: "{{secret:MISSING}}" }, /This run's env value AUTH.*Unknown secret "MISSING"/s],
    ] as const) {
      const refused = runFlow("ok", { env });
      await expect(refused).rejects.toThrow(error);
      expect(getFailureSignal(await refused.catch((e: unknown) => e))?.error_code).toBe(
        FAILURE_CODES.TOOL_INPUT_INVALID
      );
    }
  });

  it("refuses a reserved name in a nested fragment's own env, mid-run", async () => {
    await write("scripts/probe.mjs", "");
    await flow("outer", "steps:\n  - echo: before\n  - run: inner.yaml\n");
    await flow(
      "inner",
      "env: { ARGENT_OUTPUT: /tmp/x }\nsteps:\n  - script: { path: ../../scripts/probe.mjs }\n"
    );

    const { result } = await runFlow("outer", {}, { booted: true });

    expect(result.ok).toBe(false);
    expect(result.steps[0].status).toBe("pass");
    expect(JSON.stringify(result.steps)).toContain("ARGENT_OUTPUT");
  });

  it("passes ARGENT_REASON to the script like any other name, in every env channel", async () => {
    for (const mark of ["file", "step", "fragment"]) {
      await write(`scripts/${mark}.mjs`, reporter(mark, ["ARGENT_REASON"]));
    }
    await flow(
      "reason",
      "env: { ARGENT_REASON: from-file }\n" +
        "steps:\n" +
        "  - script: { path: ../../scripts/file.mjs }\n" +
        "  - script: { path: ../../scripts/step.mjs, env: { ARGENT_REASON: from-step } }\n" +
        "  - run: fragment.yaml\n"
    );
    await flow(
      "fragment",
      "env: { ARGENT_REASON: from-fragment }\nsteps:\n  - script: { path: ../../scripts/fragment.mjs }\n"
    );

    expect((await runFlow("reason", {}, { booted: true })).result.ok).toBe(true);
    expect(seen("file")).toEqual({ ARGENT_REASON: "from-file" });
    expect(seen("step")).toEqual({ ARGENT_REASON: "from-step" });
    expect(seen("fragment")).toEqual({ ARGENT_REASON: "from-fragment" });

    const runTime = await runFlow(
      "reason",
      { env: { ARGENT_REASON: "from-run" } },
      { booted: true }
    );
    expect(runTime.result.ok).toBe(true);
    expect(seen("file")).toEqual({ ARGENT_REASON: "from-run" });

    await startRecording("reason-rec");
    expect(
      (await addScript("reason-rec", "file.mjs", { ARGENT_REASON: "from-recording" })).status
    ).toBe("pass");
    expect(seen("file")).toEqual({ ARGENT_REASON: "from-recording" });
  });

  it("opens every flow-add-script env refusal with the two words the decision rule reads", async () => {
    await write("scripts/noop.mjs", "output.ok = true;");
    await startRecording("wording");
    for (const [env, fault] of [
      [{ NODE_OPTIONS: "--inspect" }, "holds NODE_OPTIONS"],
      [{ ARGENT_OUTPUT: "/tmp/w" }, "holds ARGENT_OUTPUT"],
      [{ "not a name": "x" }, "is not an environment variable name"],
      [{ A: "{{output:x}}" }, "`env.A` uses unsupported template syntax"],
      [JSON.parse('{"__proto__":"x","A":"y"}') as Record<string, string>, "holds __proto__"],
    ] as const) {
      const refused = await addScript("wording", "noop.mjs", env).then(
        () => "",
        (err: unknown) => (err instanceof Error ? err.message : String(err))
      );
      expect(refused, JSON.stringify(env)).toMatch(/^This call's `env/);
      expect(refused).toContain(fault);
      expect(refused).not.toContain("was NOT run and nothing was recorded");
    }
  });
});

describe("serialization", () => {
  /** Records a `gesture-tap` step through flow-add-step. */
  function addTap(name: string) {
    return createFlowAddStepTool(mockRegistry({ booted: true }).registry).execute({}, {
      name,
      project_root: root,
      command: "gesture-tap",
      args: JSON.stringify({ udid: DEVICE, x: 0.5, y: 0.5 }),
    } as never);
  }

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

  it("keeps a folded value's spaces through the round trip", () => {
    // A minimized value whose fold, between an escaped space and newline, once ate the space.
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

  it("keeps `env` through an echo and a flow-add-step append", async () => {
    await startRecording(
      "append",
      "env: { API_URL: https://example.com }\n" +
        "steps:\n" +
        "  - script: { path: seed.mjs, env: { USER_TYPE: premium } }\n"
    );

    await flowInsertEchoTool.execute(
      {},
      { name: "append", project_root: root, message: "appended" }
    );
    await addTap("append");

    const after = parseFlow(await fs.readFile(e2ePath("append"), "utf8"));
    expect(after.env).toEqual({ API_URL: "https://example.com" });
    expect(after.steps[0]).toEqual({
      kind: "script",
      path: "seed.mjs",
      env: { USER_TYPE: "premium" },
    });
    expect(after.steps[1]).toEqual({ kind: "echo", message: "appended" });
    expect(after.steps).toHaveLength(3);
  });

  const FILE_FAULTS = [
    ["reserved", 'env:\n  NODE_OPTIONS: "--inspect"\nsteps: []\n', /NODE_OPTIONS/],
    ["number", "env:\n  RETRIES: 5\nsteps: []\n", /RETRIES/],
    [
      "output-ref",
      'env:\n  TOKEN: "{{output:1.token}}"\nsteps: []\n',
      /unsupported template syntax/,
    ],
  ] as const;

  it("says the call already ran when the FILE's env refuses an echo or a step append", async () => {
    for (const [name, header, fault] of FILE_FAULTS) {
      await startRecording(name, header);

      const echo = flowInsertEchoTool.execute({}, { name, project_root: root, message: "note" });
      await expect(echo).rejects.toThrow(
        /The echo was not recorded\..*already in the file, not in this call/s
      );
      await expect(echo).rejects.toThrow(fault);

      await expect(addTap(name)).rejects.toThrow(
        /call ran, but something already in the e2e test file failed validation/
      );
    }
  });

  it("says the script already ran when the FILE's env refuses its append", async () => {
    await write(
      "scripts/slow.mjs",
      "await new Promise((r) => setTimeout(r, 1200));\noutput.ok = true;"
    );
    for (const [name, header] of FILE_FAULTS) {
      await startRecording(name);

      const rejection = addScript(name, "slow.mjs");
      await new Promise((resolve) => setTimeout(resolve, 400));
      await fs.writeFile(e2ePath(name), header, "utf8");

      await expect(rejection).rejects.toThrow(/passed, but the step was not recorded/);
      await expect(rejection).rejects.toThrow(/already in the file, not in this script/);
      await expect(rejection).rejects.not.toThrow(/Check the script's changes before you retry/);
    }
  });
});

describe("the host allowlist extension", () => {
  const allow = (...names: unknown[]) => JSON.stringify({ scripts: { env: { allow: names } } });

  /** Runs one script step under a project config of `config`, and returns its note. */
  async function allowNote(config: string): Promise<string> {
    await write(".argent/config.json", config);
    await write("scripts/noop.mjs", "output.ok = true;");
    await scriptFlow("allow", "noop.mjs");
    const { result } = await runFlow("allow");
    expect(result.ok).toBe(true);
    return result.steps[0].reason ?? "";
  }

  it("adds a configured name and drops an ARGENT_ one in any case, naming it in a note", async () => {
    process.env.PROJECT_DB_URL = "postgres://fixture";
    process.env.ARGENT_AUTH_TOKEN = "host-token";
    process.env.Argent_Session = "host-session";
    try {
      const names = ["PROJECT_DB_URL", "ARGENT_AUTH_TOKEN", "Argent_Session"];
      await write(".argent/config.json", allow(...names));
      await write("scripts/probe.mjs", reporter("allow", names));
      await scriptFlow("allow", "probe.mjs");

      const { result } = await runFlow("allow");

      expect(result.ok).toBe(true);
      expect(seen("allow")).toEqual({
        PROJECT_DB_URL: "postgres://fixture",
        ARGENT_AUTH_TOKEN: null,
        Argent_Session: null,
      });
      expect(result.steps[0].reason).toContain("ARGENT_AUTH_TOKEN");
      expect(result.steps[0].reason).toContain("Argent_Session");
      expect(result.steps[0].reason).toContain("scripts.env.allow");
    } finally {
      delete process.env.PROJECT_DB_URL;
      delete process.env.ARGENT_AUTH_TOKEN;
      delete process.env.Argent_Session;
    }
  });

  it("reads the list from the global scope as well, and takes the union", async () => {
    process.env.FROM_GLOBAL_CFG = "global-value";
    process.env.FROM_PROJECT_CFG = "project-value";
    try {
      await write(".argent/config.json", allow("FROM_PROJECT_CFG"));
      await fs.mkdir(path.join(os.homedir(), ".argent"), { recursive: true });
      await fs.writeFile(
        path.join(os.homedir(), ".argent", "config.json"),
        allow("FROM_GLOBAL_CFG"),
        "utf8"
      );
      await write("scripts/probe.mjs", reporter("scopes", ["FROM_GLOBAL_CFG", "FROM_PROJECT_CFG"]));
      await scriptFlow("scopes", "probe.mjs");

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

  it("says which file lists a dropped name only when two are configured", async () => {
    const one = await allowNote(allow("NODE_OPTIONS"));
    expect(one).toContain("NODE_OPTIONS");
    expect(one).not.toContain("Listed in");

    const globalFile = path.join(os.homedir(), ".argent", "config.json");
    await fs.mkdir(path.dirname(globalFile), { recursive: true });
    await fs.writeFile(globalFile, allow("NODE_OPTIONS"), "utf8");
    expect(await allowNote(allow("PROJECT_OK"))).toContain(
      `Listed in ${globalFile.replace(/\\/g, "\\\\")}.`
    );
  });

  it("says a config file that does not parse lost everything in it", async () => {
    expect(await allowNote('{ "scripts": { "env": { "allow": ["DB_URL"] } } ,,, }')).toMatch(
      /is not valid JSON[\s\S]*read nothing from it at all/
    );
  });

  it("answers a reserved entry and an ARGENT_ one differently", async () => {
    const note = await allowNote(allow("NODE_OPTIONS", "npm_config_userconfig", "ARGENT_PORT"));

    expect(note).toContain(
      "names ARGENT_PORT, which argent keeps out of the copy it takes from its own environment"
    );
    expect(note).toContain(
      "names NODE_OPTIONS, npm_config_userconfig, which steer the runner's own process"
    );
    expect(note).toMatch(/ARGENT_PORT[\s\S]*under a name of your own/);
    expect(note).not.toMatch(/steer the runner's own process[\s\S]*under a name of your own/);
  });

  it("names a reserved npm spelling reserved, not malformed", async () => {
    const note = await allowNote(allow("npm_config_node-options"));

    expect(note).toContain("npm_config_node-options");
    expect(note).toContain("steers the runner's own process rather than reaching the script");
    expect(note).not.toContain("is not an environment variable name");
  });

  it("says so when scripts.env.allow is not a list", async () => {
    const note = await allowNote(JSON.stringify({ scripts: { env: { allow: "DATABASE_URL" } } }));

    expect(note).toContain("is not a list");
    expect(note).toContain('e.g. ["DATABASE_URL"]');
  });

  it("names a malformed entry and a __proto__ one apart", async () => {
    const note = await allowNote(allow("9LIVES", "__proto__"));

    expect(note).toContain('"9LIVES"');
    expect(note).toContain("is not an environment variable name");
    expect(note).toContain("__proto__, which argent cannot carry");
  });

  it("names an allowlist entry that is not a name at all", async () => {
    const note = await allowNote(allow("DB_URL", ["AWS_PROFILE", "AWS_REGION"], 42, ""));

    expect(note).toContain("scripts.env.allow");
    expect(note).toContain('["AWS_PROFILE","AWS_REGION"]');
    expect(note).toContain("42");
    expect(note).toContain("Those entries were ignored");
  });

  it("says a note once per run, not once per step", async () => {
    await write(".argent/config.json", allow("ARGENT_PORT"));
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
    expect(await firstReason("once")).toContain("ARGENT_PORT");
  });
});

describe("a bash step's environment", () => {
  it("sees every layer, a resolved secret and a value with a space through printenv", async (ctx) => {
    skipWithoutBash(ctx);
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write(
      "scripts/probe.sh",
      printenv("PROBE_FLOW", "flow") +
        printenv("PROBE_RUN", "run") +
        printenv("PROBE_STEP", "step") +
        printenv("API_KEY", "secret")
    );
    await write(
      "scripts/frag.sh",
      printenv("PROBE_FRAGMENT", "fragment") + printenv("PROBE_FLOW", "inherited")
    );
    await write("scripts/after.sh", printenv("PROBE_FRAGMENT", "after"));
    await flow(
      "sh",
      "env:\n" +
        "  PROBE_FLOW: from-flow\n" +
        "  PROBE_RUN: from-flow\n" +
        "  PROBE_STEP: from-flow\n" +
        "  PROBE_FRAGMENT: from-flow\n" +
        "steps:\n" +
        "  - script:\n" +
        "      path: ../../scripts/probe.sh\n" +
        '      env: { PROBE_STEP: from-step, API_KEY: "{{secret:API_KEY}}" }\n' +
        "  - run: sh-fragment.yaml\n" +
        "  - script: { path: ../../scripts/after.sh }\n"
    );
    await flow(
      "sh-fragment",
      "env: { PROBE_FRAGMENT: from-fragment }\nsteps:\n  - script: { path: ../../scripts/frag.sh }\n"
    );

    const { result } = await runFlow("sh", { env: { PROBE_RUN: "Bearer abc" } }, { booted: true });

    expect(result.ok).toBe(true);
    expect(readMark("flow")).toBe("from-flow\n");
    expect(readMark("run")).toBe("Bearer abc\n");
    expect(readMark("step")).toBe("from-step\n");
    expect(readMark("secret")).toBe("sk-live-9d3f0a1b\n");
    expect(readMark("fragment")).toBe("from-fragment\n");
    expect(readMark("inherited")).toBe("from-flow\n");
    expect(readMark("after")).toBe("from-flow\n");
  });
});

describe("secret placeholders in an env value", () => {
  async function writeProjectSecret(name: string, value: string): Promise<void> {
    await write(".argent/secrets.env", `${name}=${value}\n`);
  }

  it("resolves a step's and the run's secret against the project, not the server's cwd", async () => {
    expect(path.resolve(process.cwd()).startsWith(root)).toBe(false);
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\nRUN_TOKEN=sk-run-4b21\n");
    await write("scripts/probe.mjs", reporter("secret", ["API_KEY", "AUTH"]));
    await scriptFlow("secret", "probe.mjs", '{ API_KEY: "{{secret:API_KEY}}" }');

    const { result } = await runFlow("secret", { env: { AUTH: "{{secret:RUN_TOKEN}}" } });

    expect(result.ok).toBe(true);
    expect(seen("secret")).toEqual({ API_KEY: "sk-live-9d3f0a1b", AUTH: "sk-run-4b21" });
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
    await scriptFlow("sh-throws", "fail.sh", '{ API_KEY: "{{secret:API_KEY}}" }');

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
    await scriptFlow("tiny", "fail.mjs", '{ PIN: "{{secret:PIN}}" }');

    expect(await firstReason("tiny")).toContain("pin was {{secret:PIN}}");
  });

  it("errors the step on an unknown name in a flow's env, listing the names that resolve", async () => {
    await writeProjectSecret("KNOWN", "value");
    await write("scripts/probe.mjs", "");
    await scriptFlow("unknown", "probe.mjs", '{ X: "{{secret:MISSING}}" }');

    const { result } = await runFlow("unknown");

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toContain("env value X");
    expect(result.steps[0].reason).toContain('Unknown secret "MISSING"');
    expect(result.steps[0].reason).toContain("KNOWN");
  });

  it("refuses a resolved value an environment cannot carry, without quoting it", async () => {
    await write(".argent/secrets.env", 'NULKEY="sec\u0000ret-9d3f"\n');
    await write("scripts/noop.mjs", "output.ok = true;");
    await scriptFlow("nulsec", "noop.mjs", '{ TOK: "{{secret:NULKEY}}" }');

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
    await scriptFlow(
      "spelling",
      "probe.mjs",
      '{ A: "{{ secret: X }}", B: "{{SECRET:X}}", C: "{secret:X}" }'
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
  const NOTE = "A command was not found";

  /** The reason a .mjs step that throws `message` fails with. */
  async function reasonFor(message: string): Promise<string> {
    await write("scripts/throws.mjs", `throw new Error(${JSON.stringify(message)});`);
    await scriptFlow("throws", "throws.mjs");
    return firstReason("throws");
  }

  it("explains a command a .mjs could not find", async () => {
    await write(
      "scripts/missing.mjs",
      `import { execSync } from "node:child_process";\n` + `execSync("argent-no-such-command-xyz");`
    );
    await scriptFlow("notes", "missing.mjs");

    const reason = await firstReason("notes");

    expect(reason).toContain("A command was not found.");
    expect(reason).toContain("snapshot");
    expect(reason).toContain("`scripts.env.allow` cannot widen it");
  });

  it.each<[string, string, string?]>([
    ["Command failed: adb devices\n/bin/sh: 1: adb: not found\n", "A command was not found."],
    ["/tmp/run tests.sh: 3: adb: not found", "A command was not found."],
    ["sh: adb: command not found", "A command was not found."],
    ["/tmp/run.sh: line 3: adb: command not found", "A command was not found."],
    ["zsh:1: command not found: adb", "A command was not found."],
    [
      "Command failed: adb shell pm list packages\n/system/bin/sh: pm: command not found\n",
      "on the OTHER end in these same words",
    ],
    ["spawnSync adb ENOENT", "A command was not found — or the working directory", "OTHER end"],
  ])("reads a shell's or Node's wording in %j", async (message, expected, absent) => {
    const reason = await reasonFor(message);

    expect(reason).toContain(expected);
    if (absent) expect(reason).not.toContain(absent);
  });

  it.each([
    "fixture: users.json: not found",
    "fixtures/orders.json: 12: customerId: not found",
    "seed failed for api/v1/users: 404: user: not found",
    "tenant acme: seed: command not found",
    "tenant acme: command not found: seed",
    "could not spawn the seeder because the fixture directory is missing ENOENT",
  ])("leaves an application error alone: %j", async (message) => {
    const reason = await reasonFor(message);

    expect(reason).toContain(message);
    expect(reason).not.toContain(NOTE);
    expect(reason).not.toContain("tool server");
    expect(reason).not.toContain("snapshot");
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

    const reason = await firstReason("own-path");

    expect(reason).toContain("A command was not found.");
    expect(reason).toContain("This run sets `PATH` itself");
    expect(reason).not.toContain("/nonexistent/bin");
    expect(reason).not.toContain("Restart the tool server");
    expect(reason).not.toContain("snapshot");
  });

  const KEEPS_ENV = "The tool server keeps the environment it started with";

  it.for<[string, string, string[], string[]]>([
    [
      "the shell's own wording, without the runner's hint again",
      `argent-no-such-command-xyz\n`,
      ["argent-no-such-command-xyz: command not found", KEEPS_ENV],
      ["A command was not found."],
    ],
    [
      "a line naming the script by a Windows path",
      `echo "C:/Users/dev/project/scripts/x.sh: line 1: adb: command not found" >&2\nexit 127\n`,
      [KEEPS_ENV],
      [],
    ],
    [
      "a .sh that chose 127 and explained itself",
      `echo "no such tenant" >&2\nexit 127\n`,
      ["no such tenant"],
      [KEEPS_ENV],
    ],
  ])("reads exit 127 from %s", async ([, script, expected, absent], ctx) => {
    skipWithoutBash(ctx);
    await write("scripts/x.sh", script);
    await scriptFlow("sh-127", "x.sh");

    const reason = await firstReason("sh-127");

    expect(reason).toContain("exited with code 127");
    for (const text of expected) expect(reason).toContain(text);
    for (const text of absent) expect(reason).not.toContain(text);
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
    await startRecording("document");

    const added = await addScript("document", "doc.mjs", { API_KEY: "{{secret:API_KEY}}" });

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
    expect(JSON.stringify(result.steps[0])).not.toContain("{{secret:");
  });
});

describe("recording a script step with env", () => {
  it("runs the live script under a header written back after the reset", async () => {
    await write("scripts/dump.mjs", reporter("kept", ["PLAIN"]));
    await flow(
      "qa",
      "env:\n  PLAIN: checked-in-default\nsteps:\n  - script: { path: ../../scripts/dump.mjs }\n"
    );

    const started = await startRecording("qa");

    expect(started.flowFile).toBe("steps: []\n");
    expect(started.message).toBe('Started recording "qa" e2e test');

    await fs.writeFile(e2ePath("qa"), "env:\n  PLAIN: checked-in-default\nsteps: []\n", "utf8");

    expect((await addScript("qa", "dump.mjs")).status).toBe("pass");
    expect(seen("kept")).toEqual({ PLAIN: "checked-in-default" });
  });

  it("tells a gone and a malformed flow file apart", async () => {
    await write("scripts/dump.mjs", reporter("branches", ["A"]));
    await startRecording("gone");
    await fs.rm(e2ePath("gone"));

    await expect(addScript("gone", "dump.mjs")).rejects.toThrow(
      /is gone\..*Start the recording again/s
    );

    await startRecording("broken", "steps:\n  - script: { path: x.mjs, env: { A: 3 } }\n");

    await expect(addScript("broken", "dump.mjs")).rejects.toThrow(
      /is not an e2e test argent can use as it stands/
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable flow file as unreadable, not as malformed",
    async () => {
      await write("scripts/dump.mjs", reporter("locked", ["A"]));
      await startRecording("locked");
      await fs.chmod(e2ePath("locked"), 0o000);
      try {
        await expect(addScript("locked", "dump.mjs")).rejects.toThrow(
          /could not be read\..*Make the file readable/s
        );
      } finally {
        await fs.chmod(e2ePath("locked"), 0o644);
      }
    }
  );

  it("layers the file's env under the call's, and records the call's map", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write(
      "scripts/seed.mjs",
      reporter("recorded", ["API_URL", "USER_TYPE", "API_KEY"]) + "\noutput.ok = true;"
    );
    await startRecording(
      "rec",
      "env:\n  API_URL: https://api.example.com\n  USER_TYPE: from-file\nsteps: []\n"
    );

    const added = await addScript("rec", "seed.mjs", {
      USER_TYPE: "premium",
      API_KEY: "{{secret:API_KEY}}",
    });

    expect(added.status).toBe("pass");
    expect(added.message).toBe('Added script step to "rec" e2e test.');
    expect(seen("recorded")).toEqual({
      API_URL: "https://api.example.com",
      USER_TYPE: "premium",
      API_KEY: "sk-live-9d3f0a1b",
    });

    const finished = await finishRecording("rec");

    expect(finished.flowFile).toContain("{{secret:API_KEY}}");
    expect(finished.flowFile).not.toContain("sk-live-9d3f0a1b");
  });

  it("redacts a failure the recorded script raised, exactly as a replay would", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\n");
    await write(
      "scripts/fail.mjs",
      `throw new Error("401 from " + process.env.API_URL + " for key " + process.env.API_KEY);`
    );
    await startRecording("recfail", "env: { API_URL: https://api.example.com }\nsteps: []\n");

    const failed = await addScript("recfail", "fail.mjs", { API_KEY: "{{secret:API_KEY}}" });

    expect(failed.status).toBe("fail");
    expect(failed.reason).not.toContain("sk-live-9d3f0a1b");
    expect(failed.reason).toContain("401 from https://api.example.com for key {{secret:API_KEY}}");
    expect(failed.stepCount).toBe(0);
  });

  it("shows the recorded env in the step summary", async () => {
    await write("scripts/seed.mjs", "output.ok = true;");
    await startRecording("summary");

    const added = await addScript("summary", "seed.mjs", { USER_TYPE: "premium" });

    const line = '1. script: ../../scripts/seed.mjs env {"USER_TYPE":"premium"}';
    expect(added.recorded).toBe(line);
    expect((await finishRecording("summary")).summary).toEqual([line]);
  });

  /** Records a script that rewrites the recording's `before` header to `after` while it runs. */
  async function recordDrift(
    name: string,
    before: string,
    after: string,
    env?: Record<string, string>
  ): Promise<Added> {
    await write(
      `scripts/${name}.mjs`,
      `import fs from "node:fs";\n` +
        `fs.writeFileSync(${JSON.stringify(e2ePath(name))}, ${JSON.stringify(after)});\n` +
        `output.ok = true;`
    );
    await startRecording(name, before);
    return addScript(name, `${name}.mjs`, env);
  }

  it("withdraws the layering promise when the file's env changed during the run", async () => {
    const added = await recordDrift(
      "drift",
      "env: { EARLY: original }\nsteps: []\n",
      "env: { LATER: added }\nsteps: []\n"
    );

    expect(added.status).toBe("pass");
    expect(added.message).toContain("the e2e test file's own `env` changed while the script");
    expect(added.message).toContain("it ran with env EARLY");
    expect(added.message).toContain("will replay with env LATER");
    expect(added.message).toContain("would append a SECOND one");
  });

  it("says which way the drift went when the names did not change", async () => {
    const added = await recordDrift(
      "valuedrift",
      "env: { A: before }\nsteps: []\n",
      "env: { A: after }\nsteps: []\n"
    );

    expect(added.status).toBe("pass");
    expect(added.message).toContain("it ran with env A and the recorded step will replay with");
    expect(added.message).toContain("those same names, at least one of them carrying a different");
  });

  it("reads a case-only rename as drift on POSIX and as no change on Windows", async () => {
    const drift = async (platform: NodeJS.Platform): Promise<string> => {
      const real = process.platform;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      try {
        const added = await recordDrift(
          "casedrift",
          "env: { Pathy: /a }\nsteps: []\n",
          "env: { PATHY: /a }\nsteps: []\n"
        );
        return added.message;
      } finally {
        Object.defineProperty(process, "platform", { value: real, configurable: true });
        await finishRecording("casedrift");
      }
    };

    expect(await drift("linux")).toContain("changed while the script");
    expect(await drift("win32")).not.toContain("changed while the script");
  });

  it.each<[string, string, string, Record<string, string>?]>([
    ["an empty env map became no env key", "env: {}\nsteps: []\n", "steps: []\n"],
    [
      "an edit touched everything but env",
      "env: { A: same }\nsteps: []\n",
      "env: { A: same }\nexecutionPrerequisite: Settings open\nsteps: []\n",
    ],
    [
      "the step's own env shadows the change",
      "env: { A: flow-one }\nsteps: []\n",
      "env: { A: flow-two }\nsteps: []\n",
      { A: "step-wins" },
    ],
  ])("stays quiet when %s", async (_case, before, after, env) => {
    const added = await recordDrift("quiet", before, after, env);

    expect(added.status).toBe("pass");
    expect(added.message).toBe('Added script step to "quiet" e2e test.');
  });

  it("replays a recorded step under a run-time env, over the file's own default", async () => {
    await write("scripts/probe.mjs", reporter("replayed", ["FROM_FILE", "FROM_STEP"]));
    await startRecording("roundtrip", "env: { FROM_FILE: file-default }\nsteps: []\n");

    await addScript("roundtrip", "probe.mjs", { FROM_STEP: "step-value" });
    expect(seen("replayed")).toEqual({ FROM_FILE: "file-default", FROM_STEP: "step-value" });
    await finishRecording("roundtrip");

    const { result } = await runFlow("roundtrip", {
      env: { FROM_FILE: "from-run", FROM_STEP: "from-run" },
    });

    expect(result.ok).toBe(true);
    expect(seen("replayed")).toEqual({ FROM_FILE: "from-run", FROM_STEP: "step-value" });
  });

  it("records an env map verbatim, a plaintext value equal to a secret's included", async () => {
    await write(".argent/secrets.env", "API_KEY=sk-live-9d3f0a1b\nSHARED=https://example.com\n");
    await write("scripts/seed.mjs", reporter("verbatim", ["API_URL"]));
    await startRecording("verbatim");

    const added = await addScript("verbatim", "seed.mjs", {
      API_URL: "https://example.com",
      API_KEY: "{{secret:API_KEY}}",
    });
    await flowInsertEchoTool.execute(
      {},
      { name: "verbatim", project_root: root, message: "Calling https://example.com" }
    );
    const finished = await finishRecording("verbatim");

    expect(added.status).toBe("pass");
    expect(added.message).toBe('Added script step to "verbatim" e2e test.');
    expect(seen("verbatim")).toEqual({ API_URL: "https://example.com" });
    const summary = finished.summary.join("\n");
    expect(finished.flowFile).toContain("https://example.com");
    expect(finished.flowFile).toContain("{{secret:API_KEY}}");
    expect(summary).toContain("https://example.com");
    expect(summary).toContain("{{secret:API_KEY}}");
    expect(summary).not.toContain("sk-live-9d3f0a1b");
    expect(summary).not.toContain("…");
  });

  it("caps a long env value in what the recorder echoes back", async () => {
    const huge = "s".repeat(10_054);
    await write("scripts/big.mjs", "output.ok = true;");
    await startRecording("bigenv");

    const added = await addScript("bigenv", "big.mjs", { SERVICE_ACCOUNT_JSON: huge });
    const finished = await finishRecording("bigenv");

    expect(added.recorded.length).toBeLessThan(400);
    expect(added.recorded).toContain("…(+9881 chars)");
    expect(finished.summary.join("\n").length).toBeLessThan(400);
    expect(finished.flowFile).toContain(huge);
  });
});
