import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { parseFlow, serializeFlow } from "../../../src/tools/flows/flow-utils";

/**
 * Environment values for a `script` step, through a real run: the test file's
 * `env:`, a fragment's `env:`, the step's `env:` and the run's own values, and
 * `{{secret:NAME}}` resolved from the project and redacted from what the
 * script prints.
 */

vi.setConfig({ testTimeout: 30_000 });

let root: string;

// A `run:` step resolves a device even when its fragment holds only scripts.
const registry = {
  invokeTool: vi.fn(async (id: string) =>
    id === "list-devices"
      ? {
          devices: [
            { platform: "ios", udid: "00000000-0000-0000-0000-0000000000ab", state: "Booted" },
          ],
        }
      : { ok: true }
  ),
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

async function run(name: string, params: Record<string, unknown> = {}): Promise<FlowRunResult> {
  const result = await createRunFlowTool(registry).execute({}, {
    project_root: root,
    name,
    ...params,
  } as never);
  if (!("steps" in result)) throw new Error(`expected a run result, got: ${result.notice}`);
  return result;
}

/** A script that prints the named variables as one JSON line. */
const PRINT_ENV = (names: string[]) =>
  `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, process.env[n] ?? null]))));`;

function printed(result: FlowRunResult, step = 0): Record<string, string | null> {
  return JSON.parse(result.steps[step]!.scriptLog!.trim());
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-env-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("where a script's environment values come from", () => {
  it("layers the file, the step and the run, each replacing only the names it sets", async () => {
    await write("scripts/print.mjs", PRINT_ENV(["A", "B", "C", "D"]));
    await write(
      ".argent/e2e/layers.yaml",
      [
        "env: { A: file, B: file, C: file }",
        "steps:",
        "  - script: { path: ../../scripts/print.mjs, env: { B: step, C: step } }",
        "  - script: { path: ../../scripts/print.mjs }",
        "",
      ].join("\n")
    );

    const result = await run("layers", { env: { C: "run", D: "run" } });

    expect(result.ok).toBe(true);
    expect(printed(result, 0)).toEqual({ A: "file", B: "step", C: "run", D: "run" });
    // A step's own env stays with that step.
    expect(printed(result, 1)).toEqual({ A: "file", B: "file", C: "run", D: "run" });
  });

  it("gives a fragment's env: to names its caller did not set", async () => {
    await write("scripts/print.mjs", PRINT_ENV(["SHARED", "OWN"]));
    await write(
      ".argent/e2e/login.yaml",
      "env: { SHARED: fragment, OWN: fragment }\nsteps:\n  - script: { path: ../../scripts/print.mjs }\n"
    );
    await write(
      ".argent/e2e/caller.yaml",
      "env: { SHARED: caller }\nsteps:\n  - run: login.yaml\n  - script: { path: ../../scripts/print.mjs }\n"
    );

    const result = await run("caller");

    expect(result.ok).toBe(true);
    const scripts = result.steps.filter((s) => s.kind === "script");
    expect(JSON.parse(scripts[0]!.scriptLog!)).toEqual({ SHARED: "caller", OWN: "fragment" });
    // The fragment's defaults end with the fragment.
    expect(JSON.parse(scripts[1]!.scriptLog!)).toEqual({ SHARED: "caller", OWN: null });
  });

  it("lets each layer replace a name in other casing on Windows", async () => {
    await write(
      "scripts/print.mjs",
      `console.log(JSON.stringify(Object.entries(process.env).filter(([n]) => ["api_url", "mode"].includes(n.toLowerCase())).sort()));`
    );
    await write(
      "fragment.yaml",
      "env: { Mode: fragment }\nsteps:\n  - script: { path: scripts/print.mjs, env: { api_url: step } }\n"
    );
    await write(
      ".argent/e2e/layers.yaml",
      "env: { API_URL: file, MODE: file }\nsteps:\n  - run: ../../fragment.yaml\n"
    );

    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    let result: FlowRunResult;
    try {
      result = await run("layers", { env: { Api_Url: "run" } });
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
    }

    expect(result.ok).toBe(true);
    const log = result.steps.find((step) => step.scriptLog)!.scriptLog!;
    expect(JSON.parse(log.trim())).toEqual([
      ["Api_Url", "run"],
      ["MODE", "file"],
    ]);
  });

  it("does not resolve a run value on Windows that a later casing of its name replaced", async () => {
    await write(
      "scripts/print.mjs",
      `console.log(JSON.stringify(Object.entries(process.env).filter(([n]) => n.toLowerCase() === "mode")));`
    );
    await write(".argent/e2e/mode.yaml", "steps:\n  - script: { path: ../../scripts/print.mjs }\n");

    const real = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    let result: FlowRunResult;
    try {
      result = await run("mode", {
        env: { MODE: "{{secret:NOT_DEFINED_ANYWHERE_42}}", mode: "fast" },
      });
    } finally {
      Object.defineProperty(process, "platform", { value: real, configurable: true });
    }

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.steps[0]!.scriptLog!.trim())).toEqual([["mode", "fast"]]);
  });

  it("refuses a run value with an invalid name in the e2e-execute schema", async () => {
    await write(".argent/e2e/any.yaml", "steps:\n  - echo: hi\n");
    const parsed = createRunFlowTool(registry).zodSchema!.safeParse({
      project_root: root,
      name: "any",
      env: { "1BAD": "x" },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("a secret in a script's environment", () => {
  const VALUE = "sk-live-9f8e7d6c5b4a3210";

  beforeEach(async () => {
    await write(".argent/secrets.env", `API_KEY=${VALUE}\n`);
  });

  it("reaches the script, and is redacted from its log and its failure", async () => {
    await write(
      "scripts/leak.mjs",
      [
        `if (process.env.API_KEY !== ${JSON.stringify(VALUE)}) throw new Error("wrong value");`,
        `console.log("key=" + process.env.API_KEY);`,
        `console.log("prefix=" + process.env.API_KEY.slice(0, 10));`,
        `console.log("url=" + process.env.URL);`,
        `throw new Error("401 for " + process.env.API_KEY);`,
      ].join("\n")
    );
    await write(
      ".argent/e2e/leak.yaml",
      [
        'env: { URL: "https://u:{{secret:API_KEY}}@api.example.com" }',
        "steps:",
        '  - script: { path: ../../scripts/leak.mjs, env: { API_KEY: "{{secret:API_KEY}}" } }',
        "",
      ].join("\n")
    );

    const result = await run("leak");

    const step = result.steps[0]!;
    expect(step.status).toBe("fail");
    const shown = `${step.reason}\n${step.scriptLog}`;
    expect(shown).not.toContain(VALUE);
    expect(shown).not.toContain(VALUE.slice(0, 10));
    expect(step.scriptLog).toContain("key={{secret:API_KEY}}");
    expect(step.scriptLog).toContain("prefix={{secret:API_KEY}}");
    expect(step.scriptLog).toContain("url=https://u:{{secret:API_KEY}}@api.example.com");
    expect(step.reason).toContain("401 for {{secret:API_KEY}}");
  });

  it("leaves no piece of a secret where a size limit cut it", async () => {
    // Cut 5 characters into the value: too short a piece to match on its own.
    await write(
      "scripts/flood.mjs",
      `process.stdout.write("x".repeat(64 * 1024 - 5) + process.env.K);\n` +
        `throw new Error("y".repeat(8156) + process.env.K + "z".repeat(100));`
    );
    await write(
      ".argent/e2e/flood.yaml",
      'env: { K: "{{secret:API_KEY}}" }\nsteps:\n  - script: { path: ../../scripts/flood.mjs }\n'
    );

    const step = (await run("flood")).steps[0]!;

    expect(step.scriptLogTruncated).toBe(true);
    expect(step.scriptLog!.endsWith("x{{secret:API_KEY}}")).toBe(true);
    // Past the limit by at most the one marker the cut landed in.
    expect(Buffer.byteLength(step.scriptLog!)).toBeLessThanOrEqual(
      64 * 1024 + "{{secret:API_KEY}}".length
    );
    expect(step.reason).toMatch(/y\{\{secret:API_KEY\}\}… \[\d+ more characters omitted]/);
    expect(step.reason).not.toContain("sk-li");
  });

  it("redacts a secret whose halves the other stream's text separates", async () => {
    // Two block-buffered stdout writes with a stderr line between them, the
    // first ending 4 characters into the value: too short to match alone.
    await write(
      "scripts/interleave.mjs",
      [
        `import { writeSync } from "node:fs";`,
        `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
        `const body = "x".repeat(4092) + process.env.K + "\\n";`,
        `writeSync(1, body.slice(0, 4096)); await sleep(50);`,
        `writeSync(2, "warn: retrying\\n"); await sleep(50);`,
        `writeSync(1, body.slice(4096));`,
      ].join("\n")
    );
    await write(
      ".argent/e2e/interleave.yaml",
      'env: { K: "{{secret:API_KEY}}" }\nsteps:\n  - script: { path: ../../scripts/interleave.mjs }\n'
    );

    const log = (await run("interleave")).steps[0]!.scriptLog!;

    expect(log).toContain("warn: retrying");
    for (let i = 0; i + 3 <= VALUE.length; i++) expect(log).not.toContain(VALUE.slice(i, i + 3));
  });

  it("errors the step when a resolved secret holds a NUL", async () => {
    await write(".argent/secrets.env", 'NUL_KEY="abc\0defgh"\n');
    await write("scripts/noop.mjs", "");
    await write(
      ".argent/e2e/nul.yaml",
      'env: { K: "{{secret:NUL_KEY}}" }\nsteps:\n  - script: { path: ../../scripts/noop.mjs }\n'
    );

    const step = (await run("nul")).steps[0]!;

    expect(step.status).toBe("error");
    expect(step.reason).toContain("NUL character");
    expect(step.reason).not.toContain("abc");
  });

  it("resolves a secret passed in the run's own values", async () => {
    await write("scripts/check.mjs", `console.log(process.env.K === ${JSON.stringify(VALUE)});`);
    await write(
      ".argent/e2e/check.yaml",
      "steps:\n  - script: { path: ../../scripts/check.mjs }\n"
    );

    const result = await run("check", { env: { K: "{{secret:API_KEY}}" } });

    expect(result.ok).toBe(true);
    expect(result.steps[0]!.scriptLog!.trim()).toBe("true");
  });

  it("errors the step without running the script when a file's secret is missing", async () => {
    await write(
      "scripts/marker.mjs",
      `import { writeFileSync } from "node:fs";\nwriteFileSync("ran", "");`
    );
    await write(
      ".argent/e2e/missing.yaml",
      'env: { K: "{{secret:NOT_DEFINED_ANYWHERE_42}}" }\nsteps:\n  - script: { path: ../../scripts/marker.mjs }\n'
    );

    const result = await run("missing");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain("NOT_DEFINED_ANYWHERE_42");
    expect(result.steps[0]!.reason).toContain("API_KEY");
    await expect(fs.stat(path.join(root, "ran"))).rejects.toThrow();
  });

  it("refuses an invalid project root before it looks for a run value's secret", async () => {
    const call = createRunFlowTool(registry).execute({}, {
      project_root: "relative/project",
      name: "any",
      env: { K: "{{secret:NOT_DEFINED_ANYWHERE_42}}" },
    } as never);
    const error = await call.then(
      () => undefined,
      (err: unknown) => err as Error
    );
    expect(error?.message).toMatch(/project_root/);
    expect(error?.message).not.toContain("NOT_DEFINED_ANYWHERE_42");
  });

  it("refuses the run before any step when a run value's secret is missing", async () => {
    await write(".argent/e2e/any.yaml", "steps:\n  - echo: hi\n");
    await expect(run("any", { env: { K: "{{secret:NOT_DEFINED_ANYWHERE_42}}" } })).rejects.toThrow(
      /NOT_DEFINED_ANYWHERE_42/
    );
  });
});

describe("env in a test file", () => {
  it("round-trips through the serializer", () => {
    const yaml =
      'env:\n  API_URL: https://api.example.com\n  TOKEN: "{{secret:TOKEN}}"\nsteps:\n  - script: { path: s.mjs, env: { MODE: fast } }\n';
    const flow = parseFlow(yaml);
    expect(flow.env).toEqual({ API_URL: "https://api.example.com", TOKEN: "{{secret:TOKEN}}" });
    expect(parseFlow(serializeFlow(flow))).toEqual(flow);
  });

  it.each([
    ["a non-string value", "env: { PORT: 8080 }", /quote it/],
    ["an invalid name", 'env: { "1X": a }', /invalid variable name/],
    ["a list", "env: [A]", /must be a map/],
    ["an output reference", 'env: { A: "{{output:x}}" }', /reference in the value of A/],
    ["a NUL in a value", 'env: { A: "x\\0" }', /NUL character/],
    // Parsed to a Map and a Set, whose entries Object.entries never sees.
    ["an ordered map", "env: !!omap [{ MODE: fast }]", /must be a map/],
    ["a set", "env: !!set { MODE: null }", /must be a map/],
  ])("refuses %s at the top level", (_label, line, message) => {
    expect(() => parseFlow(`${line}\nsteps: []\n`)).toThrow(message);
  });

  it("refuses an invalid step env", () => {
    expect(() => parseFlow("steps:\n  - script: { path: s.mjs, env: { ON: true } }\n")).toThrow(
      /script\.env has a non-string value for ON/
    );
  });

  it("refuses an ordered map as a step env", () => {
    expect(() =>
      parseFlow("steps:\n  - script: { path: s.mjs, env: !!omap [{ MODE: fast }] }\n")
    ).toThrow(/script\.env must be a map/);
  });
});
