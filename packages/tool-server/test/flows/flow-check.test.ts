import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ArtifactStore, Registry } from "@argent/registry";
import { resolveFileInputs } from "../../src/file-inputs";
import { createCheckFlowTool } from "../../src/tools/flows/flow-check";
import { gestureSwipeTool } from "../../src/tools/gesture-swipe";

describe("e2e-check", () => {
  let root: string;
  const registry = new Registry();
  registry.registerTool(gestureSwipeTool);
  const tool = createCheckFlowTool(registry);
  const swipe = "      fromX: 0.5\n      fromY: 0.5\n      toX: 0.5\n      toY: 0.2\n";

  const e2eDir = () => path.join(root, ".argent", "e2e");
  const write = async (name: string, text: string): Promise<void> => {
    await fsp.mkdir(e2eDir(), { recursive: true });
    await fsp.writeFile(path.join(e2eDir(), `${name}.yaml`), text);
  };
  const check = (name: string) => tool.execute({}, { name, project_root: root });

  /** The call as the argent client sends it over a link: the test's bytes and the files it reaches. */
  async function checkLinked(name: string) {
    const client = path.resolve(__dirname, "../../../argent-tools-client/src");
    const { prepareFileInputs } = (await import(path.join(client, "file-inputs.ts"))) as {
      prepareFileInputs(specs: unknown, args: unknown, opts: object): Promise<unknown>;
    };
    const { collectFlowMembers } = (await import(path.join(client, "flow-files.ts"))) as {
      collectFlowMembers: unknown;
    };
    const args = { e2e_test_path: path.join(e2eDir(), `${name}.yaml`), project_root: root };
    const wire = await prepareFileInputs(tool.fileInputs, args, {
      includeContent: true,
      collectMembers: collectFlowMembers,
    });
    const boundary = await resolveFileInputs(tool, wire as Record<string, unknown>);
    try {
      return await tool.execute({}, boundary.args as typeof args, {
        artifacts: new ArtifactStore(),
        fileInputs: boundary.fileInputs,
      });
    } finally {
      await boundary.cleanup();
    }
  }

  beforeAll(async () => {
    root = await fsp.realpath(await fsp.mkdtemp(path.join(tmpdir(), "argent-e2e-check-")));
    await write("good", `steps:\n  - tool: gesture-swipe\n    args:\n${swipe}`);
    await write("broken", "steps:\n  - bogus: 1\n");
    await write("start", "steps:\n  - launch: com.example.app\n");
    await write(
      "prereq",
      "executionPrerequisite: logged in\nsteps:\n  - run: start.yaml\n" +
        `  - tool: gesture-swipe\n    args:\n${swipe}      settle: true\n`
    );
    await write(
      "retired",
      `steps:\n  - echo: first\n  - tool: gesture-swipe\n    args:\n${swipe}      settle: true\n`
    );
    await write("scripted", "steps:\n  - script: { path: scripts/setup.mjs }\n");
  });

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("finds no problem in a valid test", async () => {
    expect(await check("good")).toEqual({ problems: [] });
  });

  it("reports the parse error of a file that does not parse, with its code", async () => {
    expect((await check("broken")).problems).toEqual([
      { code: "FLOW_ENTRY_UNRECOGNIZED", message: expect.stringContaining('{"bogus":1}') },
    ]);
  });

  it("reports a retired tool arg with the code e2e-execute gives", async () => {
    expect((await check("retired")).problems).toEqual([
      {
        code: "FLOW_FILE_INVALID",
        message: expect.stringContaining(
          'E2E test "retired" step 2 as written (echo included) passes gesture-swipe\'s retired `settle` key'
        ),
      },
    ]);
  });

  it("reports every problem it finds, the leading launch under executionPrerequisite included", async () => {
    const { problems } = await check("prereq");

    expect(problems).toHaveLength(2);
    expect(problems[0]!.message).toContain("passes gesture-swipe's retired `settle` key");
    expect(problems[1]!.message).toBe(
      'An e2e test whose leading run: chain reaches a launch step must not declare executionPrerequisite — it launches its own app and controls its start state. Drop the leading launch in "start" to make it a fragment, or drop executionPrerequisite from "prereq".'
    );
  });

  describe("over a link", () => {
    it("reports the refusal of a test that is not self-contained, as e2e-execute does", async () => {
      expect((await checkLinked("scripted")).problems).toEqual([
        { code: "FLOW_FILE_INVALID", message: expect.stringContaining("script:") },
      ]);
    });
  });
});
