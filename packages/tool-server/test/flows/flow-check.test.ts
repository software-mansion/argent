import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ArtifactStore, Registry } from "@argent/registry";
import { z } from "zod";
import { resolveFileInputs } from "../../src/file-inputs";
import { createCheckFlowTool } from "../../src/tools/flows/flow-check";
import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { gestureSwipeTool } from "../../src/tools/gesture-swipe";
import { createKeyboardTool } from "../../src/tools/keyboard";
import { createTvRemoteTool } from "../../src/tools/tv-remote";

vi.mock("../../src/utils/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/capability")>();
  return {
    ...actual,
    isFlagOffered: (flag: string) =>
      flag.startsWith("test-") ? flag === "test-on" : actual.isFlagOffered(flag),
  };
});

/** A tool that a test e2e test calls, behind a feature flag. */
function flaggedTool(id: string, featureFlag: string) {
  return {
    id,
    description: "",
    zodSchema: z.object({}),
    featureFlag,
    services: () => ({}),
    execute: async () => ({}),
  };
}

describe("e2e-check", () => {
  let root: string;
  const registry = new Registry();
  registry.registerTool(gestureSwipeTool);
  registry.registerTool(createKeyboardTool(registry));
  registry.registerTool(createTvRemoteTool(registry));
  registry.registerTool(createRunFlowTool(registry));
  registry.registerTool(flaggedTool("flag-on-tool", "test-on"));
  registry.registerTool(flaggedTool("flag-off-tool", "test-off"));
  const tool = createCheckFlowTool(registry);
  const swipe = "      fromX: 0.5\n      fromY: 0.5\n      toX: 0.5\n      toY: 0.2\n";

  const e2eDir = () => path.join(root, ".argent", "e2e");
  const write = async (name: string, text: string): Promise<void> => {
    await fsp.mkdir(e2eDir(), { recursive: true });
    await fsp.writeFile(path.join(e2eDir(), `${name}.yaml`), text);
  };
  const check = (name: string) => tool.execute({}, { name, project_root: root });

  /**
   * The call as the argent client sends it over a link: the test's bytes and
   * the files it reaches. `afterSend` changes the files on disk before the
   * tool-server checks what the client sent.
   */
  async function checkLinked(name: string, afterSend?: () => Promise<void>) {
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
    await afterSend?.();
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
    await write(
      "bad-steps",
      "steps:\n  - bogus: 1\n  - tool: gesture-swpie\n  - tap: { bogus: 2 }\n" +
        "  - when: { platform: ios }\n    steps:\n      - echo: fine\n      - nope: 3\n"
    );
    await write("bad-top", "bogus: 1\nsteps:\n  - nope: 1\n  - nope: 2\n");
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
    await write("chain", "steps:\n  - run: mid.yaml\n");
    await write("mid", "steps:\n  - echo: mid\n  - run: bad-frag.yaml\n");
    await write("bad-frag", "steps:\n  - bogus: 1\n");
    await write("bad-frag-twice", "steps:\n  - run: bad-frag.yaml\n  - run: mid.yaml\n");
    await write(
      "retired-frag",
      `steps:\n  - tool: gesture-swipe\n    args:\n${swipe}      settle: true\n`
    );
    await write("twice", "steps:\n  - run: retired-frag.yaml\n  - run: retired-frag.yaml\n");
    await write(
      "nests",
      `steps:\n  - tool: e2e-execute\n    args:\n      e2e_test_path: ${path.join(root, ".argent", "e2e", "retired.yaml")}\n      project_root: ${root}\n`
    );
    await write("loop", "steps:\n  - run: loop-frag.yaml\n");
    await write(
      "loop-frag",
      `steps:\n  - tool: e2e-execute\n    args:\n      e2e_test_path: ${path.join(root, ".argent", "e2e", "loop.yaml")}\n      project_root: ${root}\n`
    );
    await write("deep", "steps:\n  - run: s.yaml\n  - run: c1.yaml\n");
    for (let i = 1; i <= 18; i++) {
      await write(`c${i}`, `steps:\n  - run: ${i === 18 ? "s" : `c${i + 1}`}.yaml\n`);
    }
    await write("s", "steps:\n  - run: leaf.yaml\n");
    await write("leaf", "steps:\n  - echo: leaf\n");
    await write("saved", "steps:\n  - echo: saved\n");
    await write(
      "nests-name",
      `steps:\n  - tool: e2e-execute\n    args:\n      name: Saved\n      project_root: ${root}\n`
    );
    await write(
      "steps",
      "steps:\n  - tool: gesture-swpie\n  - tool: gesture-swipe\n    args:\n      fromX: left\n" +
        "  - tool: keyboard\n  - tool: flag-on-tool\n  - tool: flag-off-tool\n" +
        "  - script: { path: scripts/missing.mjs }\n"
    );
    await write("uses-frag", "steps:\n  - run: steps-frag.yaml\n");
    await write(
      "steps-frag",
      "steps:\n  - echo: frag\n  - tool: keyboard\n    args:\n      udid: abc\n      text: 1234\n"
    );
    await write("scripted", "steps:\n  - script: { path: scripts/setup.mjs }\n");
  });

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("finds no problem in a valid test", async () => {
    expect(await check("good")).toEqual({ problems: [] });
  });

  it("reports the parse error of a step that does not parse, with its code", async () => {
    expect((await check("broken")).problems).toEqual([
      {
        at: [{ step: 1 }],
        code: "FLOW_ENTRY_UNRECOGNIZED",
        message: 'Unrecognized e2e test entry (unrecognized step kind): {"bogus":1}',
      },
    ]);
  });

  it("reports every step that does not parse, and no other check of that file", async () => {
    const { problems } = await check("bad-steps");

    expect(problems.map((p) => p.at)).toEqual([
      [{ step: 1 }],
      [{ step: 3 }],
      [{ step: 4, when: true }, { step: 2 }],
    ]);
  });

  it("reports a file error once, without the steps under it", async () => {
    expect((await check("bad-top")).problems).toEqual([
      expect.objectContaining({
        message:
          "Invalid e2e test file: unknown key `bogus` — allowed top-level keys: version, executionPrerequisite, requires, env, steps, shutdown",
      }),
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

  it("reports a step of a run: fragment that does not parse through the steps that reach it", async () => {
    expect((await check("chain")).problems).toEqual([
      {
        at: [{ step: 1, run: "mid.yaml" }, { step: 2, run: "bad-frag.yaml" }, { step: 1 }],
        message: 'Unrecognized e2e test entry (unrecognized step kind): {"bogus":1}',
      },
    ]);
  });

  it("reports a fragment step that does not parse once when a deeper step reaches it again", async () => {
    expect((await check("bad-frag-twice")).problems).toHaveLength(1);
  });

  it("reports a fragment that two steps reach once", async () => {
    expect((await check("twice")).problems).toEqual([
      {
        at: [{ step: 1 }],
        message: expect.stringContaining(
          'fragment "retired-frag.yaml" step 1 as written (echo included) passes gesture-swipe\'s retired `settle` key'
        ),
      },
    ]);
  });

  it("applies the root checks to a test an e2e-execute step runs, without a code", async () => {
    expect((await check("nests")).problems).toEqual([
      {
        at: [{ step: 1 }],
        message: expect.stringContaining(
          'E2E test "retired" step 2 as written (echo included) passes gesture-swipe\'s retired `settle` key'
        ),
      },
    ]);
  });

  it("reports a cycle through a fragment and a nested test", async () => {
    expect((await check("loop")).problems).toEqual([
      {
        at: [{ step: 1, run: "loop-frag.yaml" }, { step: 1 }],
        message: "cyclic e2e test reference: loop → loop-frag → loop",
      },
    ]);
  });

  it("follows a fragment again when a deeper step reaches it, where its runs pass the depth limit", async () => {
    const { problems } = await check("deep");

    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toBe("max run depth exceeded");
    const at = problems[0]!.at!;
    expect(at[0]).toEqual({ step: 2, run: "c1.yaml" });
    expect(at.slice(-2)).toEqual([{ step: 1, run: "s.yaml" }, { step: 1 }]);
  });

  it("finds a nested test by name as e2e-execute does, refusing a mis-cased name", async () => {
    expect((await check("nests-name")).problems).toEqual([
      {
        at: [{ step: 1 }],
        message: expect.stringContaining('Invalid e2e test name "Saved"'),
      },
    ]);
  });

  it("reports unknown tools, tools behind a flag that is off, refused arguments and missing scripts", async () => {
    expect((await check("steps")).problems).toEqual([
      { at: [{ step: 1 }], message: 'Tool "gesture-swpie" not found' },
      {
        at: [{ step: 2 }],
        message: expect.stringContaining('Invalid params for tool "gesture-swipe": `fromX`'),
      },
      { at: [{ step: 5 }], message: 'Tool "flag-off-tool" not found' },
      {
        at: [{ step: 6 }],
        message: `Script "scripts/missing.mjs" does not exist. Resolved path: ${path.join(e2eDir(), "scripts", "missing.mjs")}.`,
      },
    ]);
  });

  it("reports a refused tool argument in a run: fragment on the step that reaches it", async () => {
    expect((await check("uses-frag")).problems).toEqual([
      {
        at: [{ step: 1, run: "steps-frag.yaml" }, { step: 2 }],
        message: expect.stringContaining('Invalid params for tool "keyboard": `text`'),
      },
    ]);
  });

  it("names the nested test and the when: block on the way to a problem", async () => {
    await write(
      "levels",
      `steps:\n  - tool: e2e-execute\n    args:\n      name: levels-nested\n      project_root: ${root}\n`
    );
    await write(
      "levels-nested",
      "steps:\n  - when: { platform: ios }\n    steps:\n      - echo: fine\n      - tool: gesture-swpie\n"
    );

    expect((await check("levels")).problems).toEqual([
      {
        at: [{ step: 1, e2e: "levels-nested" }, { step: 1, when: true }, { step: 2 }],
        message: 'Tool "gesture-swpie" not found',
      },
    ]);
  });

  it("reports arguments that a tool's refinement refuses", async () => {
    await write(
      "two-sources",
      `steps:\n  - tool: e2e-execute\n    args:\n      name: saved\n      e2e_test_path: ${path.join(e2eDir(), "saved.yaml")}\n      project_root: ${root}\n`
    );

    expect((await check("two-sources")).problems).toEqual([
      {
        at: [{ step: 1 }],
        message: expect.stringContaining("Pass exactly one e2e test source"),
      },
    ]);
  });

  it.each(["up,down", '["up","down"]', " select "])(
    "accepts the tv-remote button string %j that the tool converts",
    async (button) => {
      await write(
        "tv",
        `steps:\n  - tool: tv-remote\n    args:\n      button: ${JSON.stringify(button)}\n`
      );

      expect(await check("tv")).toEqual({ problems: [] });
    }
  );

  describe("over a link", () => {
    it("reports the refusal of a test that is not self-contained, as e2e-execute does", async () => {
      expect((await checkLinked("scripted")).problems).toEqual([
        { code: "FLOW_FILE_INVALID", message: expect.stringContaining("script:") },
      ]);
    });

    it("checks the fragments and the nested tests the client sent, not the files on this host", async () => {
      await write(
        "sent-frag",
        `steps:\n  - tool: gesture-swipe\n    args:\n${swipe}      settle: true\n`
      );
      await write(
        "sent-nested",
        `steps:\n  - tool: gesture-swipe\n    args:\n${swipe}      settle: true\n`
      );
      await write(
        "linked",
        "steps:\n  - run: sent-frag.yaml\n  - tool: e2e-execute\n    args:\n" +
          `      name: sent-nested\n      project_root: ${root}\n`
      );
      const replaceOnHost = async () => {
        await write("sent-frag", "steps:\n  - echo: fine\n");
        await write("sent-nested", "steps:\n  - echo: fine\n");
      };

      expect((await checkLinked("linked", replaceOnHost)).problems).toEqual([
        { at: [{ step: 1 }], message: expect.stringContaining('fragment "sent-frag.yaml" step 1') },
        {
          at: [{ step: 2 }],
          message: expect.stringContaining("passes gesture-swipe's retired `settle` key"),
        },
      ]);
    });
  });
});
