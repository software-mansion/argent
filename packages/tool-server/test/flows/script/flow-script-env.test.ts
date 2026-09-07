import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../../src/tools/flows/flow-insert-echo";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { flowFinishRecordingTool } from "../../../src/tools/flows/flow-finish-recording";
import { parseFlow, serializeFlow } from "../../../src/tools/flows/flow-utils";
import { resolveHostBash } from "../../helpers/host-bash";
import { scopeTempHome } from "../../helpers/temp-home";

/**
 * Environment values reaching a `script` step, through every channel that
 * supplies one: the flow file's own `env:`, a nested flow's, the `flow-execute`
 * run-time parameter, and the step's own map.
 *
 * Real child processes, hence the generous timeout. A script reports what it
 * read by writing a mark file — nothing a script prints is reported (PR 2.6)
 * and the output document is not threaded into a run until PR 4, so the
 * filesystem is the only channel a passing step has.
 */

vi.setConfig({ testTimeout: 30_000 });

// The secret chain and the project/global config scopes both resolve a home
// directory. Pointing it at a fresh one keeps a developer's own
// `~/.argent/secrets.env` and `~/.argent/config.json` out of these assertions.
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

/** A `.mjs` writing the named variables, as JSON, to `<mark>.mark`. */
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
  // `findProjectRoot` walks up for `.argent`, `.git` or `package.json`; the
  // flows directory establishes the first, so every project-scoped read in
  // these tests anchors here rather than at the tool server's own cwd.
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

    // A `run:` step resolves a device even when the only thing it composes is a
    // script, so this run is given one.
    const { result } = await runFlow(
      "outer",
      { env: { OVERRIDDEN: "from-run" } },
      { booted: true }
    );

    expect(result.ok).toBe(true);
    // A flow-level map is a DEFAULT at any depth, so the run-time value beats
    // even the innermost fragment's. A step map is not a default, so it wins.
    expect(seen("probe")).toEqual({
      ONLY_FLOW: "root-value",
      OVERRIDDEN: "from-run",
      FROM_STEP: "from-step",
    });
  });

  it("layers three nesting levels and restores each parent on the way out", async () => {
    // Depth 1 is the only nesting any case reached, and one level cannot tell
    // "the parent's map is restored" apart from "the child never had one of its
    // own". Each level here overrides the SAME name and probes it again after
    // the return, so a scope that leaked would be read.
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
    // `execSteps` runs a guarded block's children under `childScope`, and the
    // environment survives that hop only by the spread inside it. No case put a
    // script in a `when:` block, so nothing read what the block's children get.
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
    // The half of `flow-add-script`'s description that says a parent flow's
    // `env:` is another DEFAULT: a fragment composed by a parent overrides it
    // inside itself, so the recorded step runs under the fragment's value.
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
    // That step starts a separate root run with its own environment. Passing
    // the parent's invisibly would make a fragment's behaviour depend on which
    // of the two composition spellings reached it.
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
    // `!!omap`, `!!set` and `!!timestamp` resolve to a Map, a Set and a Date:
    // an object, not an array, and holding no entries `Object.entries` can see.
    // Left to the walk each reports zero problems, the script runs with none of
    // the author's values, and the next recorded step serializes it back as
    // `env: {}` — deleting them from the file. None of the three had a case.
    await flow("omap", "env: !!omap\n  - A: one\nsteps:\n  - echo: hi\n");
    await expect(runFlow("omap")).rejects.toThrow(/a Map \(`!!omap`\).*plain map/s);

    await flow("set", "env: !!set\n  ? A\nsteps:\n  - echo: hi\n");
    await expect(runFlow("set")).rejects.toThrow(/a Set \(`!!set`\).*plain map/s);

    await flow("stamp", "env: !!timestamp 2020-01-01\nsteps:\n  - echo: hi\n");
    await expect(runFlow("stamp")).rejects.toThrow(/a Date \(`!!timestamp`\).*plain map/s);
  });

  it("refuses a NUL character in an authored value, naming the key", async () => {
    // The operating system carries an environment as NUL-terminated strings, so
    // Node refuses the whole fork over one and the step would then error on a
    // message about the spawn rather than about the map that caused it.
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

  it("refuses ARGENT_OUTPUT and ARGENT_REASON in every env channel", async () => {
    // Reserved whichever language the step runs: a flow-level map applies to
    // every step, and these two name the files a `.sh` exchanges through.
    await flow("file-env", "env: { ARGENT_OUTPUT: /tmp/x }\nsteps:\n  - echo: hi\n");
    await expect(runFlow("file-env")).rejects.toThrow(/ARGENT_OUTPUT/);

    await write("scripts/probe.mjs", "");
    await flow(
      "step-env",
      "steps:\n  - script: { path: ../../scripts/probe.mjs, env: { ARGENT_REASON: /tmp/y } }\n"
    );
    await expect(runFlow("step-env")).rejects.toThrow(/ARGENT_REASON/);

    await flow("ok", "steps:\n  - echo: hi\n");
    await expect(runFlow("ok", { env: { ARGENT_OUTPUT: "/tmp/z" } })).rejects.toThrow(
      /ARGENT_OUTPUT/
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

  it("refuses a non-string value and an illegal name", async () => {
    await flow("numeric", "env: { RETRIES: 3 }\nsteps:\n  - echo: hi\n");
    await expect(runFlow("numeric")).rejects.toThrow(/an environment carries strings only/);

    await flow("named", 'env: { "2FA": x }\nsteps:\n  - echo: hi\n');
    await expect(runFlow("named")).rejects.toThrow(/not an environment variable name/);
  });

  it("refuses a {{output:...}} reference in every env channel", async () => {
    // The spelling belongs to a later release. Left alone it reaches the script
    // as literal text and the step PASSES, so a flow written against that
    // release would change behaviour under this one without a word.
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
    // `appendStep` reads the file, parses it, pushes the step and writes the
    // whole document back through `serializeFlow` — so a key missing from
    // `FlowFile` is deleted by the next recorded step, whatever the parser
    // accepted.
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

  it("keeps `env` through a serialize round trip", async () => {
    // `appendStep` rebuilds the whole document from `FlowFile`, so a key
    // missing from that type is deleted by the next recorded step.
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
  // `JSON.parse` puts `__proto__` on the object as an OWN property without
  // invoking the accessor, and `z.record` then rebuilds the map without it —
  // so the call passed with the entry silently gone, while
  // `argent flow run --env __proto__=v` refused the same name with a
  // paragraph. One CLI disagreeing with itself about one name.
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

  it("reads the list from the global scope as well, and takes the union", async () => {
    // The key is read from BOTH scopes because it names a project input rather
    // than a limit on the host, and the two are merged by union. `scopeTempHome`
    // puts the global file under a home of this test's own, so neither is the
    // developer's. Nothing pinned either half.
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

  it("answers a reserved entry and an ARGENT_ one differently", async () => {
    // The two are dropped for different reasons and have different remedies. A
    // name argent keeps out of its own copy can be passed under a name of the
    // project's own; `NODE_OPTIONS` steers the RUNNER, so it never reaches a
    // script whatever it is called and there is no such remedy. Said as one
    // sentence, each was told the other's story.
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
    // The remedy that exists for one of the two and not the other.
    expect(reason).toMatch(/ARGENT_PORT[\s\S]*under a name of your own/);
    expect(reason).not.toMatch(/steer the runner's own process[\s\S]*under a name of your own/);
  });

  it("says so when scripts.env.allow is not a list", async () => {
    // A value the key's parser cannot read comes back the way an UNSET key
    // does, so every script ran without the names and nothing said why.
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
    // `__proto__` satisfies the name rule to the letter, so it gets its own
    // answer rather than one stating a rule it plainly meets.
    expect(reason).toContain("__proto__, which argent cannot carry");
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
    // The configuration is the same for every step of the run.
    expect(result.steps[1].reason).toBeUndefined();

    // A LATER run says it again: the set is run-scoped, not module-scoped.
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

  it("carries a run-time value holding a space, whole, to both languages", async (ctx) => {
    skipWithoutBash(ctx);
    // The design brief's `--env "AUTH=Bearer abc"` case. The CLI's parse of the
    // joined argument is pinned in `argent-cli`, and the runner's layering is
    // pinned above, but nothing joined the two: a value with a space in it
    // reaching the SCRIPT is what the case is about, and a `.sh` is where a
    // split would show first.
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
    // `secretSources` walks up from `options.cwd ?? process.cwd()`. The tool
    // server's cwd is a snapshot from whatever spawned it — an editor sets it
    // to `/` or `$HOME` — so the chain has to be anchored at the run's project
    // or a project's own `.argent/secrets.env` is never found.
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
    // The stack rides into the reason as indented frames, so it is scrubbed on
    // the same pass; the plaintext URL is not a secret and reads as written.
    expect(reason).toContain("fail.mjs");
  });

  it("replaces the resolved value a .sh wrote into $ARGENT_REASON", async (ctx) => {
    skipWithoutBash(ctx);
    await writeProjectSecret("API_KEY", "sk-live-9d3f0a1b");
    await write(
      "scripts/fail.sh",
      `printf 'the call with %s failed' "$API_KEY" > "$ARGENT_REASON"\nexit 1\n`
    );
    await flow(
      "sh-throws",
      "steps:\n" +
        '  - script: { path: ../../scripts/fail.sh, env: { API_KEY: "{{secret:API_KEY}}" } }\n'
    );

    const { result } = await runFlow("sh-throws");

    const reason = result.steps[0].reason ?? "";
    expect(result.steps[0].status).toBe("fail");
    expect(reason).not.toContain("sk-live-9d3f0a1b");
    expect(reason).toContain("the call with {{secret:API_KEY}} failed");
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

  it("refuses an unpaired surrogate in an env value", async () => {
    // `describeScriptEnvProblem` refuses a NUL because an environment cannot
    // carry one; a lone surrogate is the same rule one character class further
    // out, and it was accepted. The flow file round-trips it exactly and the
    // child reads U+FFFD, so the file and the script disagreed with nothing
    // said.
    await write("scripts/noop.mjs", "output.ok = true;");
    await flow(
      "lone",
      "steps:\n" + '  - script: { path: ../../scripts/noop.mjs, env: { LONE: "\\uD800abc" } }\n'
    );

    // Refused where the map is read, like every other shape rule — the file is
    // not a flow argent can run.
    await expect(runFlow("lone")).rejects.toThrow(
      /script `env` holds an unpaired surrogate in the value of LONE/
    );
  });

  it("refuses a resolved value an environment cannot carry, without quoting it", async () => {
    // The NUL rule runs on the AUTHORED value, which is `{{secret:NULKEY}}` —
    // nothing of the secret's own shape. A NUL inside the resolved credential
    // reached Node, which refuses the fork and quotes the value back ESCAPED
    // (`Received 'sec\x00ret-9d3f'`); the scrub searches for the raw bytes, so
    // it found nothing and the credential was reported in the clear through the
    // very message the redaction exists for.
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
    // Only `{{secret:NAME}}` is a placeholder. Argent does not detect a near
    // spelling of it; a typo is the author's to find.
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
    // `command not found` points nowhere on its own: the command plainly exists
    // and works in the author's shell. What it does not say is that the tool
    // server's `PATH` is a snapshot from its first start.
    await write(
      "scripts/missing.mjs",
      `import { execSync } from "node:child_process";\n` + `execSync("argent-no-such-command-xyz");`
    );
    await write("scripts/fixture.mjs", `throw new Error("fixture: users.json: not found");`);
    // Two flows, because a failed step stops the run it is in.
    await flow("notes", "steps:\n  - script: { path: ../../scripts/missing.mjs }\n");
    await flow("unrelated", "steps:\n  - script: { path: ../../scripts/fixture.mjs }\n");

    const missing = (await runFlow("notes")).result;
    const unrelated = (await runFlow("unrelated")).result;

    expect(missing.steps[0].reason).toContain("A command was not found.");
    expect(missing.steps[0].reason).toContain("snapshot");
    expect(missing.steps[0].reason).toContain("`scripts.env.allow` cannot widen it");
    // A two-part application error has the words and is not a shell line: a step
    // that failed on a missing fixture must not end with a confident
    // instruction to restart the tool server.
    expect(unrelated.steps[0].reason).toContain("fixture: users.json: not found");
    expect(unrelated.steps[0].reason).not.toContain("A command was not found");
    expect(unrelated.steps[0].reason).not.toContain("snapshot");
  });

  it("reads dash's wording without reading a three-part application error", async () => {
    // dash writes `<writer>: <line>: <command>: not found`, and an application
    // that puts a PATH in front of its own line number writes the same four
    // fields — `fixtures/orders.json: 12: customerId: not found`. Script steps
    // exist to seed databases and read fixtures, so that is exactly where the
    // shape lives, and such a step must not end its verdict with a confident
    // instruction to restart the tool server. What dash writes in the first
    // field is the shell it is or the script it runs, so the name ends in `sh`.
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
    await flow("dash-line", "steps:\n  - script: { path: ../../scripts/dash.mjs }\n");
    await flow("three-part", "steps:\n  - script: { path: ../../scripts/three-part.mjs }\n");
    await flow("http-part", "steps:\n  - script: { path: ../../scripts/http-part.mjs }\n");

    const dash = (await runFlow("dash-line")).result;
    const threePart = (await runFlow("three-part")).result;
    const httpPart = (await runFlow("http-part")).result;

    expect(dash.steps[0].reason).toContain("A command was not found.");
    expect(threePart.steps[0].reason).toContain("fixtures/orders.json");
    expect(threePart.steps[0].reason).not.toContain("A command was not found");
    expect(threePart.steps[0].reason).not.toContain("tool server");
    expect(httpPart.steps[0].reason).not.toContain("A command was not found");
    expect(httpPart.steps[0].reason).not.toContain("tool server");
  });

  it("reads Node's own ENOENT spelling without reading a sentence holding the word", async () => {
    // Node writes ONE token, or a path that may hold spaces, between `spawn`
    // and `ENOENT` — never a sentence. Excluding `:`, `;` and `,` does not say
    // that on its own, since a sentence carries none of them either.
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

    // Node raises this for a missing COMMAND and for a `cwd` that does not
    // exist alike, so the note says both.
    expect(spawned.steps[0].reason).toContain("A command was not found — or the working directory");
    expect(sentence.steps[0].reason).toContain("fixture directory is missing");
    expect(sentence.steps[0].reason).not.toContain("A command was not found");
    expect(sentence.steps[0].reason).not.toContain("tool server");
  });

  it("names the run's own PATH when the run is what set it", async () => {
    // This feature gives a flow four ways to set `PATH`. When a command then
    // fails because THAT value is wrong, the snapshot note asserts the
    // opposite: it blames the tool server's start-time environment, tells the
    // author to restart the server — which changes nothing — and recommends
    // passing a path through `env`, which is what broke it.
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
    expect(reason).toContain("/nonexistent/bin");
    // The remedies that do not apply: the server's environment is not what the
    // command was looked up in, so restarting it changes nothing.
    expect(reason).not.toContain("Restart the tool server");
    expect(reason).not.toContain("snapshot");
  });

  it("reads exit 127 from a .sh without repeating the runner's own hint", async (ctx) => {
    skipWithoutBash(ctx);
    // A `.sh` says it in an exit code, not in words: its output is drained and
    // discarded, so the shell's own line never reaches this side. The runner's
    // 127 hint has already named the code, so the note adds only the remedy.
    await write("scripts/missing.sh", `argent-no-such-command-xyz\n`);
    await flow("sh-missing", "steps:\n  - script: { path: ../../scripts/missing.sh }\n");

    const { result } = await runFlow("sh-missing");

    const reason = result.steps[0].reason ?? "";
    expect(reason).toContain("exited with code 127");
    expect(reason).toContain("The tool server keeps the environment it started with");
    expect(reason).not.toContain("A command was not found.");
  });

  it("leaves a .sh that chose 127 and explained itself alone", async (ctx) => {
    skipWithoutBash(ctx);
    // 127 is bash's own name for a missing command AND an ordinary exit code a
    // script may choose. A script that wrote `$ARGENT_REASON` said what went
    // wrong, and the note would answer it with a paragraph about the tool
    // server's `PATH` — a confident instruction pointing somewhere else.
    await write("scripts/own-127.sh", `echo "no such tenant" > "$ARGENT_REASON"\nexit 127\n`);
    await flow("sh-own-127", "steps:\n  - script: { path: ../../scripts/own-127.sh }\n");

    const { result } = await runFlow("sh-own-127");

    const reason = result.steps[0].reason ?? "";
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
    // The echo repeats an env value and is reported as written: argent does not
    // compare an echo message, a selector or a tool argument against env values.
    expect(result.steps[1].message).toBe("Calling https://api.example.com");
    expect(JSON.stringify(result.steps[0])).not.toContain("…");
  });

  it("returns the output document as the script wrote it, resolved secret and all", async () => {
    // The document is the script's ANSWER, and a later step reads it for the
    // value it holds — `{{secret:NAME}}` in its place is a dead string. The
    // reference and the flow-authoring skill say not to put a credential there
    // instead.
    //
    // Asked through `flow-add-script`, because that is the only channel that
    // hands a document back: a run's `StepReport` carries none for a script
    // step, so a case that writes `output.token` inside a RUN and then reads
    // the report asserts nothing either way.
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
    // Argent does not compare env values against secret values anywhere. A user
    // who puts a value in the clear knows what they are doing.
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
  it("keeps a checked-in flow-level env across the reset, and says it did", async () => {
    // The reset discards STEPS. `env:` is the header a checked-in flow declares
    // its script defaults in, no recording tool writes one, and the reference
    // forbids editing the YAML during a recording — so truncating it left the
    // documented order with no way to record a step under the environment the
    // replay takes. The step ran under nothing and replayed under the file's
    // map, silently.
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

    expect(started.flowFile).toContain("PLAIN: checked-in-default");
    expect(started.flowFile).toContain("steps: []");
    expect(started.message).toContain("PLAIN");

    const added = (await flowAddScriptTool.execute(
      {},
      { name: "qa", project_root: root, path: "../../scripts/dump.mjs" }
    )) as { status: string };

    expect(added.status).toBe("pass");
    // The live run took the checked-in default, which is what a replay of the
    // recorded file takes too.
    expect(seen("kept")).toEqual({ PLAIN: "checked-in-default" });
  });

  // The pre-run read has three failure states and they ask for opposite things.
  // Neither branch had a test, and one of them told the author the flow "may
  // not parse, or it may parse and break a rule" about a file argent never got
  // to look at.
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

  // chmod is a POSIX rule and root ignores it, so the unreadable branch is
  // asked for only where the host can actually refuse a read.
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
    // The flow-level map arrives by hand edit, which is how one reaches a take
    // before the first append catches the in-memory copy up.
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
    // The live run took the file's map under the call's — the same layering the
    // replay will apply, which is the whole point of recording the step live.
    expect(seen("recorded")).toEqual({
      API_URL: "https://api.example.com",
      USER_TYPE: "premium",
      API_KEY: "sk-live-9d3f0a1b",
    });

    const finished = (await flowFinishRecordingTool.execute(
      {},
      { name: "rec", project_root: root }
    )) as { flowFile: string; summary: string[] };

    // The recorded step carries the PLACEHOLDER, not the resolved value: a flow
    // file never holds a resolved secret, because resolution happens inside the
    // step at run time.
    expect(finished.flowFile).toContain("{{secret:API_KEY}}");
    expect(finished.flowFile).not.toContain("sk-live-9d3f0a1b");
  });

  it("redacts a failure the recorded script raised, exactly as a replay would", async () => {
    // `flow-add-script` runs the file through the same `runFlowScriptStep` the
    // runner does, so the resolution and the scrub are the one path — and this
    // call runs FIRST, before the flow a replay would protect exists.
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
    // A failed script is not recorded.
    expect(failed.stepCount).toBe(0);
  });

  it("withdraws the layering promise when the file's env changed during the run", async () => {
    // The file's `env:` is read before a run that may take minutes and re-read
    // by the append afterwards. An edit landing in that window is recorded and
    // replays under an environment this run never took.
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
    // `recorded` is the only view of the appended step the recorder returns,
    // and the summary is also what `flow-finish-recording` lists. A step
    // carrying nineteen values summarized identically to a bare one, while a
    // raw `tool:` step renders its whole args map.
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

  it("says which way the drift went when the names did not change", async () => {
    // `sameEnv` compares VALUES and `envNames` renders NAMES, so an edit that
    // only changed a value would print the same text on both sides of the
    // sentence — a difference the message announces and then does not show.
    // That branch had no case.
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
    // Neither carries a value, so neither changes what the script read. A drift
    // message here would withdraw a promise that still holds, and send the
    // author to delete a step and run a side-effecting script again.
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
    // The one false positive the drift check exists to avoid. The file is
    // re-read after a run that may take minutes, and an edit landing in that
    // window is ordinary — only an `env` change makes the recorded step replay
    // under an environment this run never took.
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
    // The drift check exists to withdraw a promise about the environment the
    // script RAN under. A step's own map sits over the flow-level one, so an
    // edit to a name the step already overrides changes nothing the script
    // reads — and the warning told the author to delete the step and run a
    // side-effecting script again for an environment that had not moved.
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
    // The recorder→replay round trip was only tested with no run-time layer —
    // exactly the case that happens to match. A real replay puts `--env`
    // BETWEEN the two layers this call took: above the file's `env:`, still
    // under the step's own map. That is what the tool description claims and
    // nothing read it back.
    await write("scripts/probe.mjs", reporter("replayed", ["FROM_FILE", "FROM_STEP"]));
    await flow("roundtrip", "env: { FROM_FILE: file-default }\nsteps: []\n");
    await flowStartRecordingTool.execute({}, { name: "roundtrip", project_root: root });

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
    // The run replaces the file's default and loses to the step's own map.
    expect(seen("replayed")).toEqual({ FROM_FILE: "from-run", FROM_STEP: "step-value" });
  });

  it("proceeds when flow-add-script is given a plaintext value equal to a secret", async () => {
    // §4.4: argent does not compare env values against secret values on ANY
    // channel. The other three are pinned; the recorder was not.
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

    // The plaintext value is an input the author chose to write into a file that
    // gets committed; the placeholder is a placeholder. Neither is elided, and
    // an echo repeating one is reported as written.
    expect(finished.flowFile).toContain("https://example.com");
    expect(finished.flowFile).toContain("{{secret:API_KEY}}");
    expect(finished.summary.join("\n")).toContain("https://example.com");
    expect(finished.summary.join("\n")).not.toContain("…");
  });
});
