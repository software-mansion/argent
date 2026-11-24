import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore, type Registry, type ToolContext } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { stepRequiresDevice } from "../../../src/tools/flows/flow-device";
import { FlowScriptExecutor } from "../../../src/tools/flows/script/flow-script-executor";
import { hostRunsTypeScript } from "../../helpers/host-typescript";

/**
 * The `script:` step in a run; the executor's own behaviour is covered beside
 * it, in flow-script-run.test.ts. Real child processes, hence the generous
 * timeout.
 */

vi.setConfig({ testTimeout: 30_000 });

/**
 * The executor a run uses, when a group of tests puts its own in place of the
 * shared one. Every other test gets the shared one, as the product does.
 */
const executorInPlace = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("../../../src/tools/flows/script/flow-script-executor", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/tools/flows/script/flow-script-executor")>();
  return {
    ...actual,
    flowScriptExecutor: () =>
      (executorInPlace.current as InstanceType<typeof actual.FlowScriptExecutor> | undefined) ??
      actual.flowScriptExecutor(),
  };
});

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

let root: string;

function mockRegistry(opts: { booted?: string[] } = {}) {
  const invokeTool = vi.fn(async (id: string) => {
    if (id === "list-devices") {
      return {
        devices: (opts.booted ?? []).map((udid) => ({ platform: "ios", udid, state: "Booted" })),
      };
    }
    return { ok: true };
  });
  const registry = {
    invokeTool,
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
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

function boundaryCtx(flowPath: string): ToolContext {
  return {
    artifacts: new ArtifactStore(),
    fileInputs: {
      e2e_test_path: {
        clientPath: flowPath,
        presentOnHost: true,
        viaUpload: false,
        statVerified: true,
      },
    },
  };
}

function listedDevices(invokeTool: { mock: { calls: unknown[][] } }): boolean {
  return invokeTool.mock.calls.some((call) => call[0] === "list-devices");
}

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a run result, got notice: ${r.notice}`);
  return r;
}

async function run(
  registry: Registry,
  params: Record<string, unknown>,
  ctx?: ToolContext
): Promise<FlowRunResult> {
  return asRun(
    await createRunFlowTool(registry).execute({}, { project_root: root, ...params } as never, ctx)
  );
}

async function runFlow(name: string, opts: { booted?: string[]; device?: string } = {}) {
  const { registry, invokeTool } = mockRegistry(opts);
  const result = await run(registry, { name, ...(opts.device ? { device: opts.device } : {}) });
  return { result, invokeTool };
}

async function until(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-step-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("a script step in a run", () => {
  it("runs the file, passes, and carries its output into the report", async () => {
    await write("scripts/seed.mjs", `console.log("seeded order 4711");`);
    await flow("seed", "steps:\n  - script: { path: ../../scripts/seed.mjs }\n");

    const { result, invokeTool } = await runFlow("seed");

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "pass",
      target: "../../scripts/seed.mjs",
    });
    expect(result.steps[0]!.scriptLog).toContain("seeded order 4711");
    expect(result.device).toBe("");
    expect(listedDevices(invokeTool)).toBe(false);
  });

  it("carries stderr into the same log as stdout", async () => {
    // Cross-STREAM interleaving is the kernel's to decide (stdout and stderr
    // are separate pipes), so only each stream's own order is pinned.
    await write(
      "scripts/noisy.mjs",
      `console.log("one");\nconsole.error("problem");\nconsole.log("three");`
    );
    await flow("noisy", "steps:\n  - script: { path: ../../scripts/noisy.mjs }\n");

    const { result } = await runFlow("noisy");

    const log = result.steps[0]!.scriptLog!;
    expect(log).toContain("problem");
    expect(log.indexOf("one")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("three")).toBeGreaterThan(log.indexOf("one"));
    expect(result.steps[0]!.scriptLogTruncated).toBeUndefined();
  });

  it("flags a log a limit cut short, because the text carries no marker", async () => {
    await write(
      "scripts/chatty.mjs",
      `for (let i = 0; i < 4000; i++) console.log("line " + i + " " + "x".repeat(40));`
    );
    await flow("chatty", "steps:\n  - script: { path: ../../scripts/chatty.mjs }\n");

    const { result } = await runFlow("chatty");

    expect(result.steps[0]).toMatchObject({ status: "pass", scriptLogTruncated: true });
    expect(result.steps[0]!.scriptLog).toContain("line 0 ");
  });

  it("spends one run-wide budget across the run's steps through the runner", async () => {
    await write("scripts/chatty.mjs", `process.stdout.write("z".repeat(64 * 1024));`);
    await write("scripts/quiet.mjs", `console.log("the quiet one ran");`);
    const chattyStep = "  - script: { path: ../../scripts/chatty.mjs }\n";
    await flow(
      "budget",
      "steps:\n" + chattyStep.repeat(5) + "  - script: { path: ../../scripts/quiet.mjs }\n"
    );

    const { result } = await runFlow("budget");

    expect(result.ok).toBe(true);
    for (const starved of result.steps.slice(4)) {
      expect(starved.scriptLog).toBeUndefined();
      expect(starved.scriptLogTruncated).toBe(true);
    }
    expect(result.steps[0]!.scriptLog).not.toBe("");
  });

  it("classifies as needing no device", () => {
    const registry = mockRegistry().registry;
    expect(stepRequiresDevice(registry, { kind: "script", path: "seed.mjs" })).toBe(false);
  });
});

describe("a script step that fails", () => {
  it("reports the script's own error as a fail and stops the flow", async () => {
    await write("scripts/boom.mjs", `throw new Error("seed API returned 500");`);
    await flow(
      "boom",
      "steps:\n" +
        "  - script: { path: ../../scripts/boom.mjs }\n" +
        "  - echo: never reached\n" +
        "  - wait: 1\n"
    );

    const { result } = await runFlow("boom");

    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(result.steps[0]!.reason).toContain("seed API returned 500");
    expect(result.steps.slice(1).map((s) => [s.kind, s.status])).toEqual([
      ["echo", "skip"],
      ["wait", "skip"],
    ]);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1); // echo is narration and is not counted
  });

  it("names the file, the line and the frames a bare node run would print", async () => {
    // Without them the step's whole diagnostic is one sentence: a throw writes
    // nothing to stderr, so there is no log either, and CI has nothing to
    // re-run against.
    await write(
      "scripts/deep.mjs",
      "function inner(o) { return o.id; }\nfunction outer() { return inner(undefined); }\nouter();\n"
    );
    await flow("deep", "steps:\n  - script: { path: ../../scripts/deep.mjs }\n");

    const { result } = await runFlow("deep");

    const reason = result.steps[0]!.reason!;
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(reason).toContain("Cannot read properties of undefined");
    // Project-relative, so the frames fit the step line the reason rides on.
    expect(reason).toContain("at inner (scripts/deep.mjs:1:30)");
    expect(reason).toContain("at outer (scripts/deep.mjs:2:27)");
    // Still one line: the frames are escaped like any other break in a reason.
    expect(reason).not.toMatch(/[\n\r]/);
  });

  it("leaves the host's own frames out of the reason", async () => {
    // A stack ends in the ESM loader and the runner that preloaded the script.
    // Those name no line the author can open, and they would crowd out the
    // frames that do.
    await write("scripts/boom2.mjs", `throw new Error("seed API returned 500");`);
    await flow("boom2", "steps:\n  - script: { path: ../../scripts/boom2.mjs }\n");

    const { result } = await runFlow("boom2");

    const reason = result.steps[0]!.reason!;
    expect(reason).toContain("at scripts/boom2.mjs:1:7");
    expect(reason).not.toContain("node:internal");
    expect(reason).not.toContain("flow-script-runner");
  });

  it("names a CommonJS script's frames the way it names an ES module's", async () => {
    // A CommonJS frame carries a bare absolute path where an ES module's has a
    // `file:` URL, and Node loads the script through `node:diagnostics_channel`,
    // which is not under `node:internal`. Left alone, the step line holds the
    // path of the machine it ran on and a frame the author cannot open.
    await write("package.json", `{ "type": "commonjs" }`);
    await write(
      "scripts/fail.js",
      `function seed() {\n  throw new Error("backend said 500");\n}\nseed();\n`
    );
    await flow("cjsfail", "steps:\n  - script: { path: ../../scripts/fail.js }\n");

    const { result } = await runFlow("cjsfail");

    const reason = result.steps[0]!.reason!;
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(reason).toContain("backend said 500");
    expect(reason).toContain("at seed (scripts/fail.js:2:9)");
    expect(reason).toMatch(/\(scripts\/fail\.js:4:1\)$/);
    // Neither spelling of the project root, and nothing of Node's.
    expect(reason).not.toContain(root);
    expect(reason).not.toContain("node:");
  });

  it("leaves Node's own frames out of a CommonJS load failure", async () => {
    await write("package.json", `{ "type": "commonjs" }`);
    await write("scripts/lost.js", `require("./missing-helper");\n`);
    await flow("cjslost", "steps:\n  - script: { path: ../../scripts/lost.js }\n");

    const { result } = await runFlow("cjslost");

    const reason = result.steps[0]!.reason!;
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(reason).toContain("Cannot find module './missing-helper'");
    expect(reason).toContain(`at Object.<anonymous> (scripts/lost.js:1:1)`);
    expect(reason).not.toMatch(/\bat [^\\]*node:/);
  });

  it("keeps the absolute path of a frame outside the project root", async () => {
    // A `..` chain says less than the path does, for either kind of frame.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-outside-"));
    try {
      const helper = path.join(await fs.realpath(outside), "helper.js");
      await fs.writeFile(helper, `module.exports = () => { throw new Error("from outside"); };`);
      await write("package.json", `{ "type": "commonjs" }`);
      await write("scripts/far.js", `require(${JSON.stringify(helper)})();\n`);
      await flow("cjsfar", "steps:\n  - script: { path: ../../scripts/far.js }\n");

      const { result } = await runFlow("cjsfar");

      const reason = result.steps[0]!.reason!;
      expect(reason).toContain(`(${helper}:1:`);
      expect(reason).toContain(`at Object.<anonymous> (scripts/far.js:1:`);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("caps the frames it folds in and says how many it left out", async () => {
    await write(
      "scripts/recurse.mjs",
      "function down(n) { if (n === 0) throw new Error('bottom'); return down(n - 1); }\ndown(20);\n"
    );
    await flow("recurse", "steps:\n  - script: { path: ../../scripts/recurse.mjs }\n");

    const { result } = await runFlow("recurse");

    const reason = result.steps[0]!.reason!;
    expect(reason).toContain("bottom");
    expect(reason.match(/ at down \(/g) ?? []).toHaveLength(6);
    expect(reason).toMatch(/… \d+ more frames/);
  });

  it("keeps a multi-line throw message on the step's own line", async () => {
    // The ordinary shape of a rethrown API error. Raw, the JSON body lands at
    // column 0 under the `✗` line, outside the step framing every renderer is
    // built on — one line per step, reason interpolated straight in.
    await write(
      "scripts/rethrow.mjs",
      "throw new Error(`POST /orders returned 409\n" +
        '${JSON.stringify({ error: "duplicate_order" }, null, 2)}`);'
    );
    await flow("rethrow", "steps:\n  - script: { path: ../../scripts/rethrow.mjs }\n");

    const { result } = await runFlow("rethrow");

    const reason = result.steps[0]!.reason!;
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(reason).not.toMatch(/[\n\r\t]/);
    // Escaped, not stripped: the message is still readable and the breaks are
    // still recoverable.
    expect(reason).toContain("POST /orders returned 409\\n");
    expect(reason).toContain("duplicate_order");
  });

  it("denies a script the framing needed to forge a run verdict", async () => {
    // The step's reason is the only text on a report line that the script
    // itself writes. Given a raw newline it can put a whole summary line of its
    // own below a failed step and above the real one.
    await write(
      "scripts/forge.mjs",
      "throw new Error(`seed failed\\n\\nPASS — 3 passed, 0 failed, 0 errored, 0 skipped`);"
    );
    await flow("forge", "steps:\n  - script: { path: ../../scripts/forge.mjs }\n");

    const { result } = await runFlow("forge");

    const reason = result.steps[0]!.reason!;
    expect(result.ok).toBe(false);
    expect(reason.split("\n")).toHaveLength(1);
    expect(reason).toContain("PASS — 3 passed");
  });

  it("reports a script that stops its own process as a fail", async () => {
    await write("scripts/exit.mjs", `console.log("about to bail");\nprocess.exit(3);`);
    await flow("exit", "steps:\n  - script: { path: ../../scripts/exit.mjs }\n");

    const { result } = await runFlow("exit");

    expect(result.steps[0]).toMatchObject({ status: "fail" });
    expect(result.steps[0]!.reason).toContain("exit code 3");
    expect(result.steps[0]!.scriptLog).toContain("about to bail");
  });

  it("reports a script the host stopped at its time limit as an error", async () => {
    await write("scripts/slow.mjs", `await new Promise((r) => setTimeout(r, 30000));`);
    await flow("slow", "steps:\n  - script: { path: ../../scripts/slow.mjs, timeout: 800 }\n");

    const { result } = await runFlow("slow");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toMatch(/did not finish within its 800ms time limit/);
    expect(result.errored).toBe(1);
  });
});

/**
 * `.js` and `.ts` take their module type from the project's package.json, so
 * each row is one `type` value against one shape of script. The `.ts` half
 * runs only where Node runs TypeScript, by Node's own answer.
 */
describe("a script whose module type the project decides", () => {
  const esm = [
    `import { basename } from "node:path";`,
    `await Promise.resolve();`,
    `console.log("ran " + basename("/a/b.txt"));`,
  ].join("\n");
  const cjs = [
    `const { basename } = require("node:path");`,
    `console.log("ran " + basename("/a/b.txt"));`,
  ].join("\n");

  async function runScript(file: string, source: string, type: string | undefined) {
    // `{}` rather than no file at all: a package.json with no `type` is the
    // ordinary React Native layout, and the one Node warns about.
    await write("package.json", JSON.stringify(type === undefined ? {} : { type }));
    await write(`scripts/${file}`, source);
    await flow("typed", `steps:\n  - script: { path: ../../scripts/${file} }\n`);
    const { result } = await runFlow("typed");
    return result.steps[0]!;
  }

  const extensions = [
    { ext: "js", runs: true },
    { ext: "ts", runs: hostRunsTypeScript },
  ];

  it("answers Node's advice to rename a .js script to .cjs, which the parser refuses", async () => {
    const step = await runScript("seed.js", cjs, "module");

    expect(step).toMatchObject({ kind: "script", status: "fail" });
    expect(step.reason).toContain(
      "rename it to use the '.cjs' file extension. " +
        "A script step does not accept a .cjs file: use import in the script instead.\\n" +
        `    at scripts/seed.js:1:`
    );
  });

  it("leaves that advice alone for a file the script loads, which can be renamed", async () => {
    await write("scripts/lib.js", cjs);
    const step = await runScript("seed.js", `import "./lib.js";`, "module");

    expect(step).toMatchObject({ kind: "script", status: "fail" });
    expect(step.reason).toContain("rename it to use the '.cjs' file extension.");
    expect(step.reason).not.toContain("A script step does not accept");
  });

  it("leaves no warning for a file the script imports, where no package.json sets a type", async () => {
    // Node guesses the module type of `lib.js` from its `export`, and would
    // say so in the log of every run.
    await write("scripts/lib.js", `export const name = "b.txt";`);
    const step = await runScript(
      "seed.mjs",
      `import { name } from "./lib.js";\nconsole.log("ran " + name);`,
      undefined
    );

    expect(step).toMatchObject({ kind: "script", status: "pass" });
    expect(step.scriptLog).toBe("ran b.txt\n");
  });

  it.runIf(hostRunsTypeScript)("runs a type-only import as CommonJS", async () => {
    // Node picks the module type from what is left once the types are gone,
    // and a type-only import leaves nothing.
    const step = await runScript(
      "seed.ts",
      `import type { Stats } from "node:fs";\nconst stats: Stats = require("node:fs").statSync(".");\nconsole.log("ran " + typeof stats);`,
      "commonjs"
    );

    expect(step).toMatchObject({ kind: "script", status: "pass" });
    expect(step.scriptLog).toContain("ran object");
  });

  for (const { ext, runs } of extensions) {
    const typed = (source: string) =>
      ext === "ts" ? `const label: string = "typed";\nvoid label;\n${source}` : source;

    describe.runIf(runs)(`.${ext}`, () => {
      it("runs ES module syntax once when package.json sets no type", async () => {
        // Every Node that `engines` admits reads the syntax of such a file.
        const step = await runScript(`seed.${ext}`, typed(esm), undefined);

        expect(step).toMatchObject({ kind: "script", status: "pass" });
        expect(step.scriptLog!.match(/ran b\.txt/g)).toHaveLength(1);
        // Node would otherwise advise setting `type` on the whole project.
        expect(step.scriptLog).not.toContain("MODULE_TYPELESS_PACKAGE_JSON");
        expect(step.scriptLog).not.toContain("Warning");
      });

      it("reads an export alone as ES module syntax", async () => {
        // No `import` and no top-level `await`, and still an ES module: in a
        // TypeScript file `export {}` is the usual way to say so.
        const step = await runScript(
          `seed.${ext}`,
          typed(`console.log("require is " + typeof require);\nexport {};`),
          undefined
        );

        expect(step).toMatchObject({ kind: "script", status: "pass" });
        expect(step.scriptLog).toContain("require is undefined");
      });

      it("runs CommonJS once when package.json sets no type", async () => {
        // The runner re-imports the entry to see whether it settled, which
        // must find the module already loaded rather than run it again.
        const step = await runScript(`seed.${ext}`, typed(cjs), undefined);

        expect(step).toMatchObject({ kind: "script", status: "pass" });
        expect(step.scriptLog!.match(/ran b\.txt/g)).toHaveLength(1);
      });

      it("runs as an ES module under type: module", async () => {
        const step = await runScript(`seed.${ext}`, typed(esm), "module");

        expect(step).toMatchObject({ kind: "script", status: "pass" });
        expect(step.scriptLog!.match(/ran b\.txt/g)).toHaveLength(1);
      });

      it("runs as CommonJS under type: commonjs", async () => {
        const step = await runScript(`seed.${ext}`, typed(cjs), "commonjs");

        expect(step).toMatchObject({ kind: "script", status: "pass" });
        expect(step.scriptLog!.match(/ran b\.txt/g)).toHaveLength(1);
      });

      it("fails on ES module syntax under type: commonjs", async () => {
        const step = await runScript(`seed.${ext}`, typed(esm), "commonjs");

        expect(step).toMatchObject({ kind: "script", status: "fail" });
        expect(step.reason).toMatch(/Cannot use import statement outside a module/);
      });

      it("fails on require under type: module", async () => {
        const step = await runScript(`seed.${ext}`, typed(cjs), "module");

        expect(step).toMatchObject({ kind: "script", status: "fail" });
        expect(step.reason).toMatch(/require is not defined/);
      });

      it("is the main module by each test a CommonJS script may use", async () => {
        // `--import` sends the entry through the ESM loader, where Node sets
        // `require.main` and nothing else. A body behind either of the other
        // two guards would not run, and the step would pass with an empty log.
        await write(
          "scripts/helper.js",
          `module.exports = [module.id === __filename, require.main === module].join();`
        );
        const step = await runScript(
          `seed.${ext}`,
          typed(
            [
              `if (require.main === module) console.log("by require.main");`,
              `if (module.id === ".") console.log("by module.id");`,
              `if (module.parent === null) console.log("by module.parent");`,
              // What plain `node` gives a module, and no more: `parent` is not
              // among its enumerable keys there either.
              `console.log("keys " + Object.keys(module).join());`,
              // Only the entry is the main module.
              `console.log("helper " + require("./helper.js"));`,
            ].join("\n")
          ),
          "commonjs"
        );

        expect(step).toMatchObject({ kind: "script", status: "pass" });
        const log = step.scriptLog!;
        expect(log).toContain("by require.main");
        expect(log).toContain("by module.id");
        expect(log).toContain("by module.parent");
        expect(log).toContain("keys id,path,exports,filename,loaded,children,paths\n");
        expect(log).toContain("helper true,false");
      });

      for (const type of ["commonjs", undefined]) {
        const where = type === undefined ? "no type" : `type: ${type}`;

        it(`gives a CommonJS script the require of plain node under ${where}`, async () => {
          // On Node 22, 24.0 to 24.17 and 25, the ESM loader that `--import`
          // sends the entry through gives a CommonJS TypeScript file a reduced
          // `require`, and every module it loads an undefined `module.parent`.
          await write("scripts/dep.js", `module.exports = { parent: module.parent };`);
          const step = await runScript(
            `seed.${ext}`,
            typed(
              [
                `const dep = require("./dep.js");`,
                `console.log("cache " + typeof require.cache);`,
                `console.log("extensions " + typeof require.extensions);`,
                `console.log("paths " + typeof require.resolve.paths);`,
                `console.log("parent " + (dep.parent === module));`,
              ].join("\n")
            ),
            type
          );

          expect(step).toMatchObject({ kind: "script", status: "pass" });
          const log = step.scriptLog!;
          expect(log).toContain("cache object");
          expect(log).toContain("extensions object");
          expect(log).toContain("paths function");
          expect(log).toContain("parent true");
        });

        it(`runs a CommonJS script that throws once under ${where}`, async () => {
          const step = await runScript(
            `seed.${ext}`,
            typed(
              [
                `const fs = require("node:fs");`,
                `fs.appendFileSync(__dirname + "/runs.txt", "ran\\n");`,
                `function seed() { throw new Error("backend said 500"); }`,
                `seed();`,
              ].join("\n")
            ),
            type
          );

          expect(step).toMatchObject({ kind: "script", status: "fail" });
          expect(step.reason).toContain("backend said 500");
          // `typed` puts two lines above a TypeScript script's own.
          expect(step.reason).toContain(`at seed (scripts/seed.${ext}:${ext === "ts" ? 5 : 3}:`);
          expect(step.reason).not.toContain("flow-script-runner");
          expect(await fs.readFile(path.join(root, "scripts/runs.txt"), "utf8")).toBe("ran\n");
        });

        it(`lets a CommonJS script handle its own throw under ${where}`, async () => {
          const step = await runScript(
            `seed.${ext}`,
            typed(
              [
                `const fs = require("node:fs");`,
                `fs.appendFileSync(__dirname + "/runs.txt", "ran\\n");`,
                `process.on("uncaughtException", (err) => console.log("handled " + err.message));`,
                `throw new Error("backend said 500");`,
              ].join("\n")
            ),
            type
          );

          expect(step).toMatchObject({ kind: "script", status: "pass" });
          expect(step.scriptLog).toContain("handled backend said 500");
          expect(await fs.readFile(path.join(root, "scripts/runs.txt"), "utf8")).toBe("ran\n");
        });
      }

      it("leaves the modules of an ES module script as Node made them", async () => {
        // The script is not a CommonJS module, so nothing is the main one and
        // the first module Node builds is the dependency's own.
        await write(
          "scripts/helper.cjs",
          `module.exports = [module.id === __filename, typeof require.main].join();`
        );
        const step = await runScript(
          `seed.${ext}`,
          typed(`import helper from "./helper.cjs";\nconsole.log("helper " + helper);`),
          "module"
        );

        expect(step).toMatchObject({ kind: "script", status: "pass" });
        expect(step.scriptLog).toContain("helper true,undefined");
      });
    });
  }
});

/**
 * The suite runs on whichever Node it is given, and only some run TypeScript.
 * Each side of that line is covered by the tests it can reach, and which side
 * this host is on is Node's own answer, never the product's: gated on the
 * product's own check, a change that refused every TypeScript script would
 * skip the tests below instead of failing them. What the gate does with either
 * answer is covered on every Node in flow-script-typescript.test.ts.
 */
const stripsTypes = hostRunsTypeScript;

describe("a TypeScript script step", () => {
  it.runIf(stripsTypes)("runs a .mts file with its types stripped", async () => {
    await write(
      "scripts/seed.mts",
      [
        `import * as os from "node:os";`,
        `interface Order { id: number; host: string }`,
        `const order: Order = { id: 4711, host: typeof os.hostname() };`,
        `await Promise.resolve();`,
        `console.log(\`seeded order \${order.id}\`);`,
      ].join("\n")
    );
    await flow("seedmts", "steps:\n  - script: { path: ../../scripts/seed.mts }\n");

    const { result, invokeTool } = await runFlow("seedmts");

    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "pass",
      target: "../../scripts/seed.mts",
    });
    expect(result.steps[0]!.scriptLog).toContain("seeded order 4711");
    expect(listedDevices(invokeTool)).toBe(false);
  });

  it.runIf(stripsTypes)("runs it as an ES module in a CommonJS package", async () => {
    // The point of the extension: the project's `type` field does not reach it.
    // Under that field a `.ts` file is CommonJS, where each of these three is
    // an error — `import`, a top-level `await`, and `import.meta` — and
    // `require` exists.
    await write("package.json", `{ "type": "commonjs" }`);
    await write(
      "scripts/pinned.mts",
      [
        `import { basename } from "node:path";`,
        `const name: string = basename(import.meta.filename);`,
        `await Promise.resolve();`,
        `console.log(name, typeof require);`,
      ].join("\n")
    );
    await flow("pinned", "steps:\n  - script: { path: ../../scripts/pinned.mts }\n");

    const { result } = await runFlow("pinned");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "pass" });
    expect(result.steps[0]!.scriptLog).toContain("pinned.mts undefined");
  });

  it.runIf(stripsTypes)(
    "needs no guess at its module type where the package sets none",
    async () => {
      // Node guesses for a `.ts` file here, and says so on stderr on every run.
      // Matched by the warning's code: Node 23.6 to 24.2 print another warning,
      // that type stripping is experimental, under every TypeScript script.
      await write("package.json", `{ "name": "typeless" }`);
      await write(
        "scripts/pinned.mts",
        `import { basename } from "node:path";\nconst name: string = basename("/a/b.txt");\nconsole.log(name);\n`
      );
      await flow("typeless", "steps:\n  - script: { path: ../../scripts/pinned.mts }\n");

      const { result } = await runFlow("typeless");

      expect(result.steps[0]).toMatchObject({ kind: "script", status: "pass" });
      expect(result.steps[0]!.scriptLog).toContain("b.txt");
      expect(result.steps[0]!.scriptLog).not.toContain("MODULE_TYPELESS_PACKAGE_JSON");
    }
  );

  it.runIf(stripsTypes)("keeps the line and column of the TypeScript source", async () => {
    // Node blanks the types out in place, so a frame needs no source map.
    await write(
      "scripts/deep.mts",
      "interface Order { id: number }\nfunction inner(o: Order): number { return o.id; }\ninner(undefined as unknown as Order);\n"
    );
    await flow("deepts", "steps:\n  - script: { path: ../../scripts/deep.mts }\n");

    const { result } = await runFlow("deepts");

    const reason = result.steps[0]!.reason!;
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(reason).toContain("Cannot read properties of undefined");
    expect(reason).toContain("at inner (scripts/deep.mts:2:45)");
  });

  it.runIf(stripsTypes)("fails on syntax that stripping cannot remove", async () => {
    await write("scripts/enum.mts", `enum Color { Red }\nconsole.log(Color.Red);\n`);
    await flow("enumts", "steps:\n  - script: { path: ../../scripts/enum.mts }\n");

    const { result } = await runFlow("enumts");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(result.steps[0]!.reason).toMatch(/enum is not supported/);
  });

  // Node 23 reports such syntax with the line and no file, in the message.
  it.runIf(stripsTypes && process.versions.node.split(".")[0] !== "23")(
    "names the file and the line of such syntax, in an imported file too",
    async () => {
      await write(
        "scripts/svc.mts",
        "export class Svc {\n  constructor(private readonly url: string) {}\n}\n"
      );
      await write(
        "scripts/usesvc.mts",
        `import { Svc } from "./svc.mts";\nconsole.log(new Svc("x"));\n`
      );
      await flow("usesvc", "steps:\n  - script: { path: ../../scripts/usesvc.mts }\n");

      const { result } = await runFlow("usesvc");

      expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
      expect(result.steps[0]!.reason).toBe(
        "TypeScript parameter property is not supported in strip-only mode\\n    at scripts/svc.mts:2"
      );
    }
  );

  // The stack opens with a bare path here, not a URL: Node reads a `.ts` file
  // as CommonJS first when no package.json sets `type`.
  it.runIf(stripsTypes && process.versions.node.split(".")[0] !== "23")(
    "names the file and the line of such syntax in a .ts script with no package type",
    async () => {
      await write("package.json", "{}");
      await write(
        "scripts/enum.ts",
        `const a = 1;\nenum Color { Red }\nconsole.log(Color.Red, a);\n`
      );
      await flow("enumcjs", "steps:\n  - script: { path: ../../scripts/enum.ts }\n");

      const { result } = await runFlow("enumcjs");

      expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
      expect(result.steps[0]!.reason).toBe(
        "TypeScript enum is not supported in strip-only mode\\n    at scripts/enum.ts:2"
      );
    }
  );

  it.runIf(stripsTypes)("fails on a type imported without `import type`", async () => {
    // Stripping works on one file at a time, so it cannot tell that `Order` is
    // a type and leaves the import for Node to resolve.
    await write("scripts/types.mts", "export interface Order { id: number }\n");
    await write(
      "scripts/order.mts",
      `import { Order } from "./types.mts";\nconst order: Order = { id: 1 };\nconsole.log(order.id);\n`
    );
    await flow("order", "steps:\n  - script: { path: ../../scripts/order.mts }\n");

    const { result } = await runFlow("order");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(result.steps[0]!.reason).toContain("does not provide an export named 'Order'");
  });

  it.runIf(stripsTypes)("does not pin the module type of a .ts file it imports", async () => {
    // The extension pins the step's own file and nothing else: the import is
    // CommonJS here, where `export` is not an export.
    await write("package.json", `{ "type": "commonjs" }`);
    await write("tools/db.ts", "export function seedRow(): number { return 7; }\n");
    await write(
      "scripts/usedb.mts",
      `import { seedRow } from "../tools/db.ts";\nconsole.log(seedRow());\n`
    );
    await flow("usedb", "steps:\n  - script: { path: ../../scripts/usedb.mts }\n");

    const { result } = await runFlow("usedb");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail" });
    expect(result.steps[0]!.reason).toContain("does not provide an export named 'seedRow'");
  });

  // Where Node cannot run it, the run is refused before the file is looked for.
  it.runIf(stripsTypes)("reports a missing TypeScript file as missing", async () => {
    await flow("gonets", "steps:\n  - script: { path: ../../scripts/gone.mts }\n");

    const { result } = await runFlow("gonets");

    expect(result.steps[0]).toMatchObject({ status: "fail", kind: "script" });
    expect(result.steps[0]!.reason).toContain('Script "../../scripts/gone.mts" does not exist');
  });
});

/**
 * A host whose Node has no TypeScript support: the `nodejs` package of Debian
 * and Ubuntu, or a Node older than Argent supports. Real child processes, so
 * the refusal is read from what Node itself answers and fails with.
 *
 * On a Node that runs TypeScript, `--no-experimental-strip-types` makes a
 * script's process one that cannot, which is the same state by Node's own
 * switch. On a Node that cannot, there is nothing to turn off.
 */
describe("a TypeScript script step on a host without TypeScript support", () => {
  beforeAll(() => {
    executorInPlace.current = new FlowScriptExecutor({
      nodeOptions: hostRunsTypeScript ? ["--no-experimental-strip-types"] : [],
    });
  });
  afterAll(() => {
    executorInPlace.current = undefined;
  });

  for (const ext of ["mts", "ts"]) {
    it(`refuses a .${ext} script on a Node that cannot run it, before any step`, async () => {
      const marker = path.join(root, "ran.txt");
      await write(
        "scripts/before.mjs",
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`
      );
      await write(`scripts/seed.${ext}`, `const seeded: boolean = true;\nconsole.log(seeded);\n`);
      await flow(
        "oldnode",
        `steps:\n  - script: { path: ../../scripts/before.mjs }\n  - script: { path: ../../scripts/seed.${ext} }\n`
      );

      const refused = await runFlow("oldnode").then(
        () => "",
        (thrown: Error) => thrown.message
      );

      expect(refused).toContain(
        `E2E test "oldnode" was not run. Script "../../scripts/seed.${ext}" is TypeScript, and the tool-server runs on `
      );
      // The JavaScript spelling with the same module type: `.mjs` would
      // break a `.ts` script that is CommonJS.
      expect(refused).toContain(
        ext === "mts"
          ? "or use JavaScript (.mjs) for the script and for the files it imports."
          : "or use JavaScript (.js, or .mjs for an ES module) for the script and for the files it imports."
      );
      expect(fsSync.existsSync(marker)).toBe(false);
    });
  }

  it("errors on TypeScript a .mjs script imports, as the host's limit", async () => {
    await write("scripts/helpers.mts", "export const orderId: number = 4711;\n");
    await write(
      "scripts/entry.mjs",
      `import { orderId } from "./helpers.mts";\nconsole.log(orderId);\n`
    );
    await flow("entry", "steps:\n  - script: { path: ../../scripts/entry.mjs }\n");

    const { result } = await runFlow("entry");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "error" });
    expect(result.steps[0]!.reason).toContain(
      'Script "../../scripts/entry.mjs" loads the TypeScript file "scripts/helpers.mts", and the tool-server runs on '
    );
  });

  it("errors on TypeScript a CommonJS script requires, as the host's limit", async () => {
    // No loader refuses the extension here: Node compiles the file as
    // JavaScript and stops at its first type.
    await write("package.json", `{ "type": "commonjs" }`);
    await write("scripts/helpers.ts", "const orderId: number = 4711;\nmodule.exports = orderId;\n");
    await write("scripts/entry.js", `console.log(require("./helpers.ts"));\n`);
    await flow("requires", "steps:\n  - script: { path: ../../scripts/entry.js }\n");

    const { result } = await runFlow("requires");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "error" });
    expect(result.steps[0]!.reason).toContain(
      'Script "../../scripts/entry.js" loads the TypeScript file "scripts/helpers.ts", and the tool-server runs on '
    );
    expect(result.steps[0]!.reason).toContain(
      "or use JavaScript (.js, or .mjs for an ES module) for the script"
    );
  });
});

describe("a script path is checked at its own step", () => {
  it("reports a missing file with the path it resolved to", async () => {
    await flow("gone", "steps:\n  - script: { path: ../../scripts/gone.mjs }\n");

    const { result } = await runFlow("gone");

    expect(result.steps[0]).toMatchObject({ status: "fail", kind: "script" });
    expect(result.steps[0]!.reason).toContain('Script "../../scripts/gone.mjs" does not exist');
    expect(result.steps[0]!.reason).toMatch(
      /Resolved path: \S*[/\\]\.argent[/\\]flows[/\\]\.\.[/\\]\.\.[/\\]scripts[/\\]gone\.mjs\.$/
    );
  });

  it("reports a path that names a directory rather than a file", async () => {
    await fs.mkdir(path.join(root, "scripts", "seed.mjs"), { recursive: true });
    await flow("dir", "steps:\n  - script: { path: ../../scripts/seed.mjs }\n");

    const { result } = await runFlow("dir");

    expect(result.steps[0]!.reason).toContain("is not a file");
  });

  it("reports a path that walks THROUGH a file as an ordinary missing file", async () => {
    // The kernel answers ENOTDIR, not ENOENT, when a directory component of the
    // path is a regular file. Nothing is there either way, so both read alike.
    await write("scripts/seed.mjs", `console.log("ok");`);
    await flow("through", "steps:\n  - script: { path: ../../scripts/seed.mjs/inner.mjs }\n");

    const { result } = await runFlow("through");

    expect(result.steps[0]).toMatchObject({ status: "fail", kind: "script" });
    expect(result.steps[0]!.reason).toContain("does not exist");
    expect(result.steps[0]!.reason).not.toContain("cannot be read");
  });

  it("reports a stat failure that is neither as its own text, not as absence", async () => {
    const tooLong = `${"n".repeat(300)}.mjs`;
    // The directory has to exist, or the missing component answers ENOENT
    // first and this never reaches the arm under test.
    await write("scripts/seed.mjs", `console.log("ok");`);
    await flow("unreadable", `steps:\n  - script: { path: ../../scripts/${tooLong} }\n`);

    const { result } = await runFlow("unreadable");

    expect(result.steps[0]).toMatchObject({ status: "fail", kind: "script" });
    expect(result.steps[0]!.reason).toContain("cannot be read: ");
    expect(result.steps[0]!.reason).toContain("ENAMETOOLONG");
  });

  it("never checks a path behind a guard that does not fire", async () => {
    await flow(
      "guarded",
      "steps:\n" +
        "  - when:\n" +
        "      platform: android\n" +
        "    steps:\n" +
        "      - script: { path: ../../scripts/nowhere.mjs }\n" +
        "  - echo: reached the end\n"
    );

    const { registry } = mockRegistry({ booted: [DEVICE] });
    const result = await run(registry, { name: "guarded", device: DEVICE });

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => [s.kind, s.status])).toEqual([
      ["when", "skip"],
      ["script", "skip"],
      ["echo", "pass"],
    ]);
  });

  it("refuses a mis-cased path, quoting the spelling on disk", async () => {
    // The one authoring error a local run cannot find: APFS and NTFS open
    // `CreateUser.mjs` for a file really named `createUser.mjs`, and the same
    // tree then fails with ENOENT on Linux CI.
    //
    // Ungated, because the VERDICT is not the filesystem's: classifyOnDiskSpelling
    // compares the supplied basename against readdir's own entries, lowercased,
    // so the refusal reproduces on a case-sensitive host too.
    await write("scripts/createUser.mjs", `console.log("ok");`);
    await flow("cased", "steps:\n  - script: { path: ../../scripts/CreateUser.mjs }\n");

    const { result } = await runFlow("cased");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain(
      'Script path "../../scripts/CreateUser.mjs" has the wrong letter case'
    );
    expect(result.steps[0]!.reason).toContain('Use "../../scripts/createUser.mjs"');
  });

  it("refuses a mis-cased spelling of a script reached through a cross-directory symlink", async () => {
    await fs.mkdir(path.join(root, "lib"), { recursive: true });
    await fs.writeFile(path.join(root, "lib", "real.mjs"), `console.log("ok");`);
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.symlink(
      path.join(root, "lib", "real.mjs"),
      path.join(root, "scripts", "CreateUser.mjs")
    );
    await flow("cased-link", "steps:\n  - script: { path: ../../scripts/createUser.mjs }\n");

    const { result } = await runFlow("cased-link");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain(
      'Script path "../../scripts/createUser.mjs" has the wrong letter case'
    );
  });

  it("asks for a rename when the spelling on disk is one no path could name", async () => {
    await write("scripts/ALT.MJS", `console.log("ok");`);
    await flow("noncase", "steps:\n  - script: { path: ../../scripts/alt.mjs }\n");

    const { result } = await runFlow("noncase");

    expect(result.steps[0]).toMatchObject({ status: "error" });
    expect(result.steps[0]!.reason).toContain('Rename "ALT.MJS" to "alt.mjs"');
    expect(result.steps[0]!.reason).not.toContain("Use");
  });

  it("treats a hyphen difference as an ordinary missing file, not a casing problem", async () => {
    await write("scripts/createUser.mjs", `console.log("ok");`);
    await flow("hyphen", "steps:\n  - script: { path: ../../scripts/create-user.mjs }\n");

    const { result } = await runFlow("hyphen");

    expect(result.steps[0]!.reason).toContain("does not exist");
    expect(result.steps[0]!.reason).not.toContain("wrong letter case");
  });
});

describe("where a script path resolves", () => {
  it("anchors at the flow file that names the step, not the root flow", async () => {
    await write("scripts/shared.mjs", `console.log("shared script ran");`);
    await write(
      path.join(".argent", "flows", "frag", "seed.yaml"),
      "steps:\n  - script: { path: ../../../scripts/shared.mjs }\n"
    );
    await flow("root-a", "steps:\n  - run: frag/seed.yaml\n");
    await write(
      path.join(".argent", "flows", "deep", "root-b.yaml"),
      "steps:\n  - run: ../frag/seed.yaml\n"
    );

    const a = await runFlow("root-a", { booted: [DEVICE], device: DEVICE });
    const bPath = path.join(root, ".argent", "flows", "deep", "root-b.yaml");
    const b = await run(
      mockRegistry({ booted: [DEVICE] }).registry,
      { e2e_test_path: bPath, device: DEVICE },
      boundaryCtx(bPath)
    );

    for (const result of [a.result, b]) {
      const script = result.steps.find((s) => s.kind === "script");
      expect(script, JSON.stringify(result.steps)).toMatchObject({ status: "pass" });
      expect(script!.scriptLog).toContain("shared script ran");
    }
  });

  it("reaches a sibling directory's script through `..`", async () => {
    await write("shared/scripts/seed.mjs", `console.log("sideways");`);
    await write(
      path.join(".argent", "flows", "onboarding", "login.yaml"),
      "steps:\n  - script: { path: ../../../shared/scripts/seed.mjs }\n"
    );
    await flow("compose", "steps:\n  - run: onboarding/login.yaml\n");

    const { result } = await runFlow("compose", { booted: [DEVICE], device: DEVICE });

    expect(result.ok).toBe(true);
    expect(result.steps.find((s) => s.kind === "script")!.scriptLog).toContain("sideways");
  });

  it("resolves a `..` after a symlinked component with kernel semantics", async () => {
    await fs.mkdir(path.join(root, "lex", "other"), { recursive: true });
    await fs.writeFile(path.join(root, "lex", "seed.mjs"), `console.log("kernel-resolved");`);
    await write(path.join(".argent", "flows", "seed.mjs"), `console.log("lexical decoy");`);
    await flow("linked", "steps:\n  - script: { path: link/../seed.mjs }\n");
    await fs.symlink(path.join(root, "lex", "other"), path.join(root, ".argent", "flows", "link"));

    const { result } = await runFlow("linked");

    expect(result.steps[0]).toMatchObject({ status: "pass", kind: "script" });
    expect(result.steps[0]!.scriptLog).toContain("kernel-resolved");
    expect(result.steps[0]!.scriptLog).not.toContain("lexical decoy");
  });

  it("runs a script reached through a symlink under the name the flow spells", async () => {
    await write("scripts/real.mjs", `console.log("through the alias");`);
    await fs.symlink(
      path.join(root, "scripts", "real.mjs"),
      path.join(root, "scripts", "alias.mjs")
    );
    await flow("alias", "steps:\n  - script: { path: ../../scripts/alias.mjs }\n");

    const { result } = await runFlow("alias");

    expect(result.steps[0]).toMatchObject({ status: "pass", kind: "script" });
    expect(result.steps[0]!.scriptLog).toContain("through the alias");
  });

  it("anchors an explicit e2e_test_path at that YAML's own directory", async () => {
    await write("elsewhere/scripts/seed.mjs", `console.log("from e2e_test_path");`);
    await write("elsewhere/standalone.yaml", "steps:\n  - script: { path: scripts/seed.mjs }\n");

    const flowPath = path.join(root, "elsewhere", "standalone.yaml");
    const result = await run(
      mockRegistry().registry,
      { e2e_test_path: flowPath },
      boundaryCtx(flowPath)
    );

    expect(result.ok).toBe(true);
    expect(result.steps[0]!.scriptLog).toContain("from e2e_test_path");
  });

  it("runs the script in project_root, not in the flow file's directory", async () => {
    await write("scripts/cwd.mjs", `console.log(process.cwd());`);
    await write(
      path.join("elsewhere", "standalone.yaml"),
      "steps:\n  - script: { path: ../scripts/cwd.mjs }\n"
    );
    const flowPath = path.join(root, "elsewhere", "standalone.yaml");
    const result = await run(
      mockRegistry().registry,
      { e2e_test_path: flowPath },
      boundaryCtx(flowPath)
    );

    expect(result.ok).toBe(true);
    const reported = fsSync.realpathSync(result.steps[0]!.scriptLog!.trim());
    expect(reported).toBe(fsSync.realpathSync(root));
    expect(reported).not.toBe(fsSync.realpathSync(path.join(root, "elsewhere")));
  });
});

describe("which project root a script runs from", () => {
  /**
   * `flow-add-script` runs the script with the RECORDING's `project_root`; the
   * runner uses the ROOT run's. A fragment recorded in one project and composed
   * by a flow in another therefore runs its script somewhere else than where it
   * was recorded — which is what the tool's "it ran here as a replay of this
   * flow will" is qualified against.
   */
  it("gives a composed fragment's script the ROOT run's project root", async () => {
    const composer = await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-composer-"));
    try {
      await write(
        "scripts/where.mjs",
        `import { writeFileSync } from "node:fs";\n` +
          `writeFileSync("./where.txt", process.cwd());`
      );
      await flow("frag", "steps:\n  - script: { path: ../../scripts/where.mjs }\n");
      const composed = path.join(composer, ".argent", "flows", "main.yaml");
      await fs.mkdir(path.dirname(composed), { recursive: true });
      // `run:` is always relative to the flow file that names it.
      const target = path
        .relative(path.dirname(composed), path.join(root, ".argent", "flows", "frag.yaml"))
        .split(path.sep)
        .join("/");
      await fs.writeFile(composed, `steps:\n  - run: ${target}\n`, "utf8");

      const direct = await runFlow("frag");
      expect(direct.result.ok).toBe(true);
      expect(fsSync.existsSync(path.join(root, "where.txt"))).toBe(true);
      await fs.rm(path.join(root, "where.txt"));

      // A flow that uses `run:` resolves a device even when every leaf is a
      // script — see "still resolves a device when the same flow uses run:".
      const { registry } = mockRegistry({ booted: [DEVICE] });
      const composedRun = await run(registry, {
        project_root: composer,
        name: "main",
        device: DEVICE,
      });

      expect(composedRun.ok).toBe(true);
      expect(fsSync.existsSync(path.join(composer, "where.txt"))).toBe(true);
      expect(fsSync.existsSync(path.join(root, "where.txt"))).toBe(false);
    } finally {
      await fs.rm(composer, { recursive: true, force: true });
    }
  });
});

describe("a script step and the run's device", () => {
  it("lets a script-only flow run with nothing booted", async () => {
    await write("scripts/seed.mjs", `console.log("no device needed");`);
    await flow(
      "deviceless",
      "steps:\n  - echo: seeding\n  - script: { path: ../../scripts/seed.mjs }\n"
    );

    const { result, invokeTool } = await runFlow("deviceless", { booted: [] });

    expect(result.ok).toBe(true);
    expect(result.device).toBe("");
    expect(listedDevices(invokeTool)).toBe(false);
  });

  it("still resolves a device when the same flow uses run:", async () => {
    await write("scripts/seed.mjs", `console.log("seeded");`);
    await write(
      path.join(".argent", "flows", "narrate.yaml"),
      "steps:\n  - echo: nothing but narration\n"
    );
    await flow(
      "with-run",
      "steps:\n  - script: { path: ../../scripts/seed.mjs }\n  - run: narrate.yaml\n"
    );

    const { result, invokeTool } = await runFlow("with-run", { booted: [DEVICE] });

    expect(result.ok).toBe(true);
    expect(result.device).toBe(DEVICE);
    expect(listedDevices(invokeTool)).toBe(true);
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "pass" });
  });
});

describe("a script step in an uploaded flow", () => {
  it("is rejected before anything executes", async () => {
    const uploaded = await write(
      "materialized-upload.yaml",
      "steps:\n  - script: { path: seed.mjs }\n"
    );
    const { registry } = mockRegistry({ booted: [DEVICE] });

    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: root, e2e_test_file: uploaded, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            e2e_test_file: {
              clientPath: "/client/.argent/flows/main.yaml",
              presentOnHost: false,
              viaUpload: true,
            },
          },
        }
      )
    ).rejects.toThrow("step 1: script: { path: seed.mjs }");
  });

  it("is rejected from inside a when: block that would not fire", async () => {
    const uploaded = await write(
      "materialized-upload.yaml",
      "steps:\n  - when:\n      platform: android\n    steps:\n      - script: { path: seed.mjs }\n"
    );
    const { registry } = mockRegistry({ booted: [DEVICE] });

    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "main", project_root: root, e2e_test_file: uploaded, device: DEVICE },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            e2e_test_file: {
              clientPath: "/client/.argent/flows/main.yaml",
              presentOnHost: false,
              viaUpload: true,
            },
          },
        }
      )
    ).rejects.toThrow("step 1 of the when: block at step 1: script: { path: seed.mjs }");
  });
});

describe("cancelling a run that contains a script step", () => {
  it("skips a script that had not started", async () => {
    await write("scripts/seed.mjs", `console.log("must not run");`);
    await flow("pre-cancel", "steps:\n  - script: { path: ../../scripts/seed.mjs }\n");

    const controller = new AbortController();
    controller.abort();
    const { registry } = mockRegistry();
    const result = await run(registry, { name: "pre-cancel" }, {
      signal: controller.signal,
    } as ToolContext);

    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "skip",
      reason: "run aborted",
    });
    expect(result.aborted).toBe(true);
    expect(result.skipped).toBe(1);
  });

  it("errors a script that HAD started, because what it did is still done", async () => {
    const marker = path.join(root, "started.txt");
    await write(
      "scripts/slow.mjs",
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(marker)}, "go");\n` +
        `await new Promise((r) => setTimeout(r, 30000));`
    );
    await flow("mid-cancel", "steps:\n  - script: { path: ../../scripts/slow.mjs }\n  - wait: 1\n");

    const controller = new AbortController();
    const { registry } = mockRegistry();
    const pending = run(registry, { name: "mid-cancel" }, {
      signal: controller.signal,
    } as ToolContext);
    await until(() => fsSync.existsSync(marker), "the script to start");
    controller.abort();

    const result = await pending;
    expect(result.steps[0]).toMatchObject({ kind: "script", status: "error" });
    expect(result.steps[0]!.reason).toMatch(/cancelled/i);
    expect(result.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("says the run was cancelled on the steps after the script, not just under it", async () => {
    // The script's `error` stops the run, so the steps below it take the
    // hard-stop path rather than the abort guard every other cancelled step
    // uses. They still have to say why they did not run: a cancellation is not
    // collateral of a step that failed.
    const marker = path.join(root, "started-2.txt");
    await write(
      "scripts/slow.mjs",
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(marker)}, "go");\n` +
        `await new Promise((r) => setTimeout(r, 30000));`
    );
    await flow(
      "mid-cancel-tail",
      "steps:\n  - script: { path: ../../scripts/slow.mjs }\n  - wait: 1\n  - wait: 1\n"
    );

    const controller = new AbortController();
    const { registry } = mockRegistry();
    const pending = run(registry, { name: "mid-cancel-tail" }, {
      signal: controller.signal,
    } as ToolContext);
    await until(() => fsSync.existsSync(marker), "the script to start");
    controller.abort();

    const result = await pending;
    expect(result.steps.slice(1).map((s) => [s.kind, s.status, s.reason])).toEqual([
      ["wait", "skip", "run aborted"],
      ["wait", "skip", "run aborted"],
    ]);
  });
});
