import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import { typeScriptRefusalReason } from "../../../src/tools/flows/flow-script-step";
import { __resetRecordingsForTesting, parseFlow } from "../../../src/tools/flows/flow-utils";
import type { FlowScriptResult } from "../../../src/tools/flows/script/flow-script-executor";

/**
 * Whether a host runs a TypeScript script, and what a run does on each side of
 * that line. The host's answer is put in by hand, so both sides are covered on
 * every Node the suite runs on — the one CI pins runs TypeScript, and left to
 * the real answer it would never see the refusal. The scripts that really
 * execute are in flow-script-step-run.test.ts.
 */

const { executeMock, stripsTypesMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  stripsTypesMock: vi.fn(),
}));

vi.mock("../../../src/tools/flows/script/flow-script-executor", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/tools/flows/script/flow-script-executor")>();
  return {
    ...actual,
    flowScriptExecutor: () => ({ execute: executeMock, stripsTypes: stripsTypesMock }),
  };
});

const DEVICE = "00000000-0000-0000-0000-0000000000ab";

let root: string;

function outcome(over: Partial<FlowScriptResult>): FlowScriptResult {
  return {
    ok: false,
    log: "",
    logTruncated: false,
    durationMs: 1,
    queuedMs: 0,
    notes: [],
    ...over,
  };
}

const PASSED = outcome({ ok: true, output: {} });

/**
 * What a CommonJS script's `require("./helpers.ts")` fails with where Node
 * compiles the file as JavaScript: a Node with no TypeScript support writes
 * this stack.
 */
function requiredTypeScriptFailure(projectRoot: string): FlowScriptResult["failure"] {
  const helper = path.join(projectRoot, "scripts", "helpers.ts");
  const entry = path.join(projectRoot, "scripts", "entry.js");
  return {
    kind: "runtime",
    message: "Missing initializer in const declaration",
    stack: [
      `${helper}:1`,
      "const orderId: number = 4711;",
      "      ^",
      "",
      "SyntaxError: Missing initializer in const declaration",
      "    at TracingChannel.traceSync (node:diagnostics_channel:322:14)",
      `    at Object.<anonymous> (${entry}:1:11)`,
    ].join("\n"),
  };
}

function mockRegistry(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) =>
      id === "list-devices"
        ? { devices: [{ platform: "ios", udid: DEVICE, state: "Booted" }] }
        : { ok: true }
    ),
    getTool: vi.fn(() => ({ inputSchema: { properties: { udid: {} } } })),
    resolveService: vi.fn(async () => ({
      isConnected: () => true,
      listConnectedBundleIds: () => [],
    })),
  } as unknown as Registry;
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

function runFlow(name: string): Promise<FlowRunResult> {
  return createRunFlowTool(mockRegistry()).execute({}, {
    name,
    project_root: root,
  } as never) as Promise<FlowRunResult>;
}

/** The scripts the executor was asked to run, by file name. */
function executed(): string[] {
  return executeMock.mock.calls.map((call) =>
    path.basename((call[0] as { scriptPath: string }).scriptPath)
  );
}

beforeEach(async () => {
  __resetRecordingsForTesting();
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flow-script-typescript-")));
  for (const file of ["before.mjs", "seed.mts", "seed.ts", "entry.mjs", "entry.js"]) {
    await write(`scripts/${file}`, "");
  }
  executeMock.mockReset();
  executeMock.mockResolvedValue(PASSED);
  stripsTypesMock.mockReset();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

describe("the refusal a host that cannot run TypeScript gives", () => {
  const subject = 'Script "scripts/seed.mts" is TypeScript';

  it("names the Node, the hosts with no support, and the tool-server to stop", () => {
    const reason = typeScriptRefusalReason(subject, "22.22.1");

    expect(reason).toContain(
      'Script "scripts/seed.mts" is TypeScript, and the tool-server runs on Node.js 22.22.1, which cannot run it'
    );
    // The two hosts that answer no: a Node below `engines`, which npm installs
    // past, and a build compiled without the stripper.
    expect(reason).toContain("A release older than Argent supports has none");
    expect(reason).toContain("the nodejs package of Debian and Ubuntu");
    // A tool-server that is already up is reused whatever Node the next command
    // runs on, so switching Node alone brings the same refusal back.
    expect(reason).toContain("Stop the tool-server with `argent server stop`");
    expect(reason).toContain("a current Node.js from nodejs.org");
    expect(reason).toContain(
      "or use JavaScript (.mjs) for the script and for the files it imports"
    );
  });

  it("reads this process's release in the form a user knows it", () => {
    // `process.version` carries a leading "v".
    expect(typeScriptRefusalReason("Script")).toContain(`Node.js ${process.versions.node}, which`);
  });
});

describe("a run with a TypeScript script on a host that could not be asked", () => {
  it("hands the script to Node: a refusal has to rest on an answer", async () => {
    stripsTypesMock.mockResolvedValue(undefined);
    await flow("unasked", "steps:\n  - script: { path: ../../scripts/seed.mts }\n");

    const result = await runFlow("unasked");

    expect(result.ok).toBe(true);
    expect(executed()).toEqual(["seed.mts"]);
  });
});

describe("a run with a TypeScript script on a host that cannot run it", () => {
  beforeEach(() => {
    stripsTypesMock.mockResolvedValue(false);
  });

  it("is refused before its first step, so nothing ahead of the script runs", async () => {
    await flow(
      "mixed",
      [
        "steps:",
        "  - script: { path: ../../scripts/before.mjs }",
        "  - echo: seeded",
        "  - script: { path: ../../scripts/seed.mts }",
        "",
      ].join("\n")
    );

    const err = await runFlow("mixed").then(
      () => undefined,
      (thrown: Error) => thrown
    );

    expect(err?.message).toContain('E2E test "mixed" was not run.');
    expect(err?.message).toContain('Script "../../scripts/seed.mts" is TypeScript');
    expect(err?.message).toContain(`Node.js ${process.versions.node}`);
    expect(err?.message).toContain("argent server stop");
    // Scoped to this e2e test, so a directory run goes on to the next one, and
    // not the code that would have the CLI call the file invalid.
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_SCRIPT_TYPESCRIPT_UNSUPPORTED,
      error_kind: "validation",
    });
    expect(executed()).toEqual([]);
  });

  it.each([
    ["mts", "or use JavaScript (.mjs) for the script and for the files it imports."],
    // `.mjs` would break a `.ts` script that is CommonJS, so its twin is `.js`.
    [
      "ts",
      "or use JavaScript (.js, or .mjs for an ES module) for the script and for the files it imports.",
    ],
  ])("refuses a .%s script, and names the JavaScript extension to use", async (ext, advice) => {
    await flow(
      "spelled",
      [
        "steps:",
        "  - script: { path: ../../scripts/before.mjs }",
        `  - script: { path: ../../scripts/seed.${ext} }`,
        "",
      ].join("\n")
    );

    const err = await runFlow("spelled").then(
      () => undefined,
      (thrown: Error) => thrown
    );

    expect(err?.message).toContain(`Script "../../scripts/seed.${ext}" is TypeScript`);
    expect(err?.message).toContain(advice);
    expect(getFailureSignal(err)).toMatchObject({
      error_code: FAILURE_CODES.FLOW_SCRIPT_TYPESCRIPT_UNSUPPORTED,
    });
    expect(executed()).toEqual([]);
  });

  it("does not record a .ts script either", async () => {
    await flowStartRecordingTool.execute({}, { name: "recordedts", project_root: root });

    const recorded = await flowAddScriptTool.execute({}, {
      name: "recordedts",
      project_root: root,
      path: "../../scripts/seed.ts",
    } as never);

    expect(recorded.status).toBe("error");
    expect(recorded.reason).toContain('Script "../../scripts/seed.ts" is TypeScript');
    expect(recorded.reason).toContain("or use JavaScript (.js, or .mjs for an ES module)");
    expect(executed()).toEqual([]);
  });

  it("is refused for a script under a when: guard, whichever way the guard would go", async () => {
    await flow(
      "guarded",
      [
        "steps:",
        "  - script: { path: ../../scripts/before.mjs }",
        "  - when: { platform: android }",
        "    steps:",
        "      - script: { path: ../../scripts/seed.mts }",
        "",
      ].join("\n")
    );

    await expect(runFlow("guarded")).rejects.toThrow(/seed\.mts" is TypeScript/);
    expect(executed()).toEqual([]);
  });

  it("refuses a run: fragment whole, at the step that loads it", async () => {
    await flow(
      "fragment",
      [
        "steps:",
        "  - script: { path: ../../scripts/before.mjs }",
        "  - script: { path: ../../scripts/seed.mts }",
        "",
      ].join("\n")
    );
    await flow("composed", "steps:\n  - run: fragment.yaml\n");

    const result = await runFlow("composed");

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ kind: "run", status: "error" });
    expect(result.steps[0]!.reason).toContain('fragment "fragment.yaml" cannot run.');
    expect(result.steps[0]!.reason).toContain('Script "../../scripts/seed.mts" is TypeScript');
    expect(executed()).toEqual([]);
  });

  it("does not record the script, and says that nothing ran", async () => {
    await flowStartRecordingTool.execute({}, { name: "recorded", project_root: root });

    const recorded = await flowAddScriptTool.execute({}, {
      name: "recorded",
      project_root: root,
      path: "../../scripts/seed.mts",
    } as never);

    expect(recorded.status).toBe("error");
    expect(recorded.reason).toContain('Script "../../scripts/seed.mts" is TypeScript');
    expect(recorded.message).toContain('Script "../../scripts/seed.mts" did not run;');
    expect(executed()).toEqual([]);
    expect(
      parseFlow(await fs.readFile(path.join(root, ".argent", "e2e", "recorded.yaml"), "utf8")).steps
    ).toEqual([]);
  });

  it("reads an imported TypeScript file Node could not load as the same host limit", async () => {
    // Nothing before the run shows this one: the step names a .mjs file.
    executeMock.mockResolvedValue(
      outcome({
        failure: {
          kind: "load",
          message: `Unknown file extension ".mts" for ${path.join(root, "scripts", "helpers.mts")}`,
          stack: `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".mts" for ${path.join(root, "scripts", "helpers.mts")}\n    at Object.getFileProtocolModuleFormat (node:internal/modules/esm/get_format:189:9)`,
        },
        notes: ["timeout clamped to 300000ms."],
      })
    );
    await flow("imports", "steps:\n  - script: { path: ../../scripts/entry.mjs }\n");

    const result = await runFlow("imports");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "error" });
    expect(result.steps[0]!.reason).toContain(
      'Script "../../scripts/entry.mjs" loads the TypeScript file "scripts/helpers.mts", and the tool-server runs on'
    );
    expect(result.steps[0]!.reason).toContain("argent server stop");
    expect(result.steps[0]!.reason).toMatch(/timeout clamped to 300000ms\.$/);
    expect(executed()).toEqual(["entry.mjs"]);
  });

  it("reads a TypeScript file a CommonJS script could not require as the same host limit", async () => {
    // The CommonJS loader refuses no extension: it compiles the file as
    // JavaScript, so the failure is a SyntaxError at the first type, and only
    // the place the stack opens with names the file.
    executeMock.mockResolvedValue(outcome({ failure: requiredTypeScriptFailure(root) }));
    await flow("requires", "steps:\n  - script: { path: ../../scripts/entry.js }\n");

    const result = await runFlow("requires");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "error" });
    expect(result.steps[0]!.reason).toContain(
      'Script "../../scripts/entry.js" loads the TypeScript file "scripts/helpers.ts", and the tool-server runs on'
    );
    expect(result.steps[0]!.reason).toMatch(
      /or use JavaScript \(\.js, or \.mjs for an ES module\) for the script and for the files it imports\.$/
    );
  });

  it("leaves a syntax error in a JavaScript file a script requires as the script's own", async () => {
    const helper = path.join(root, "scripts", "helpers.js");
    executeMock.mockResolvedValue(
      outcome({
        failure: {
          kind: "runtime",
          message: "Unexpected token ')'",
          stack: `${helper}:1\nfoo();)\n      ^\n\nSyntaxError: Unexpected token ')'`,
        },
      })
    );
    await flow("requires", "steps:\n  - script: { path: ../../scripts/entry.js }\n");

    const result = await runFlow("requires");

    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "fail",
      reason: "Unexpected token ')'\\n    at scripts/helpers.js:1",
    });
  });

  it.each([
    ["an extension no Node reads", "load", 'Unknown file extension ".tsx" for /p/view.tsx'],
    ["a script that threw the same words", "runtime", 'Unknown file extension ".mts" for /p/a.mts'],
  ] as const)("leaves %s as the script's own failure", async (_label, kind, message) => {
    executeMock.mockResolvedValue(outcome({ failure: { kind, message } }));
    await flow("imports", "steps:\n  - script: { path: ../../scripts/entry.mjs }\n");

    const result = await runFlow("imports");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail", reason: message });
  });

  it("never asks about a run that holds no TypeScript script", async () => {
    await flow("plain", "steps:\n  - script: { path: ../../scripts/before.mjs }\n");

    const result = await runFlow("plain");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "pass" });
    expect(stripsTypesMock).not.toHaveBeenCalled();
  });
});

describe("a run with a TypeScript script on a host that runs it", () => {
  beforeEach(() => {
    stripsTypesMock.mockResolvedValue(true);
  });

  it("hands every script to Node, the TypeScript one included", async () => {
    await flow(
      "mixed",
      [
        "steps:",
        "  - script: { path: ../../scripts/before.mjs }",
        "  - script: { path: ../../scripts/seed.mts }",
        "",
      ].join("\n")
    );

    const result = await runFlow("mixed");

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.status)).toEqual(["pass", "pass"]);
    expect(executed()).toEqual(["before.mjs", "seed.mts"]);
  });

  it("leaves a syntax error in a TypeScript file a script requires as the script's own", async () => {
    // The same stack as on a host that cannot: here Node did strip the types,
    // so what is left is the file's fault, and its place still leads the frames.
    executeMock.mockResolvedValue(outcome({ failure: requiredTypeScriptFailure(root) }));
    await flow("requires", "steps:\n  - script: { path: ../../scripts/entry.js }\n");

    const result = await runFlow("requires");

    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "fail",
      reason:
        "Missing initializer in const declaration\\n    at scripts/helpers.ts:1\\n" +
        "    at Object.<anonymous> (scripts/entry.js:1:11)",
    });
  });

  it("leaves a TypeScript file Node could not load as the script's own failure", async () => {
    const message = 'Unknown file extension ".mts" for /elsewhere/helpers.mts';
    executeMock.mockResolvedValue(outcome({ failure: { kind: "load", message } }));
    await flow("imports", "steps:\n  - script: { path: ../../scripts/entry.mjs }\n");

    const result = await runFlow("imports");

    expect(result.steps[0]).toMatchObject({ kind: "script", status: "fail", reason: message });
  });
});

describe("the place of syntax Node cannot strip", () => {
  beforeEach(() => {
    stripsTypesMock.mockResolvedValue(true);
  });

  it("leads the frames, because Node names it above the error and in no frame", async () => {
    // The stack as Node 22.18 and 24 write it for a parameter property in an
    // imported file: the place, the line, a caret, and loader frames only.
    const svc = pathToFileURL(path.join(root, "scripts", "svc.mts")).href;
    executeMock.mockResolvedValue(
      outcome({
        failure: {
          kind: "load",
          message: "TypeScript parameter property is not supported in strip-only mode",
          stack: [
            `${svc}:2`,
            "export class Svc {",
            "  constructor(private readonly url: string) {}",
            "                               ^^^^^^^^^^^",
            "}",
            "",
            "SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode",
            "    at parseTypeScript (node:internal/modules/typescript:68:40)",
            "    at processTypeScriptCode (node:internal/modules/typescript:146:42)",
          ].join("\n"),
        },
      })
    );
    await flow("strip", "steps:\n  - script: { path: ../../scripts/seed.mts }\n");

    const result = await runFlow("strip");

    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "fail",
      reason:
        "TypeScript parameter property is not supported in strip-only mode\\n    at scripts/svc.mts:2",
    });
  });

  it("leads the frames when Node names it as a bare path, as its CommonJS loader does", async () => {
    // A `.ts` script under a package.json with no `type`, and every file a
    // script `require`s: no `file:` URL, the same place.
    const seed = path.join(root, "scripts", "seed.ts");
    executeMock.mockResolvedValue(
      outcome({
        failure: {
          kind: "load",
          message: "TypeScript enum is not supported in strip-only mode",
          stack: [
            `${seed}:2`,
            "enum Color { Red }",
            "^^^^^^^^^^^^^^^^^^",
            "",
            "SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode",
            "    at parseTypeScript (node:internal/modules/typescript:68:40)",
          ].join("\n"),
        },
      })
    );
    await flow("stripcjs", "steps:\n  - script: { path: ../../scripts/seed.ts }\n");

    const result = await runFlow("stripcjs");

    expect(result.steps[0]).toMatchObject({
      kind: "script",
      status: "fail",
      reason: "TypeScript enum is not supported in strip-only mode\\n    at scripts/seed.ts:2",
    });
  });

  it("adds nothing for a stack that opens with the error, as every other one does", async () => {
    const seed = pathToFileURL(path.join(root, "scripts", "seed.mts")).href;
    executeMock.mockResolvedValue(
      outcome({
        failure: {
          kind: "runtime",
          message: `boom at ${seed}:9`,
          stack: `Error: boom at ${seed}:9\n    at inner (${seed}:2:45)\n    at node:internal/modules/run_main:123:5`,
        },
      })
    );
    await flow("thrown", "steps:\n  - script: { path: ../../scripts/seed.mts }\n");

    const result = await runFlow("thrown");

    expect(result.steps[0]!.reason).toBe(
      `boom at ${seed}:9\\n    at inner (scripts/seed.mts:2:45)`
    );
  });
});
