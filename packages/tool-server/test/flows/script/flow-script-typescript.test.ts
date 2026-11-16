import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { FAILURE_CODES, getFailureSignal, type Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../../src/tools/flows/flow-run";
import { flowStartRecordingTool } from "../../../src/tools/flows/flow-start-recording";
import { flowAddScriptTool } from "../../../src/tools/flows/flow-add-script";
import {
  nodeStripsTypes,
  typeScriptGap,
  typeScriptRefusalReason,
} from "../../../src/tools/flows/flow-script-step";
import { __resetRecordingsForTesting, parseFlow } from "../../../src/tools/flows/flow-utils";
import type { FlowScriptResult } from "../../../src/tools/flows/script/flow-script-executor";

/**
 * Whether a host runs a TypeScript script, and what a run does on each side of
 * that line. The host's answer is put in by hand, so both sides are covered on
 * every Node the suite runs on — the one CI pins runs no TypeScript at all, and
 * left to the real answer it would only ever see the refusal. The scripts that
 * really execute are in flow-script-step-run.test.ts.
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
  for (const file of ["before.mjs", "seed.mts", "entry.mjs"]) await write(`scripts/${file}`, "");
  executeMock.mockReset();
  executeMock.mockResolvedValue(PASSED);
  stripsTypesMock.mockReset();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(root, { recursive: true, force: true });
});

describe("whether a host runs TypeScript", () => {
  it("runs it when the script process says it strips types, whatever the release", () => {
    for (const version of ["20.19.5", "22.17.1", "23.5.0", "24.9.0"]) {
      expect(typeScriptGap(true, version), version).toBeUndefined();
    }
  });

  it("blames the release when the release cannot", () => {
    for (const version of ["20.19.5", "22.6.0", "22.17.1", "23.0.0", "23.5.0"]) {
      expect(typeScriptGap(false, version), version).toBe("release");
      // A host that could not be asked is still one the release rules out.
      expect(typeScriptGap(undefined, version), version).toBe("release");
    }
  });

  it("blames the build when the release can and the binary cannot", () => {
    // The `nodejs` package of Debian and Ubuntu: configured --without-amaro.
    for (const version of ["22.18.0", "22.22.1", "23.6.0", "24.0.0", "24.22.2", "26.13.0"]) {
      expect(typeScriptGap(false, version), version).toBe("build");
    }
  });

  it("goes by the release when the binary could not be asked", () => {
    for (const version of ["22.18.0", "23.6.0", "24.9.0"]) {
      expect(typeScriptGap(undefined, version), version).toBeUndefined();
    }
  });

  it("reads this process's release in the form the table is written in", () => {
    // `process.version` carries a leading "v", which parses to no release at
    // all: every host would then be one whose release cannot.
    for (const strips of [true, false, undefined]) {
      expect(typeScriptGap(strips)).toBe(typeScriptGap(strips, process.versions.node));
    }
    expect(nodeStripsTypes()).toBe(nodeStripsTypes(process.versions.node));
    expect(typeScriptRefusalReason("Script", "release")).toContain(
      `Node.js ${process.versions.node}, which`
    );
  });
});

describe("the refusal a host that cannot run TypeScript gives", () => {
  const subject = 'Script "scripts/seed.mts" is TypeScript';

  it("names the release, the releases that can, and the tool-server to stop", () => {
    const reason = typeScriptRefusalReason(subject, "release", "20.19.5");

    expect(reason).toContain(
      'Script "scripts/seed.mts" is TypeScript, and the tool-server runs on Node.js 20.19.5, which cannot run it.'
    );
    expect(reason).toContain("Node.js runs TypeScript from 22.18, except on 23.0 to 23.5.");
    // A tool-server that is already up is reused whatever Node the next command
    // runs on, so switching Node alone brings the same refusal back.
    expect(reason).toContain("Stop the tool-server with `argent server stop`");
    expect(reason).toContain(
      "or use JavaScript (.mjs) for the script and for the files it imports"
    );
  });

  it("does not send a 23.5 host to a minimum it already meets", () => {
    const reason = typeScriptRefusalReason(subject, "release", "23.5.0");

    expect(reason).toContain("runs on Node.js 23.5.0, which cannot run it");
    expect(reason).toContain("except on 23.0 to 23.5");
    expect(reason).not.toMatch(/22\.18 or later/);
  });

  it("sends a build without the support to another build, not to another release", () => {
    const reason = typeScriptRefusalReason(subject, "build", "22.22.1");

    expect(reason).toContain("runs on a build of Node.js 22.22.1 that cannot run it");
    expect(reason).toContain("the build has no TypeScript support");
    expect(reason).toContain("Stop the tool-server with `argent server stop`");
    expect(reason).toContain("a Node.js from nodejs.org");
    expect(reason).not.toContain("22.18");
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
