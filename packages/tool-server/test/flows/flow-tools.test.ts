import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolContext } from "@argent/registry";
import {
  ArtifactStore,
  FAILURE_CODES,
  getFailureSignal,
  Registry,
  zodObjectToJsonSchema,
} from "@argent/registry";

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { flowInsertEchoTool } from "../../src/tools/flows/flow-insert-echo";
import {
  flowFinishRecordingTool,
  summarizeStep,
} from "../../src/tools/flows/flow-finish-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import {
  createRunFlowTool,
  resolveFlowSource,
  type FlowRunResult,
  type FlowPrerequisiteNotice,
} from "../../src/tools/flows/flow-run";
import { flowReadPrerequisiteTool } from "../../src/tools/flows/flow-read-prerequisite";
import {
  __resetRecordingsForTesting,
  flowsDirFor,
  getRecordingSession,
  parseFlow,
  serializeFlow,
  type FlowFile,
  type FlowStep,
} from "../../src/tools/flows/flow-utils";

// Re-export `node:fs/promises` untouched, so `vi.spyOn` can swap one call out:
// an ESM namespace object is not configurable, and the unreadable-file case
// below needs `readFile` to fail the way EACCES does.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

/**
 * The flow as PERSISTED. The recorder deliberately no longer returns the whole
 * growing YAML per step (it was the single largest consumer of a session's
 * context), so the file on disk is the assertion surface.
 */
async function onDisk(name: string, root = tmpDir): Promise<string> {
  return fs.readFile(path.join(root, ".argent", "flows", `${name}.yaml`), "utf8");
}

// ── Helpers ──────────────────────────────────────────────────────────

function assertFlowRunResult(
  r: FlowRunResult | FlowPrerequisiteNotice
): asserts r is FlowRunResult {
  if (!("steps" in r)) {
    throw new Error(`expected FlowRunResult, got prerequisite notice: ${r.notice}`);
  }
}

let tmpDir: string;
// A second project root. Recordings are keyed by <project_root>/<name>, so it
// is what the cross-project cases address: same flow name, different project.
let otherDir: string;

function createMockRegistry(
  tools: Record<string, { result: unknown; outputHint?: string; throws?: boolean }> = {}
) {
  return {
    invokeTool: vi.fn(async (id: string) => {
      const entry = tools[id];
      if (!entry) throw new Error(`Tool "${id}" not found`);
      if (entry.throws) throw new Error(`Tool "${id}" failed`);
      return entry.result;
    }),
    getTool: vi.fn((id: string) => {
      const entry = tools[id];
      if (!entry) return undefined;
      return { outputHint: entry.outputHint };
    }),
  } as unknown as Registry;
}

async function readFlowFile(name: string, projectRoot: string = tmpDir): Promise<string> {
  return fs.readFile(path.join(projectRoot, ".argent", "flows", `${name}.yaml`), "utf8");
}

/**
 * Replace the active recording's file on disk. Host-mode recording re-reads the
 * file on every append and on finish (so a manual edit mid-recording survives),
 * which is the same door an author uses to hand-write a `requires:` block.
 */
async function overwriteFlowFile(name: string, flow: FlowFile): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
    serializeFlow(flow),
    "utf8"
  );
}

const PREREQ = "App on home screen";

// ── Setup / teardown ─────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-"));
  otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-test-other-"));
  __resetRecordingsForTesting();
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(otherDir, { recursive: true, force: true });
});

// ── flow-start-recording ─────────────────────────────────────────────

describe("flow-start-recording", () => {
  it("creates the .argent/flows dir and a .yaml file with header", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "test-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    expect(result.message).toContain("test-flow");

    const content = await readFlowFile("test-flow");
    const flow = parseFlow(content);
    expect(flow.executionPrerequisite).toBe(PREREQ);
    expect(flow.steps).toEqual([]);
  });

  it("opens a recording addressable by name + project_root", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "my-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "my-flow", project_root: tmpDir, message: "test" }
    );
    expect(result.message).toContain("my-flow");
  });

  it("overwrites an existing flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, message: "line1" }
    );

    // Start again with same name — should reset
    await flowStartRecordingTool.execute(
      {},
      { name: "overwrite", project_root: tmpDir, executionPrerequisite: "Different prereq" }
    );
    const content = await readFlowFile("overwrite");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
    expect(flow.executionPrerequisite).toBe("Different prereq");
  });

  it("rejects a relative project_root", async () => {
    await expect(
      flowStartRecordingTool.execute(
        {},
        { name: "relative", project_root: "./not-absolute", executionPrerequisite: PREREQ }
      )
    ).rejects.toThrow("project_root must be an absolute path");
  });
});

// ── flow-start-recording edge cases ──────────────────────────────────

describe("flow-start-recording edge cases", () => {
  it("starting a differently-named flow leaves the earlier recording live", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "first-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "second-flow", project_root: tmpDir, executionPrerequisite: "Different" }
    );

    // A second recording abandons nothing, so there is no switch to report.
    expect(result.message).toContain("second-flow");
    expect(result.message).not.toContain("first-flow");
    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();

    // Both recordings still take steps, each addressed by its own name.
    const secondEcho = await flowInsertEchoTool.execute(
      {},
      { name: "second-flow", project_root: tmpDir, message: "goes to second" }
    );
    expect(secondEcho.message).toContain("second-flow");
    const firstEcho = await flowInsertEchoTool.execute(
      {},
      { name: "first-flow", project_root: tmpDir, message: "goes to first" }
    );
    expect(firstEcho.message).toContain("first-flow");

    // …and each file ends up holding only its own steps.
    expect(parseFlow(await readFlowFile("first-flow")).steps).toEqual([
      { kind: "echo", message: "goes to first" },
    ]);
    expect(parseFlow(await readFlowFile("second-flow")).steps).toEqual([
      { kind: "echo", message: "goes to second" },
    ]);
  });

  it("keeps same-named recordings in different projects independent", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "shared-name", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "shared-name", project_root: otherDir, executionPrerequisite: PREREQ }
    );

    // Same name, other project — a different key, so nothing was restarted.
    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();

    await flowInsertEchoTool.execute(
      {},
      { name: "shared-name", project_root: tmpDir, message: "in first project" }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "shared-name", project_root: otherDir, message: "in second project" }
    );

    expect(parseFlow(await readFlowFile("shared-name")).steps).toEqual([
      { kind: "echo", message: "in first project" },
    ]);
    expect(parseFlow(await readFlowFile("shared-name", otherDir)).steps).toEqual([
      { kind: "echo", message: "in second project" },
    ]);
  });

  it("restarting the same flow reports the discarded steps and resets the file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "will be reset" }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "also reset" }
    );

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, executionPrerequisite: "Updated prereq" }
    );

    expect(result.restarted).toBe(true);
    expect(result.discardedSteps).toBe(2);
    expect(result.message).toContain("same-flow");

    // The earlier take is gone from the file too, prerequisite included.
    const flow = parseFlow(await readFlowFile("same-flow"));
    expect(flow.steps).toEqual([]);
    expect(flow.executionPrerequisite).toBe("Updated prereq");

    // The restarted recording is the live one, and it starts from empty.
    const echo = await flowInsertEchoTool.execute(
      {},
      { name: "same-flow", project_root: tmpDir, message: "new take" }
    );
    expect(echo.stepCount).toBe(1);
    expect(parseFlow(await onDisk("same-flow")).steps).toEqual([
      { kind: "echo", message: "new take" },
    ]);
  });

  it("does not report a restart when the flow was not already recording", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "fresh-start", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.restarted).toBeUndefined();
    expect(result.discardedSteps).toBeUndefined();
  });

  it("carries the on-disk requires block through the reset and says so", async () => {
    // The re-record repair path: a fenced flow sits on disk with NO live
    // session. `requires` has no tool that writes it back, so the reset must
    // not silently turn the flow into a run-anywhere one.
    const requires = { platform: ["ios" as const], runtimeKind: "tv" as const };
    await fs.mkdir(flowsDirFor(tmpDir), { recursive: true });
    await overwriteFlowFile("fenced", {
      executionPrerequisite: "",
      requires,
      steps: [{ kind: "echo", message: "old take" }],
    });

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "fenced", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const flow = parseFlow(result.flowFile);
    expect(flow.steps).toEqual([]);
    expect(flow.requires).toEqual(requires);
    expect(parseFlow(await readFlowFile("fenced")).requires).toEqual(requires);
    expect(result.message).toContain(
      "requires block (platform: [ios], runtimeKind: tv) - edit the YAML to change it"
    );
    expect(result.message).not.toContain("did not parse");
  });

  it("carries a coverage-violating block and counts the file when a live take is restarted", async () => {
    // Host mode WITH a live session: the carried block and the discarded count
    // are two reads of the same file, and both must skip requires validation.
    // The block below is one `validateRequires` refuses (the launch declares no
    // android id), which is exactly the file a re-record exists to repair - so
    // reading it strictly would report "did not parse" and drop the fence.
    // The session's in-memory copy is left deliberately behind the file, so a
    // count taken from the session would report 1 rather than 3.
    await flowStartRecordingTool.execute(
      {},
      { name: "fenced-live", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "fenced-live", project_root: tmpDir, message: "in memory" }
    );
    // Hand-written: serializeFlow would refuse to emit this file.
    const violating = [
      "requires: { platform: [ios, android] }",
      "steps:",
      "  - launch: { ios: com.a }",
      "  - echo: hand-edited two",
      "  - echo: hand-edited three",
      "",
    ].join("\n");
    expect(() => parseFlow(violating)).toThrow(/declares no app id for android/);
    await fs.writeFile(path.join(flowsDirFor(tmpDir), "fenced-live.yaml"), violating, "utf8");

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "fenced-live", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const requires = { platform: ["ios" as const, "android" as const] };
    expect(result.restarted).toBe(true);
    expect(result.discardedSteps).toBe(3);
    expect(result.message).toContain("the previous take (3 steps) was discarded");
    expect(result.message).toContain(
      "Kept the existing requires block (platform: [ios, android]) - edit the YAML to change it"
    );
    expect(result.message).not.toContain("did not parse");
    expect(parseFlow(result.flowFile).requires).toEqual(requires);
    expect(parseFlow(await readFlowFile("fenced-live")).requires).toEqual(requires);
  });

  it("carries a block no target can satisfy, so the re-record that repairs it can start", async () => {
    // The block parses, so it comes back from the disk read intact and lands on
    // the reset flow. Judging it here would throw at the START of the recording,
    // leaving a hand-edit as the only repair for the file the author came here
    // to replace.
    await flowStartRecordingTool.execute(
      {},
      { name: "unsatisfiable", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const impossible = "requires: { platform: [chromium], runtimeKind: tv }\nsteps: []\n";
    expect(() => parseFlow(impossible)).toThrow(/can never be satisfied/);
    await fs.writeFile(path.join(flowsDirFor(tmpDir), "unsatisfiable.yaml"), impossible, "utf8");

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "unsatisfiable", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const requires = { platform: ["chromium" as const], runtimeKind: "tv" as const };
    expect(result.restarted).toBe(true);
    expect(result.message).toContain(
      "Kept the existing requires block (platform: [chromium], runtimeKind: tv)"
    );
    expect(parseFlow(result.flowFile, { skipRequires: true }).requires).toEqual(requires);
    expect(parseFlow(await readFlowFile("unsatisfiable"), { skipRequires: true }).requires).toEqual(
      requires
    );
  });

  it("carries the take's requires block when the flow file was deleted between two starts", async () => {
    // The one loss path with nothing left to read: the file the fence lived in
    // is gone, so the take being restarted is its last witness - it read that
    // block off this same file at the start below. Dropping it here would
    // rewrite the flow unfenced without a word.
    const requires = { platform: ["ios" as const] };
    await fs.mkdir(flowsDirFor(tmpDir), { recursive: true });
    await overwriteFlowFile("vanished", {
      executionPrerequisite: "",
      requires,
      steps: [{ kind: "echo", message: "old take" }],
    });

    const first = await flowStartRecordingTool.execute(
      {},
      { name: "vanished", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    expect(first.message).toContain("Kept the existing requires block (platform: [ios])");
    await fs.rm(path.join(flowsDirFor(tmpDir), "vanished.yaml"));

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "vanished", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.restarted).toBe(true);
    expect(parseFlow(result.flowFile).requires).toEqual(requires);
    expect(parseFlow(await readFlowFile("vanished")).requires).toEqual(requires);
    expect(result.message).toContain(
      "The previous file was gone, so the requires block (platform: [ios]) was carried over " +
        "from the take being restarted - edit the YAML to change it."
    );
    expect(result.message).not.toContain("did not parse");
  });

  it("lets a hand edit that removed the block unfence the flow, over the take's copy", async () => {
    // A readable file is the authority: the edit is part of the take, so the
    // in-memory block the start below cached must not resurrect the fence.
    await fs.mkdir(flowsDirFor(tmpDir), { recursive: true });
    await overwriteFlowFile("unfenced-by-hand", {
      executionPrerequisite: "",
      requires: { platform: ["ios" as const] },
      steps: [],
    });
    await flowStartRecordingTool.execute(
      {},
      { name: "unfenced-by-hand", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    expect((await getRecordingSession(tmpDir, "unfenced-by-hand"))?.flow.requires).toEqual({
      platform: ["ios"],
    });
    await overwriteFlowFile("unfenced-by-hand", { executionPrerequisite: PREREQ, steps: [] });

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "unfenced-by-hand", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.message).not.toContain("requires");
    expect(parseFlow(result.flowFile).requires).toBeUndefined();
    expect(parseFlow(await readFlowFile("unfenced-by-hand")).requires).toBeUndefined();
  });

  it("reports the unparseable file's block as dropped rather than reviving the take's copy", async () => {
    // A file that will not parse may be mid-edit on its own `requires` line,
    // which is exactly what the in-memory copy cannot know - so this arm keeps
    // reporting the unknown instead of asserting the block the take holds.
    await fs.mkdir(flowsDirFor(tmpDir), { recursive: true });
    await overwriteFlowFile("broken-fenced", {
      executionPrerequisite: "",
      requires: { platform: ["ios" as const] },
      steps: [],
    });
    await flowStartRecordingTool.execute(
      {},
      { name: "broken-fenced", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    expect((await getRecordingSession(tmpDir, "broken-fenced"))?.flow.requires).toEqual({
      platform: ["ios"],
    });
    await fs.writeFile(
      path.join(flowsDirFor(tmpDir), "broken-fenced.yaml"),
      "requires:\n  platfrom: [ios]\nsteps: []\n",
      "utf8"
    );

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "broken-fenced", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.message).toContain(
      "The previous file did not parse, so any requires block it held was dropped"
    );
    expect(result.message).not.toContain("was carried over");
    expect(parseFlow(result.flowFile).requires).toBeUndefined();
    expect(parseFlow(await readFlowFile("broken-fenced")).requires).toBeUndefined();
  });

  it("reports a file it cannot read as unreadable rather than as one that did not parse", async () => {
    // EACCES, EISDIR and friends never reach `parseFlow`, so naming a parse
    // outcome here would send the agent hunting a syntax error that is not
    // there. The block is still not answered from the session: an unreadable
    // file may hold an edit the in-memory copy never saw.
    await fs.mkdir(flowsDirFor(tmpDir), { recursive: true });
    await overwriteFlowFile("unreadable", {
      executionPrerequisite: "",
      requires: { platform: ["ios" as const] },
      steps: [],
    });
    await flowStartRecordingTool.execute(
      {},
      { name: "unreadable", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    expect((await getRecordingSession(tmpDir, "unreadable"))?.flow.requires).toEqual({
      platform: ["ios"],
    });
    const target = path.join(flowsDirFor(tmpDir), "unreadable.yaml");
    const realReadFile = fs.readFile;
    const spy = vi.spyOn(fs, "readFile").mockImplementation((async (
      p: unknown,
      ...rest: unknown[]
    ) => {
      if (String(p) === target) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), {
          code: "EACCES",
        });
      }
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as unknown as typeof fs.readFile);

    const result = await flowStartRecordingTool
      .execute({}, { name: "unreadable", project_root: tmpDir, executionPrerequisite: PREREQ })
      .finally(() => spy.mockRestore());

    expect(result.message).toContain(
      "The previous file could not be read, so any requires block it held was dropped"
    );
    expect(result.message).not.toContain("did not parse");
    expect(result.message).not.toContain("was carried over");
    expect(parseFlow(result.flowFile).requires).toBeUndefined();
    expect(parseFlow(await readFlowFile("unreadable")).requires).toBeUndefined();
  });

  it.each([
    ["zero bytes", ""],
    ["whitespace only", "\n  \n"],
  ])(
    "carries the take's requires block when the flow file was truncated to %s",
    async (_label, content) => {
      // A crashed editor or a disk-full write leaves a file that parses clean as
      // a flow declaring nothing - the same read as a deliberate unfence, but
      // not the same act. It witnesses nothing, so like a deleted file it is
      // answered from the take, which read its block off this same file.
      const requires = { platform: ["ios" as const] };
      await fs.mkdir(flowsDirFor(tmpDir), { recursive: true });
      await overwriteFlowFile("truncated", {
        executionPrerequisite: "",
        requires,
        steps: [{ kind: "echo", message: "old take" }],
      });
      const first = await flowStartRecordingTool.execute(
        {},
        { name: "truncated", project_root: tmpDir, executionPrerequisite: PREREQ }
      );
      expect(first.message).toContain("Kept the existing requires block (platform: [ios])");
      await fs.writeFile(path.join(flowsDirFor(tmpDir), "truncated.yaml"), content, "utf8");

      const result = await flowStartRecordingTool.execute(
        {},
        { name: "truncated", project_root: tmpDir, executionPrerequisite: PREREQ }
      );

      expect(result.restarted).toBe(true);
      expect(parseFlow(result.flowFile).requires).toEqual(requires);
      expect(parseFlow(await readFlowFile("truncated")).requires).toEqual(requires);
      expect(result.message).toContain(
        "The previous file was empty, so the requires block (platform: [ios]) was carried over " +
          "from the take being restarted - edit the YAML to change it."
      );
      expect(result.message).not.toContain("did not parse");
    }
  );

  it("says nothing about requires when an empty file has no take to answer for it", async () => {
    // Same silence as a missing file: nothing on disk, nothing in memory, so
    // there is no block to carry and none known to have been dropped.
    await fs.mkdir(flowsDirFor(tmpDir), { recursive: true });
    await fs.writeFile(path.join(flowsDirFor(tmpDir), "touched.yaml"), "", "utf8");

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "touched", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.message).not.toContain("requires");
    expect(parseFlow(result.flowFile).requires).toBeUndefined();
  });

  it("mentions no requires block when the replaced file had none", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "unfenced", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "unfenced", project_root: tmpDir, message: "old take" }
    );

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "unfenced", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.message).not.toContain("requires");
    expect(parseFlow(result.flowFile).requires).toBeUndefined();
  });

  it("says nothing about requires when there is no file yet", async () => {
    const result = await flowStartRecordingTool.execute(
      {},
      { name: "first-take", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    // A missing file declares no block and drops nothing, so it is an answer,
    // not a gap — the unknown-block clause must not fire on every fresh start.
    expect(result.message).not.toContain("requires");
    expect(parseFlow(result.flowFile).requires).toBeUndefined();
  });

  // Each of these declares a `requires:` block and fails to parse for a reason
  // `skipRequires` does NOT bypass — a step body, a key inside the block, a
  // top-level key, a platform spelling the block rejects, plain broken YAML.
  // The reset truncates all of them, so the block's fate is unknown and
  // reporting "no block" would discard a fence in silence.
  const unparseableFenced: Array<[label: string, yaml: string]> = [
    [
      "a step that does not parse",
      'requires:\n  platform: [ios]\nsteps:\n  - bogusstep: { message: "nope" }\n',
    ],
    ["a typo inside the block", "requires:\n  runtimeKind: tv\n  platfrom: [ios]\nsteps: []\n"],
    ["an unknown top-level key", "requires:\n  platform: [ios]\nnotes: hello\nsteps: []\n"],
    ["a platform the block rejects", "requires:\n  platform: [ios-remote]\nsteps: []\n"],
    ["unterminated YAML", "requires:\n  platform: [ios]\nsteps: [unclosed\n"],
  ];

  it.each(unparseableFenced)(
    "reports the dropped requires block when the file has %s",
    async (_label, yaml) => {
      await fs.mkdir(flowsDirFor(tmpDir), { recursive: true });
      await fs.writeFile(path.join(flowsDirFor(tmpDir), "broken.yaml"), yaml, "utf8");

      const result = await flowStartRecordingTool.execute(
        {},
        { name: "broken", project_root: tmpDir, executionPrerequisite: PREREQ }
      );

      expect(parseFlow(result.flowFile).requires).toBeUndefined();
      expect(result.message).toContain(
        "The previous file did not parse, so any requires block it held was dropped"
      );
    }
  );

  it("reports the dropped requires block alongside the discarded take", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "drop", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await fs.writeFile(
      path.join(flowsDirFor(tmpDir), "drop.yaml"),
      "requires:\n  platform: [ios]\nnotes: hello\nsteps: []\n",
      "utf8"
    );

    const result = await flowStartRecordingTool.execute(
      {},
      { name: "drop", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    expect(result.restarted).toBe(true);
    expect(result.message).toContain("reset to an empty flow.");
    expect(result.message).toContain(
      "The previous file did not parse, so any requires block it held was dropped"
    );
  });
});

// ── flow-add-echo ────────────────────────────────────────────────────

describe("flow-add-echo", () => {
  it("appends an echo entry to the flow file", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "echo-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "echo-test", project_root: tmpDir, message: "Hello world" }
    );

    expect(result.message).toContain("echo-test");
    // The whole growing YAML is deliberately no longer echoed per step; the
    // file on disk is the assertion surface, and `flowFile` must be gone.
    expect(result).not.toHaveProperty("flowFile");
    // …and unlike flow-add-step, no `recorded` either. The asymmetry is
    // deliberate: an echo step is entirely the `message` the caller just
    // passed, so a rendered line would only quote their own input back, while
    // a recorded step can be REWRITTEN on the way in (a coordinate tap into a
    // selector, a restart-app into a launch) and needs a line saying what
    // actually landed. Asserted so the pair can't silently drift together.
    expect(result).not.toHaveProperty("recorded");
    // With `flowFile` gone, `savedTo` is the only field naming the destination,
    // so it has to be the real path — returning a bogus one used to pass the
    // whole suite. Pinned here and on flow-add-step, the two callers of
    // appendStepToFlow's host branch.
    expect(result.savedTo).toBe(path.join(flowsDirFor(tmpDir), "echo-test.yaml"));
    const flow = parseFlow(await onDisk("echo-test"));
    expect(flow.steps).toEqual([{ kind: "echo", message: "Hello world" }]);
  });

  it("appends multiple echo entries", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const first = await flowInsertEchoTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, message: "First" }
    );
    const second = await flowInsertEchoTool.execute(
      {},
      { name: "multi-echo", project_root: tmpDir, message: "Second" }
    );

    // stepCount reflects the running total, not a constant — it is the only
    // per-step size signal now that the growing YAML is no longer returned.
    expect(first.stepCount).toBe(1);
    expect(second.stepCount).toBe(2);

    const flow = parseFlow(await onDisk("multi-echo"));
    expect(flow.steps).toEqual([
      { kind: "echo", message: "First" },
      { kind: "echo", message: "Second" },
    ]);
  });

  it("throws when that flow has no recording in progress", async () => {
    await expect(
      flowInsertEchoTool.execute(
        {},
        { name: "not-recording", project_root: tmpDir, message: "oops" }
      )
    ).rejects.toThrow("No active recording");
  });

  it("throws when the recording is open under a different project root", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "wrong-root", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    // Right name, wrong project — a different key, so no recording is found.
    const err = await flowInsertEchoTool
      .execute({}, { name: "wrong-root", project_root: otherDir, message: "oops" })
      .catch((e: unknown) => e as Error);

    expect(err.message).toContain("No active recording");
    // The error names the key that was asked for, and counts — without naming —
    // the recordings live under other roots, so a wrong project_root is
    // recognizable without disclosing another project's flows.
    expect(err.message).toContain(`No active recording for flow "wrong-root" in ${otherDir}`);
    expect(err.message).toContain("Active recordings: none in this project (plus 1 in other");
    expect(err.message).not.toContain(tmpDir);
  });
});

// ── flow-add-step ────────────────────────────────────────────────────

describe("flow-add-step", () => {
  it("executes the tool and records on success", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "step-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute(
      {},
      {
        name: "step-test",
        project_root: tmpDir,
        command: "tap",
        args: '{"x":0.5,"y":0.3}',
      }
    );

    expect(result.toolResult).toEqual({ tapped: true });
    // The growing YAML is no longer returned per step; `flowFile` must be gone
    // from the add-step result too (the breaking change this PR pins).
    expect(result).not.toHaveProperty("flowFile");
    const flow = parseFlow(await onDisk("step-test"));
    expect(flow.steps).toEqual([{ kind: "tool", name: "tap", args: { x: 0.5, y: 0.3 } }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("tap", {
      x: 0.5,
      y: 0.3,
    });
  });

  it("returns the appended step as the `recorded` line, carrying delayMs", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "recorded-line", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute(
      {},
      {
        name: "recorded-line",
        project_root: tmpDir,
        command: "tap",
        args: '{"x":0.5,"y":0.3}',
        delayMs: 500,
      }
    );

    // `recorded` is the author's only per-step view of the file now that the
    // whole YAML is no longer echoed, and it must spell the step exactly the
    // way flow-finish-recording's summary does — including the pre-step sleep.
    expect(result.stepCount).toBe(1);
    expect(result.recorded).toBe('1. tool: tap {"x":0.5,"y":0.3} (after 500ms)');
    expect(result.recorded).toBe(
      summarizeStep(parseFlow(await onDisk("recorded-line")).steps[0], 1)
    );
    // In host mode `savedTo` is the path the YAML actually landed at, and with
    // `flowFile` gone it is the only field naming it. See the add-echo case.
    expect(result.savedTo).toBe(path.join(flowsDirFor(tmpDir), "recorded-line.yaml"));
  });

  it("reports stepCount as a running total, numbering each recorded line with it", async () => {
    // Only flow-add-echo's running total was pinned; add-step's was asserted
    // only at the value 1, so hardcoding `stepCount: 1` in its return passed
    // the whole suite. stepCount is the recorder's only per-step size signal
    // now that the growing YAML is gone, and it doubles as the line number
    // `recorded` is rendered with — so drift here misnumbers both surfaces.
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "running-total", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const counts: number[] = [];
    for (const y of [0.1, 0.2, 0.3]) {
      const result = await tool.execute(
        {},
        {
          name: "running-total",
          project_root: tmpDir,
          command: "tap",
          args: JSON.stringify({ x: 0.5, y }),
        }
      );
      counts.push(result.stepCount);
      // The number `recorded` opens with IS the reported count, so the author
      // cannot be shown "3." while being told the flow holds one step.
      expect(result.recorded?.startsWith(`${result.stepCount}. `)).toBe(true);
    }

    expect(counts).toEqual([1, 2, 3]);
    // …and the total tracks the file, not just itself.
    expect(parseFlow(await onDisk("running-total")).steps).toHaveLength(3);
  });

  it("records a double-tap's clickCount as `times`, surfaced in the recorded line", async () => {
    // The clickCount→times rewrite (so a recorded double-tap replays as one,
    // not a single tap) only fires on a `gesture-tap` command, so the raw-tool
    // tests above never reach it. Selector capture can't resolve a device under
    // the mock, so the coordinates are kept — all this case needs to drive the
    // rewrite and confirm the ×N reaches the recorded line.
    const registry = createMockRegistry({ "gesture-tap": { result: { tapped: true } } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "double-tap", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await tool.execute(
      {},
      {
        name: "double-tap",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({
          udid: "00000000-0000-0000-0000-0000000000ab",
          x: 0.5,
          y: 0.3,
          clickCount: 2,
        }),
      }
    );

    const step = parseFlow(await onDisk("double-tap")).steps[0];
    expect(step).toEqual({ kind: "tap", x: 0.5, y: 0.3, times: 2 });
    expect(result.recorded).toBe("1. tap: (0.5, 0.3) ×2");
    expect(result.recorded).toBe(summarizeStep(step, 1));
  });

  it("finish-recording's summary carries the same delay/times spellings as `recorded`", async () => {
    // The per-step `recorded` lines are unit-covered above; this pins the OTHER
    // summarizeStep consumer — finish-recording's `summary` array — so the two
    // surfaces can't drift. It must render the pre-step delay and the tap count
    // exactly as the recorder echoed them per step.
    const registry = createMockRegistry({
      "screenshot": { result: { ok: true } },
      "gesture-tap": { result: { tapped: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "summary-labels", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const delayed = await tool.execute(
      {},
      {
        name: "summary-labels",
        project_root: tmpDir,
        command: "screenshot",
        args: "{}",
        delayMs: 250,
      }
    );
    const doubled = await tool.execute(
      {},
      {
        name: "summary-labels",
        project_root: tmpDir,
        command: "gesture-tap",
        args: JSON.stringify({
          udid: "00000000-0000-0000-0000-0000000000ab",
          x: 0.5,
          y: 0.3,
          clickCount: 2,
        }),
      }
    );

    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "summary-labels", project_root: tmpDir }
    );

    expect(finished.summary).toEqual([
      "1. tool: screenshot {} (after 250ms)",
      "2. tap: (0.5, 0.3) ×2",
    ]);
    // The finished summary and each step's `recorded` line are the same
    // spelling. This whole-array compare works only because neither step is an
    // `await-ui-element`, which adds a `warning:` line with no counterpart.
    expect(finished.summary).toEqual([delayed.recorded, doubled.recorded]);
  });

  it("propagates the request's telemetry attribution to the recorded sub-tool", async () => {
    const registry = createMockRegistry({ tap: { result: { ok: true } } });
    const tool = createFlowAddStepTool(registry);
    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await flowStartRecordingTool.execute(
      {},
      { name: "tele-step", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await tool.execute(
      {},
      { name: "tele-step", project_root: tmpDir, command: "tap", args: '{"x":0.5}' },
      ctx
    );

    expect(recordChildInvocation).toHaveBeenCalledOnce();
    const childId = recordChildInvocation.mock.calls[0]![0];
    // The sub-tool's own args reach the recorder so it can derive the platform.
    expect(recordChildInvocation).toHaveBeenCalledWith(childId, { x: 0.5 });
    expect(registry.invokeTool).toHaveBeenCalledWith(
      "tap",
      { x: 0.5 },
      expect.objectContaining({ toolInvocationId: childId, recordChildInvocation })
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not record when tool fails", async () => {
    const registry = createMockRegistry({
      tap: { result: null, throws: true },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "fail-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "fail-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
      )
    ).rejects.toThrow('Tool "tap" failed');

    const content = await readFlowFile("fail-test");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });

  it("handles omitted args", async () => {
    const registry = createMockRegistry({
      screenshot: { result: { url: "http://..." } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "no-args", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await tool.execute({}, { name: "no-args", project_root: tmpDir, command: "screenshot" });

    const content = await readFlowFile("no-args");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([{ kind: "tool", name: "screenshot", args: {} }]);
    expect(registry.invokeTool).toHaveBeenCalledWith("screenshot", {});
  });

  it("throws when that flow has no recording in progress", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await expect(
      tool.execute(
        {},
        { name: "not-recording", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
      )
    ).rejects.toThrow("No active recording");
    // The step must not run either — the recording is resolved first.
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("records a restart-app as a portable launch step (device id dropped)", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true, bundleId: "com.acme.app" } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-rewrite", project_root: tmpDir });
    const result = await tool.execute(
      {},
      {
        name: "launch-rewrite",
        project_root: tmpDir,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app"}',
      }
    );

    // Ran live with the full args…
    expect(registry.invokeTool).toHaveBeenCalledWith("restart-app", {
      udid: "ABC",
      bundleId: "com.acme.app",
    });
    // …but recorded the launch directive, making this an e2e flow.
    const steps = parseFlow(await onDisk("launch-rewrite")).steps;
    expect(steps).toEqual([{ kind: "launch", app: "com.acme.app" }]);
    // The rewrite is invisible in the raw result (which echoes restart-app's
    // own output), so `recorded` is what tells the author a launch was stored
    // rather than the tool call they made.
    expect(result.recorded).toBe("1. launch: com.acme.app");
    expect(result.recorded).toBe(summarizeStep(steps[0], 1));
  });

  it("keeps a restart-app with extra args (e.g. activity) as a raw tool step", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "launch-activity", project_root: tmpDir });
    await tool.execute(
      {},
      {
        name: "launch-activity",
        project_root: tmpDir,
        command: "restart-app",
        args: '{"udid":"ABC","bundleId":"com.acme.app","activity":".Main"}',
      }
    );

    expect(parseFlow(await onDisk("launch-activity")).steps).toEqual([
      {
        kind: "tool",
        name: "restart-app",
        args: { bundleId: "com.acme.app", activity: ".Main" },
      },
    ]);
  });

  it("rejects a leading launch recorded into a prerequisite-bearing recording", async () => {
    const registry = createMockRegistry({
      "restart-app": { result: { restarted: true } },
    });
    const tool = createFlowAddStepTool(registry);

    // A prerequisite documents a fragment; a leading launch would make it e2e —
    // contradictory, so the append must fail and record nothing.
    await flowStartRecordingTool.execute(
      {},
      { name: "contradiction", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        {
          name: "contradiction",
          project_root: tmpDir,
          command: "restart-app",
          args: '{"bundleId":"com.acme.app"}',
        }
      )
    ).rejects.toThrow(/must not declare executionPrerequisite/i);

    const flow = parseFlow(await readFlowFile("contradiction"));
    expect(flow.steps).toEqual([]);
  });

  async function writeSiblingFlow(name: string, yaml: string): Promise<void> {
    await fs.writeFile(path.join(tmpDir, ".argent", "flows", `${name}.yaml`), yaml, "utf8");
  }

  it("records a flow-execute of a sibling fragment as a run: directive", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-test", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const result = await tool.execute(
      {},
      {
        name: "compose-test",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({
          name: "login",
          project_root: tmpDir,
          device: "ABC",
          prerequisiteAcknowledged: true,
        }),
      }
    );

    // Ran the fragment live to set up state…
    expect(result.toolResult).toEqual({ ok: true, steps: [] });
    // …but recorded the portable composition directive, not the raw tool call.
    const steps = parseFlow(await onDisk("compose-test")).steps;
    expect(steps).toEqual([{ kind: "run", flow: "login.yaml" }]);
    // Same reason as the launch rewrite: `recorded` is the only place the
    // author sees that a `run:` went in instead of a raw flow-execute step.
    expect(result.recorded).toBe("1. run: login.yaml");
    expect(result.recorded).toBe(summarizeStep(steps[0], 1));
  });

  it("records a run: directive when the target is an e2e flow", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-e2e", project_root: tmpDir });
    await writeSiblingFlow("other-e2e", "steps:\n  - launch: com.acme.app\n  - echo: hi\n");

    await tool.execute(
      {},
      {
        name: "compose-e2e",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "other-e2e", project_root: tmpDir, device: "ABC" }),
      }
    );

    // e2e flows now compose via run: just like fragments — their launch runs inline.
    expect(parseFlow(await onDisk("compose-e2e")).steps).toEqual([
      { kind: "run", flow: "other-e2e.yaml" },
    ]);
  });

  it("keeps the raw flow-execute step when the target is not a sibling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-missing", project_root: tmpDir });

    const result = await tool.execute(
      {},
      {
        name: "compose-missing",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: tmpDir }),
      }
    );

    expect(result.message).toMatch(/could not resolve/i);
    expect(parseFlow(await onDisk("compose-missing")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "elsewhere", project_root: tmpDir } },
    ]);
  });

  it("strips the device id from a raw flow-execute step (issue #607)", async () => {
    // Deliberately a target that is NOT a resolvable sibling: a resolvable one
    // records as `run:`, which carries no args at all and so could never show
    // this. The raw fallback is the form that kept the record-time device id and
    // pinned every replay to it.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-pinned", project_root: tmpDir });

    await tool.execute(
      {},
      {
        name: "compose-pinned",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "elsewhere", project_root: tmpDir, device: "ABC" }),
      }
    );

    expect(parseFlow(await onDisk("compose-pinned")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "elsewhere", project_root: tmpDir } },
    ]);
  });

  it("keeps the raw flow-execute step when another project_root resolves the name", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-twin", project_root: tmpDir });
    // Two projects, each holding a different flow named "twin". The nested call
    // named the OTHER project's root, so that is the copy that ran live — while
    // a `run: twin` step resolves beside the recording at replay. Recording one
    // would swap the flow under the same name, both runs green and nothing said.
    await writeSiblingFlow("twin", "steps:\n  - echo: mine\n");
    const otherRoot = path.join(tmpDir, "other-project");
    const otherTwin = path.join(otherRoot, ".argent", "flows", "twin.yaml");
    await fs.mkdir(path.dirname(otherTwin), { recursive: true });
    await fs.writeFile(otherTwin, "steps:\n  - echo: theirs\n", "utf8");

    const args = { name: "twin", project_root: otherRoot };
    const result = await tool.execute(
      {},
      {
        name: "compose-twin",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(args),
      }
    );

    // The live invoke ran the other project's copy…
    expect(registry.invokeTool).toHaveBeenCalledWith("flow-execute", args);
    // …so the recorded step must be the raw call that reproduces it — naming
    // both files, since either one alone reads as the flow the author meant.
    // Both anchors are canonicalized before the comparison (the recording's
    // real file on one side, the executed path on the other), so the message
    // quotes the realpath'd spellings — on macOS tmpdir lives behind the
    // /var → /private/var symlink, which these paths carry as written.
    expect(result.message).toContain(await fs.realpath(otherTwin));
    expect(result.message).toContain(
      await fs.realpath(path.join(tmpDir, ".argent", "flows", "twin.yaml"))
    );
    expect(result.message).toMatch(/would replay a different flow/);
    expect(parseFlow(await onDisk("compose-twin")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args },
    ]);
  });

  // The two casing cases below decide off the flows dir LISTING, which returns
  // stored bytes on every platform, so they hold identically on case-sensitive
  // (Linux CI) and case-insensitive (APFS, NTFS) filesystems — where before the
  // gate the recorder read the case-folded file and baked its phantom spelling
  // into the committed YAML. The mock registry stands in for a flow-execute
  // that accepted the name; the real one refuses this spelling itself (see
  // "saved-flow name spelling"), so these pin the recorder's own guarantee
  // about the YAML it writes rather than borrowing that tool's.
  it("keeps the raw flow-execute step for a name the flows dir would case-fold", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-name-casing", project_root: tmpDir });
    await writeSiblingFlow("frag", "steps:\n  - echo: hi\n");

    const args = { name: "Frag", project_root: tmpDir };
    const result = await tool.execute(
      {},
      {
        name: "compose-name-casing",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(args),
      }
    );

    // `run: Frag` names a flow no case-sensitive checkout can find, so the raw
    // step is kept and the warning hands back the recordable spelling.
    expect(result.message).toContain('case-insensitively to "frag.yaml"');
    expect(result.message).toContain('re-run it as name "frag" to record it');
    expect(parseFlow(await onDisk("compose-name-casing")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args },
    ]);
  });

  it("suggests a rename when the on-disk sibling's own extension case is unnameable", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-name-rename", project_root: tmpDir });
    // frag.YAML is reachable by no name at all — this route always builds
    // "<name>.yaml" — so the only honest recovery is the rename.
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "frag.YAML"),
      "steps:\n  - echo: hi\n",
      "utf8"
    );

    const args = { name: "frag", project_root: tmpDir };
    const result = await tool.execute(
      {},
      {
        name: "compose-name-rename",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(args),
      }
    );

    expect(result.message).toContain('case-insensitively to "frag.YAML"');
    expect(result.message).toContain(
      'rename "frag.YAML" to "frag.yaml" to record it — flow files must be lowercase .yaml'
    );
    expect(result.message).not.toContain("re-run it as name");
    expect(parseFlow(await onDisk("compose-name-rename")).steps).toEqual([
      { kind: "tool", name: "flow-execute", args },
    ]);
  });

  it("composes a sibling saved under a mixed-case name under that exact name", async () => {
    // Byte-for-byte is the contract — not lowercasing: a sibling really saved
    // as MixedCase.yaml composes as `run: MixedCase`.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-name-mixed", project_root: tmpDir });
    await writeSiblingFlow("MixedCase", "steps:\n  - echo: hi\n");

    await tool.execute(
      {},
      {
        name: "compose-name-mixed",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ name: "MixedCase", project_root: tmpDir }),
      }
    );

    expect(parseFlow(await onDisk("compose-name-mixed")).steps).toEqual([
      { kind: "run", flow: "MixedCase.yaml" },
    ]);
  });

  // A root the recorder cannot anchor is not a root it can check the name
  // against, so it declines to compose rather than compose on an unverified
  // identity. flow-execute's schema requires project_root and its resolver
  // demands an absolute one, so only a direct execute() caller reaches this —
  // and the relative case mocks the server's cwd to make the root name the
  // sibling, the one shape a cwd-anchored comparison would let through.
  it.each<[string, string | undefined, string]>([
    ["is missing", undefined, "(got none)"],
    ["is relative", ".", '(got ".")'],
  ])("keeps the raw flow-execute step when project_root %s", async (_shape, root, detail) => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-unanchored", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    const args = root === undefined ? { name: "login" } : { name: "login", project_root: root };
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    try {
      if (root !== undefined) {
        expect(path.resolve(flowsDirFor(root), "login.yaml")).toBe(
          path.join(tmpDir, ".argent", "flows", "login.yaml")
        );
      }
      const result = await tool.execute(
        {},
        {
          name: "compose-unanchored",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify(args),
        }
      );

      expect(result.message).toContain(`project_root must be an absolute path ${detail}`);
      expect(parseFlow(await onDisk("compose-unanchored")).steps).toEqual([
        { kind: "tool", name: "flow-execute", args },
      ]);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  // The runner resolves a recorded `run:` against the CANONICAL containing
  // file's directory (scopeFlowDir in flow-run.ts), so when the recording is
  // itself a symlink the recorder must validate the sibling beside the real
  // file — AND confirm it is the same file the live sub-invoke executed from
  // the flows-dir spelling. The three tests below pin the accept, reject, and
  // divergence directions of those anchors. The base
  // is realpath'd so the only spelling/real divergence is the test's own
  // symlink: macOS's tmpdir lives behind the /var → /private/var symlink,
  // which would otherwise make every path here diverge from its canonical
  // form for reasons unrelated to what's being tested.
  async function symlinkedRecordingSetup(): Promise<{ base: string; vault: string }> {
    const base = await fs.realpath(tmpDir);
    const vault = path.join(base, "vault");
    const flowsDir = path.join(base, ".argent", "flows");
    await fs.mkdir(vault, { recursive: true });
    await fs.mkdir(flowsDir, { recursive: true });
    // The real file must exist before the recording starts: flow-start-recording
    // writes THROUGH .argent/flows/rec.yaml, which is a symlink into vault/.
    await fs.writeFile(path.join(vault, "rec.yaml"), "steps: []\n", "utf8");
    await fs.symlink(path.join(vault, "rec.yaml"), path.join(flowsDir, "rec.yaml"));
    return { base, vault };
  }

  it("validates the run: sibling beside a symlinked recording's real file", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    const { base, vault } = await symlinkedRecordingSetup();
    // The fragment's real file lives in vault/, beside the recording's real
    // file, with the flows dir carrying a symlink to it — the same vault
    // layout the recording itself models. The live sub-invoke resolves the
    // flows-dir spelling (getFlowPath under project_root) and the runner's
    // canonical anchor (scopeFlowDir in flow-run.ts) resolves the vault file;
    // both canonicalize to this one file, so the composition is sound. Vault
    // only would leave the flows-dir path — the one the live sub-invoke reads
    // — nonexistent, a layout the shipped path cannot produce.
    await fs.writeFile(path.join(vault, "frag.yaml"), "steps:\n  - echo: hi\n", "utf8");
    await fs.symlink(
      path.join(vault, "frag.yaml"),
      path.join(base, ".argent", "flows", "frag.yaml")
    );
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: base });

    const result = await tool.execute(
      {},
      {
        name: "rec",
        project_root: base,
        command: "flow-execute",
        args: JSON.stringify({ name: "frag", project_root: base }),
      }
    );

    // Anchored beside the symlink's spelling this would miss the fragment and
    // demote a perfectly replayable composition to a raw tool step.
    expect(result.message).not.toMatch(/could not resolve/i);
    expect(parseFlow(await onDisk("rec", base)).steps).toEqual([
      { kind: "run", flow: "frag.yaml" },
    ]);
  });

  it("keeps the raw step when the sibling exists only beside the symlink's spelling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    const { base } = await symlinkedRecordingSetup();
    // A decoy beside the symlink's SPELLING only — replay resolves `run:`
    // beside the real file, where nothing exists, so recording this as `run:`
    // would report success for a step that cannot replay.
    await fs.writeFile(
      path.join(base, ".argent", "flows", "frag.yaml"),
      "steps:\n  - echo: decoy\n",
      "utf8"
    );
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: base });

    const result = await tool.execute(
      {},
      {
        name: "rec",
        project_root: base,
        command: "flow-execute",
        args: JSON.stringify({ name: "frag", project_root: base }),
      }
    );

    expect(result.message).toMatch(/could not resolve/i);
    expect(parseFlow(await onDisk("rec", base)).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "frag", project_root: base } },
    ]);
  });

  it("keeps the raw step when the flows-dir file and the real-file sibling diverge", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    const { base, vault } = await symlinkedRecordingSetup();
    // frag.yaml exists at BOTH spellings as two DIFFERENT real files. The live
    // sub-invoke runs the flows-dir one (getFlowPath under project_root); a
    // recorded `run:` would replay the vault one (scopeFlowDir in flow-run.ts
    // anchors at the canonical containing dir). Recording `run:` here would
    // report success for a step naming a flow that never ran — the raw step,
    // which replays via name + project_root, is the only honest record.
    await fs.writeFile(
      path.join(base, ".argent", "flows", "frag.yaml"),
      "steps:\n  - echo: decoy\n",
      "utf8"
    );
    await fs.writeFile(path.join(vault, "frag.yaml"), "steps:\n  - echo: real\n", "utf8");
    await flowStartRecordingTool.execute({}, { name: "rec", project_root: base });

    const result = await tool.execute(
      {},
      {
        name: "rec",
        project_root: base,
        command: "flow-execute",
        args: JSON.stringify({ name: "frag", project_root: base }),
      }
    );

    expect(result.message).toMatch(/not the file the live flow-execute ran/i);
    expect(parseFlow(await onDisk("rec", base)).steps).toEqual([
      { kind: "tool", name: "flow-execute", args: { name: "frag", project_root: base } },
    ]);
  });

  it("records a flow-execute of a sibling flow_path as a run: directive", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-path", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    const sibling = path.join(tmpDir, ".argent", "flows", "login.yaml");

    await tool.execute(
      {},
      {
        name: "compose-path",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify({ flow_path: sibling, project_root: tmpDir }),
      }
    );

    expect(parseFlow(await onDisk("compose-path")).steps).toEqual([
      { kind: "run", flow: "login.yaml" },
    ]);
    // The live sub-invoke gets no file-input boundary, so it must run the
    // sibling by name…
    const nested = (registry.invokeTool as any).mock.calls[0][1];
    expect(nested).toEqual({ name: "login", project_root: tmpDir });
    // …which a real tool-server resolves to that same file.
    expect(await resolveFlowSource(nested)).toEqual({
      filePath: sibling,
      flowName: "login",
      viaUpload: false,
    });
  });

  it("names the flow_path the author wrote when the rewritten call is rejected", async () => {
    const registry = new Registry();
    registry.registerTool(createRunFlowTool(registry) as never);
    const tool = createFlowAddStepTool(registry);
    registry.registerTool(tool as never);

    await flowStartRecordingTool.execute({}, { name: "reframe", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    const sibling = path.join(tmpDir, ".argent", "flows", "login.yaml");

    const authored = await tool
      .execute(
        {},
        {
          name: "reframe",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({ flow_path: sibling, project_root: tmpDir, platform: "iOS" }),
        }
      )
      .then(() => undefined)
      .catch((err: unknown) => (err as Error).message);

    expect(authored).toContain("`platform`");
    expect(authored).toContain("You sent: `flow_path`, `project_root`, `platform`.");
    expect(authored).not.toContain("`name`");

    const byName = await tool
      .execute(
        {},
        {
          name: "reframe",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({ name: "login", project_root: tmpDir, platform: "iOS" }),
        }
      )
      .then(() => undefined)
      .catch((err: unknown) => (err as Error).message);

    expect(byName).toContain("You sent: `name`, `project_root`, `platform`.");

    expect(parseFlow(await onDisk("reframe")).steps).toEqual([]);
  });

  it("rejects a mis-cased sibling flow_path, naming the on-disk spelling", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-casing", project_root: tmpDir });
    await writeSiblingFlow("sibling", "steps:\n  - echo: hi\n");

    // Every lexical check accepts "Sibling.yaml", and a case-insensitive
    // filesystem would open sibling.yaml for it — so before the readdir gate
    // the recorder baked `run: Sibling` into committed YAML, a name no
    // case-sensitive checkout can resolve. The gate compares against the
    // directory LISTING, which returns stored bytes on every platform, so this
    // rejects deterministically on both filesystem flavors.
    const err = await tool
      .execute(
        {},
        {
          name: "compose-casing",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "Sibling.yaml"),
            project_root: tmpDir,
          }),
        }
      )
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    // The refusal must name the phantom spelling, the real directory entry,
    // and hand back the recordable on-disk basename.
    expect(err?.message).toContain("Cannot record a flow-execute of flow_path");
    expect(err?.message).toContain('case-insensitively to "sibling.yaml"');
    expect(err?.message).toContain('pass flow_path with the on-disk basename "sibling.yaml"');
    // Rejected before the live sub-invoke and the append: nothing ran, nothing recorded.
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-casing")).steps).toEqual([]);
  });

  it("suggests a rename when the on-disk sibling's own extension case is unrecordable", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-rename", project_root: tmpDir });
    // The sibling's REAL name trips the lowercase-extension arm, so the
    // message must ask for a rename, not point at a flow_path this same
    // ladder refuses.
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "frag.YAML"),
      "steps:\n  - echo: hi\n",
      "utf8"
    );

    const err = await tool
      .execute(
        {},
        {
          name: "compose-rename",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "frag.yaml"),
            project_root: tmpDir,
          }),
        }
      )
      .then(
        () => null,
        (e: unknown) => e as Error
      );

    expect(err?.message).toContain('case-insensitively to "frag.YAML"');
    expect(err?.message).toContain(
      'rename "frag.YAML" to "frag.yaml" to record it — flow files must be lowercase .yaml'
    );
    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-rename")).steps).toEqual([]);
  });

  it("rejects a flow_path outside the recording's flow directory without running it", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-outside", project_root: tmpDir });
    const outside = path.join(tmpDir, "elsewhere.yaml");
    await fs.writeFile(outside, "steps:\n  - echo: hi\n", "utf8");

    await expect(
      tool.execute(
        {},
        {
          name: "compose-outside",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({ flow_path: outside, project_root: tmpDir }),
        }
      )
    ).rejects.toThrow(/not in the recording's flow directory/i);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-outside")).steps).toEqual([]);
  });

  it('rejects a sibling flow_path containing a ".." segment without running it', async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-dotdot", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    // Assembled by hand — path.join would collapse the "..". Every resolve-based
    // check downstream accepts this string: it folds back to the sibling
    // login.yaml lexically, but a symlinked "sub" would make the kernel open a
    // different file than the rewritten name runs.
    const dotdot = [tmpDir, ".argent", "flows", "sub", "..", "login.yaml"].join(path.sep);

    await expect(
      tool.execute(
        {},
        {
          name: "compose-dotdot",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({ flow_path: dotdot, project_root: tmpDir }),
        }
      )
    ).rejects.toThrow(/must not contain "\.\." segments/);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-dotdot")).steps).toEqual([]);
  });

  // The flows dir already supplies the CLI's "dir/" shape, so these vary the
  // basename: path.extname reads each as an extensionless dotfile, and the
  // extension arm would claim ".yaml" is missing from a path that ends in it.
  it.each([[".yaml"], [".YAML"], [".Yaml"]])(
    "names the missing stem, not the extension, for a sibling named %s",
    async (basename) => {
      const registry = createMockRegistry({
        "flow-execute": { result: { ok: true, steps: [] } },
      });
      const tool = createFlowAddStepTool(registry);

      await flowStartRecordingTool.execute({}, { name: "compose-stemless", project_root: tmpDir });
      const stemless = path.join(tmpDir, ".argent", "flows", basename);

      const record = () =>
        tool.execute(
          {},
          {
            name: "compose-stemless",
            project_root: tmpDir,
            command: "flow-execute",
            args: JSON.stringify({ flow_path: stemless, project_root: tmpDir }),
          }
        );
      await expect(record()).rejects.toThrow('Invalid flow name ""');
      await expect(record()).rejects.not.toThrow(/must use the (lowercase )?\.yaml extension/);

      expect(registry.invokeTool).not.toHaveBeenCalled();
      expect(parseFlow(await readFlowFile("compose-stemless")).steps).toEqual([]);
    }
  );

  it("still blames the extension when a sibling's stem carries the wrong case", async () => {
    // The companion to the case above: extname is non-empty here, so this input
    // must keep reaching the lowercase-extension arm.
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-cased", project_root: tmpDir });

    await expect(
      tool.execute(
        {},
        {
          name: "compose-cased",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "Login.YAML"),
            project_root: tmpDir,
          }),
        }
      )
    ).rejects.toThrow('flow files must use the lowercase .yaml extension, not ".YAML"');

    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("rejects a sibling flow_path that the call's project_root does not resolve to", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-mismatch", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    await expect(
      tool.execute(
        {},
        {
          name: "compose-mismatch",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "login.yaml"),
            project_root: path.join(tmpDir, "other-project"),
          }),
        }
      )
    ).rejects.toThrow(/does not resolve "login" to it/);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-mismatch")).steps).toEqual([]);
  });

  // path.resolve anchors a relative project_root at the tool SERVER's cwd — a
  // directory with no relationship to the calling agent's — so a resolve-based
  // comparison would accept or reject the same call depending on where the
  // server was started. Pin the deterministic contract: a relative root is
  // refused outright, EVEN when it would resolve the sibling correctly against
  // this very process's cwd (the one shape a cwd-anchored comparison would let
  // through). Each case mocks the cwd to make the root line up with tmpDir.
  it.each([
    ['"."', (dir: string) => ({ root: ".", cwd: dir })],
    [
      "a bare directory name",
      (dir: string) => ({ root: path.basename(dir), cwd: path.dirname(dir) }),
    ],
  ])(
    "rejects a relative project_root (%s) even when it resolves against the server's cwd",
    async (_shape, build) => {
      const registry = createMockRegistry({
        "flow-execute": { result: { ok: true, steps: [] } },
      });
      const tool = createFlowAddStepTool(registry);

      await flowStartRecordingTool.execute({}, { name: "compose-relative", project_root: tmpDir });
      await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
      const sibling = path.join(tmpDir, ".argent", "flows", "login.yaml");

      const { root, cwd } = build(tmpDir);
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
      try {
        // Sanity: under this cwd the relative root DOES name the sibling, so a
        // cwd-anchored comparison would have accepted the call.
        expect(path.resolve(flowsDirFor(root), "login.yaml")).toBe(sibling);

        await expect(
          tool.execute(
            {},
            {
              name: "compose-relative",
              project_root: tmpDir,
              command: "flow-execute",
              args: JSON.stringify({ flow_path: sibling, project_root: root }),
            }
          )
        ).rejects.toThrow(/project_root must be an absolute path/);
      } finally {
        cwdSpy.mockRestore();
      }

      // Rejected before the rewrite and the live sub-invoke: the args were
      // never forwarded (mutated or otherwise) and nothing was recorded.
      expect(registry.invokeTool).not.toHaveBeenCalled();
      expect(parseFlow(await readFlowFile("compose-relative")).steps).toEqual([]);
    }
  );

  it("names the absolute-path requirement when project_root is missing", async () => {
    const registry = createMockRegistry({
      "flow-execute": { result: { ok: true, steps: [] } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-rootless", project_root: tmpDir });
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");

    await expect(
      tool.execute(
        {},
        {
          name: "compose-rootless",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify({
            flow_path: path.join(tmpDir, ".argent", "flows", "login.yaml"),
          }),
        }
      )
    ).rejects.toThrow(/project_root must be an absolute path \(got none\)/);

    expect(registry.invokeTool).not.toHaveBeenCalled();
    expect(parseFlow(await readFlowFile("compose-rootless")).steps).toEqual([]);
  });

  // The two shapes add-step must NOT rewrite: naming both sources, or neither,
  // is flow-execute's schema to judge. The both-sources case is the dangerous
  // one — rewriting it would delete flow_path and overwrite the caller's name
  // with the stem, so a call asking for "checkout" would run and record "login"
  // with nothing to say the requested name was discarded.
  it.each([
    [
      "names both sources",
      (sibling: string, root: string) => ({
        name: "checkout",
        flow_path: sibling,
        project_root: root,
      }),
    ],
    ["names neither source", (_sibling: string, root: string) => ({ project_root: root })],
  ])("hands a flow-execute that %s to flow-execute verbatim", async (_shape, buildArgs) => {
    // flow-execute refuses both shapes on the source count, so the sub-invoke
    // fails and nothing is recorded; the throwing mock stands in for that.
    const registry = createMockRegistry({ "flow-execute": { result: null, throws: true } });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "compose-ambiguous", project_root: tmpDir });
    // For the both-sources shape, a genuinely rewritable target: every check
    // downstream of the bail-out accepts this flow_path, so the bail-out is the
    // only thing standing between the caller's "checkout" and a swap to "login".
    await writeSiblingFlow("login", "steps:\n  - echo: hi\n");
    const args = buildArgs(path.join(tmpDir, ".argent", "flows", "login.yaml"), tmpDir);

    await expect(
      tool.execute(
        {},
        {
          name: "compose-ambiguous",
          project_root: tmpDir,
          command: "flow-execute",
          args: JSON.stringify(args),
        }
      )
    ).rejects.toThrow();

    // The nested call must reach flow-execute exactly as written — no flow_path
    // deleted, no name substituted…
    expect(registry.invokeTool).toHaveBeenCalledWith("flow-execute", args);
    // …so that a real tool-server is the one that rejects it.
    const nested = (registry.invokeTool as any).mock.calls[0][1];
    await expect(resolveFlowSource(nested)).rejects.toThrow("Pass exactly one flow source");
    expect(parseFlow(await readFlowFile("compose-ambiguous")).steps).toEqual([]);
  });

  it("throws on invalid JSON in args", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "bad-json", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "bad-json", project_root: tmpDir, command: "tap", args: "not valid json {{{" }
      )
    ).rejects.toThrow();

    // Flow file should remain unchanged (no step recorded)
    const content = await readFlowFile("bad-json");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });

  it("keeps the devices list when recording a scoped teardown, so the YAML stays scoped", async () => {
    // `devices` is a scope, not a target: with it stripped, a correctly scoped
    // teardown recorded as a bare `- tool: stop-all-simulator-servers`, which
    // IS the machine-wide sweep — so hand-running the step from the YAML (the
    // create-flow skill's manual-execution strategy) reaped every device on the
    // machine. Replay rebinds the scope to the run device regardless, so
    // keeping it costs portability nothing.
    const registry = createMockRegistry({
      "stop-all-simulator-servers": { result: { stopped: 1 } },
    });
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "teardown-test", project_root: tmpDir });
    await tool.execute(
      {},
      {
        name: "teardown-test",
        project_root: tmpDir,
        command: "stop-all-simulator-servers",
        args: JSON.stringify({ devices: ["00000000-HOST-DEVICE-ID"] }),
      }
    );

    // Ran live with the real devices to stop…
    expect(registry.invokeTool).toHaveBeenCalledWith("stop-all-simulator-servers", {
      devices: ["00000000-HOST-DEVICE-ID"],
    });
    // …and the recorded step still reads as the scoped teardown it was.
    expect(parseFlow(await onDisk("teardown-test")).steps).toEqual([
      {
        kind: "tool",
        name: "stop-all-simulator-servers",
        args: { devices: ["00000000-HOST-DEVICE-ID"] },
      },
    ]);
  });

  it("propagates error when tool is not registered in the registry", async () => {
    const registry = createMockRegistry({}); // no tools registered
    const tool = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "missing-tool", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await expect(
      tool.execute(
        {},
        { name: "missing-tool", project_root: tmpDir, command: "nonexistent-tool", args: "{}" }
      )
    ).rejects.toThrow('Tool "nonexistent-tool" not found');

    // Flow file should remain unchanged
    const content = await readFlowFile("missing-tool");
    const flow = parseFlow(content);
    expect(flow.steps).toEqual([]);
  });
});

// ── flow-finish-recording ────────────────────────────────────────────

describe("flow-finish-recording", () => {
  it("returns summary with prerequisite and clears that recording", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir, message: "Step 1" }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "finish-test", project_root: tmpDir }
    );

    expect(result.message).toContain("finish-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.steps).toBe(1);
    expect(result.summary).toEqual(["1. echo: Step 1"]);

    // The recording is gone — no more steps can be added to it.
    await expect(
      flowInsertEchoTool.execute(
        {},
        { name: "finish-test", project_root: tmpDir, message: "after finish" }
      )
    ).rejects.toThrow("No active recording");
  });

  it("leaves other recordings in progress untouched", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "finish-one", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowStartRecordingTool.execute(
      {},
      { name: "keep-going", project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    await flowFinishRecordingTool.execute({}, { name: "finish-one", project_root: tmpDir });

    const result = await flowInsertEchoTool.execute(
      {},
      { name: "keep-going", project_root: tmpDir, message: "still open" }
    );
    expect(result.message).toContain("keep-going");
    expect(parseFlow(await readFlowFile("keep-going")).steps).toEqual([
      { kind: "echo", message: "still open" },
    ]);
  });

  it("throws when that flow has no recording in progress", async () => {
    await expect(
      flowFinishRecordingTool.execute({}, { name: "not-recording", project_root: tmpDir })
    ).rejects.toThrow("No active recording");
  });

  it("asks about a requires block, since a flow without one runs against every target", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "unrestricted", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "unrestricted", project_root: tmpDir, message: "Step 1" }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "unrestricted", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("declares no `requires:` block");
    expect(result.requiresPrompt).toContain("Ask the user");
    // Nothing to suggest: a launch-free flow says nothing about its platforms.
    expect(result.requiresPrompt).not.toContain("likely answer");
  });

  it("suggests the platforms the recorded launch already limits the flow to", async () => {
    await flowStartRecordingTool.execute({}, { name: "ios-launch", project_root: tmpDir });
    await overwriteFlowFile("ios-launch", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: { ios: "com.example.app" } }],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "ios-launch", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("`requires: { platform: [ios] }` is the likely answer");
  });

  it("suggests both platforms when launches are split across platform guards", async () => {
    // The ios half must not shadow the android half: suggesting [ios] alone
    // would validate and then skip every android run of a live branch.
    await flowStartRecordingTool.execute({}, { name: "split-launch", project_root: tmpDir });
    await overwriteFlowFile("split-launch", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "launch", app: { ios: "com.example.app" } }],
        },
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [{ kind: "launch", app: { android: "com.example.app" } }],
        },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "split-launch", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain(
      "`requires: { platform: [ios, android] }` is the likely answer"
    );
  });

  it("excludes a platform an unguarded launch cannot serve", async () => {
    // For ios the android-guarded block is out of scope, so the ios-only launch
    // suffices; for android that same unguarded launch is in scope with no
    // android id, so android is not suggestible despite its guarded launch.
    await flowStartRecordingTool.execute({}, { name: "unguarded-ios", project_root: tmpDir });
    await overwriteFlowFile("unguarded-ios", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { ios: "com.example.app" } },
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [{ kind: "launch", app: { android: "com.example.app" } }],
        },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "unguarded-ios", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("`requires: { platform: [ios] }` is the likely answer");
  });

  it("suggests nothing when only a UI-guarded launch fails to serve a platform", async () => {
    // ios is excluded solely because the guarded helper launch names no ios id —
    // a launch that never runs while the modal stays shut, so ios passes today
    // and [android] would validate and then skip it for good.
    await flowStartRecordingTool.execute({}, { name: "guarded-helper", project_root: tmpDir });
    await overwriteFlowFile("guarded-helper", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { ios: "com.example.app", android: "com.example.app" } },
        {
          kind: "when",
          condition: { kind: "ui", condition: "visible", selector: { identifier: "modal" } },
          steps: [{ kind: "launch", app: { android: "com.example.helper" } }],
        },
        { kind: "echo", message: "done" },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "guarded-helper", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("declares no `requires:` block");
    expect(result.requiresPrompt).not.toContain("likely answer");
  });

  it("suggests nothing when an excluded platform runs steps but never launches", async () => {
    // ios reaches no launch at all here, so it passes today: suggesting [android]
    // would validate and then skip the whole ios branch.
    await flowStartRecordingTool.execute({}, { name: "ios-branch", project_root: tmpDir });
    await overwriteFlowFile("ios-branch", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [{ kind: "launch", app: { android: "com.example.app" } }],
        },
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "echo", message: "ios-only narration" }],
        },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "ios-branch", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("declares no `requires:` block");
    expect(result.requiresPrompt).not.toContain("likely answer");
  });

  it("still suggests past a live branch an unguarded launch cannot serve", async () => {
    // Not the same shape as the case above: the unguarded launch is in ios scope
    // with no ios id, so an ios run fails at step 1 whatever the branch below
    // would have done, and the block only turns that failure into a skip.
    await flowStartRecordingTool.execute({}, { name: "unguarded-android", project_root: tmpDir });
    await overwriteFlowFile("unguarded-android", {
      executionPrerequisite: "",
      steps: [
        { kind: "launch", app: { android: "com.example.app" } },
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [{ kind: "echo", message: "ios-only narration" }],
        },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "unguarded-android", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain(
      "`requires: { platform: [android] }` is the likely answer"
    );
  });

  it("still suggests when every platform-guarded branch launches", async () => {
    // Control for the suppression above: same shape, but the ios branch launches
    // too, so the platforms left out (chromium, vega) run no steps at all.
    await flowStartRecordingTool.execute({}, { name: "both-branches", project_root: tmpDir });
    await overwriteFlowFile("both-branches", {
      executionPrerequisite: "",
      steps: [
        {
          kind: "when",
          condition: { kind: "platform", platform: "android" },
          steps: [{ kind: "launch", app: { android: "com.example.app" } }],
        },
        {
          kind: "when",
          condition: { kind: "platform", platform: "ios" },
          steps: [
            { kind: "launch", app: { ios: "com.example.app" } },
            { kind: "echo", message: "ios-only narration" },
          ],
        },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "both-branches", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain(
      "`requires: { platform: [ios, android] }` is the likely answer"
    );
  });

  it("states the block's own parse rules, so the template is not merged blindly", async () => {
    await flowStartRecordingTool.execute({}, { name: "prompt-rules", project_root: tmpDir });
    await overwriteFlowFile("prompt-rules", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: { chromium: "/tmp/app" } }],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "prompt-rules", project_root: tmpDir }
    );

    // `requires: {}` is rejected, so "optional" cannot be left to mean "omit both".
    expect(result.requiresPrompt).toContain("each key is optional on its own");
    expect(result.requiresPrompt).toContain("must declare at least one of them");
    expect(result.requiresPrompt).toContain("a repeated platform");
    expect(result.requiresPrompt).toContain("an unknown key inside the block");
    // The hint's block replaces the template's platform line: pasting both would
    // pair [chromium] with runtimeKind tv, which validation rejects.
    expect(result.requiresPrompt).toContain(
      "`requires: { platform: [chromium] }` is the likely answer"
    );
    expect(result.requiresPrompt).toContain("Use it in place of the template's `platform:` line");
  });

  it("names the launch-coverage refusals, so a widened platform list is not written blind", async () => {
    // The hint fires for a hand-narrowed launch map, and a `platform:` list
    // broader than that map serves is refused when the file is read.
    await flowStartRecordingTool.execute({}, { name: "prompt-coverage", project_root: tmpDir });
    await overwriteFlowFile("prompt-coverage", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: { ios: "com.example.app" } }],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "prompt-coverage", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("`requires: { platform: [ios] }` is the likely answer");
    expect(result.requiresPrompt).toContain(
      "a `platform:` list some unconditional launch declares no app id for"
    );
    expect(result.requiresPrompt).toContain("a lone `runtimeKind:` no platform's launches serve");
    expect(result.requiresPrompt).toContain("a block admitting no platform that runs a step");
  });

  it("suggests nothing when the launch names every platform", async () => {
    // A bare app id runs anywhere, so it narrows nothing and must not be
    // dressed up as a recommendation.
    await flowStartRecordingTool.execute({}, { name: "any-launch", project_root: tmpDir });
    await overwriteFlowFile("any-launch", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: "com.example.app" }],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "any-launch", project_root: tmpDir }
    );

    expect(result.requiresPrompt).not.toContain("likely answer");
  });

  it("does not ask once the flow already declares one", async () => {
    await flowStartRecordingTool.execute({}, { name: "restricted", project_root: tmpDir });
    await overwriteFlowFile("restricted", {
      executionPrerequisite: "",
      requires: { platform: ["ios"] },
      steps: [{ kind: "echo", message: "hi" }],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "restricted", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toBeUndefined();
  });

  it("does not ask once a leading run: fragment's block folds into the run's", async () => {
    // The root declares nothing yet runs nowhere but ios, so the question is
    // already answered — and answering it again with [android] would make the
    // fold unsatisfiable.
    await flowStartRecordingTool.execute({}, { name: "wraps-ios-frag", project_root: tmpDir });
    await overwriteFlowFile("ios-fragment", {
      executionPrerequisite: "",
      requires: { platform: ["ios"] },
      steps: [{ kind: "launch", app: { ios: "com.example.app" } }],
    });
    await overwriteFlowFile("wraps-ios-frag", {
      executionPrerequisite: "",
      steps: [{ kind: "run", flow: "ios-fragment.yaml" }],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "wraps-ios-frag", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toBeUndefined();
  });

  it("suggests only what a leading run: fragment's launch also serves", async () => {
    // The root's own map names both platforms, but the fragment that certainly
    // runs first launches ios only, so [ios, android] is a block the composed
    // validator refuses.
    await flowStartRecordingTool.execute({}, { name: "wrapper", project_root: tmpDir });
    await overwriteFlowFile("reset-data", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: { ios: "com.example.app" } }],
    });
    await overwriteFlowFile("wrapper", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "reset-data.yaml" },
        { kind: "launch", app: { ios: "com.example.app", android: "com.example.app" } },
        { kind: "echo", message: "body" },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "wrapper", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("`requires: { platform: [ios] }` is the likely answer");

    // The offer, taken literally, has to survive the composed judgement the run
    // makes — the same one flow-read-prerequisite reports through.
    await overwriteFlowFile("wrapper", {
      executionPrerequisite: "",
      requires: { platform: ["ios"] },
      steps: [
        { kind: "run", flow: "reset-data.yaml" },
        { kind: "launch", app: { ios: "com.example.app", android: "com.example.app" } },
        { kind: "echo", message: "body" },
      ],
    });
    await expect(
      flowReadPrerequisiteTool.execute({}, { name: "wrapper", project_root: tmpDir })
    ).resolves.toMatchObject({ requires: "platform: [ios]" });
  });

  it("suggests the platforms only a leading run: fragment launches", async () => {
    // The root launches nothing of its own, so a single-file read has nothing to
    // offer — while the run really does start at the fragment's ios-only launch.
    await flowStartRecordingTool.execute({}, { name: "no-launch-root", project_root: tmpDir });
    await overwriteFlowFile("ios-launcher", {
      executionPrerequisite: "",
      steps: [{ kind: "launch", app: { ios: "com.example.app" } }],
    });
    await overwriteFlowFile("no-launch-root", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "ios-launcher.yaml" },
        { kind: "echo", message: "body" },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "no-launch-root", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("`requires: { platform: [ios] }` is the likely answer");
  });

  it("finishes on the flow's own steps when the leading fragment cannot be read", async () => {
    // A chain this host cannot walk is the run's problem to report; losing the
    // whole recording over it would be a far worse one.
    await flowStartRecordingTool.execute({}, { name: "broken-chain", project_root: tmpDir });
    await overwriteFlowFile("broken-chain", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "not-here.yaml" },
        { kind: "launch", app: { ios: "com.example.app" } },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "broken-chain", project_root: tmpDir }
    );

    expect(result.steps).toBe(2);
    expect(result.requiresPrompt).toContain("`requires: { platform: [ios] }` is the likely answer");
  });

  it("finishes on the flow's own steps when the leading blocks cannot be folded", async () => {
    // A fold no target satisfies is the run's verdict to deliver — failing the
    // finish over it would lose the recording, on this attempt and every retry.
    await flowStartRecordingTool.execute({}, { name: "collides", project_root: tmpDir });
    await overwriteFlowFile("needs-ios", {
      executionPrerequisite: "",
      requires: { platform: ["ios"] },
      steps: [{ kind: "echo", message: "reset" }],
    });
    await overwriteFlowFile("needs-android", {
      executionPrerequisite: "",
      requires: { platform: ["android"] },
      steps: [{ kind: "echo", message: "seed" }],
    });
    await overwriteFlowFile("collides", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "needs-ios.yaml" },
        { kind: "run", flow: "needs-android.yaml" },
        { kind: "launch", app: { ios: "com.example.app" } },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "collides", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("`requires: { platform: [ios] }` is the likely answer");
    expect(await getRecordingSession(tmpDir, "collides")).toBeUndefined();
  });

  it("finishes on the flow's own steps when the composed block covers no launch", async () => {
    // The fragment's android block folds over a root that launches ios only, so
    // the composed judgement refuses — again the run's to report, not the
    // finish's to die on.
    await flowStartRecordingTool.execute({}, { name: "uncovered", project_root: tmpDir });
    await overwriteFlowFile("android-frag", {
      executionPrerequisite: "",
      requires: { platform: ["android"] },
      steps: [{ kind: "echo", message: "reset" }],
    });
    await overwriteFlowFile("uncovered", {
      executionPrerequisite: "",
      steps: [
        { kind: "run", flow: "android-frag.yaml" },
        { kind: "launch", app: { ios: "com.example.app" } },
      ],
    });

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "uncovered", project_root: tmpDir }
    );

    expect(result.requiresPrompt).toContain("`requires: { platform: [ios] }` is the likely answer");
    expect(await getRecordingSession(tmpDir, "uncovered")).toBeUndefined();
  });

  it("handles empty flow", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "empty", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "empty", project_root: tmpDir }
    );

    expect(result.steps).toBe(0);
    expect(result.summary).toEqual([]);
  });

  it("calling finish twice throws on the second call", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "double-finish", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowFinishRecordingTool.execute({}, { name: "double-finish", project_root: tmpDir });

    // Second call should fail — the recording was cleared
    await expect(
      flowFinishRecordingTool.execute({}, { name: "double-finish", project_root: tmpDir })
    ).rejects.toThrow("No active recording");
  });

  it("returns the file path so the agent knows where it was written", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "path-check", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "path-check", project_root: tmpDir }
    );

    expect(result.path).toContain(path.join(".argent", "flows"));
    expect(result.path).toContain("path-check.yaml");
  });

  it("summary includes both echo and tool steps", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir, message: "Before tap" }
    );
    await addStep.execute(
      {},
      { name: "summary-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "summary-test", project_root: tmpDir }
    );
    expect(result.summary).toEqual(["1. echo: Before tap", '2. tool: tap {"x":0.5}']);
  });

  // `idle` has no recorder command — it is written by hand into the YAML,
  // which the finish re-reads. Without a case here it fell through to the
  // `tool:` default and the summary described the step as a tool call.
  it("summarizes a hand-written idle step as the wait it is", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "idle-summary", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", "idle-summary.yaml"),
      `executionPrerequisite: ${JSON.stringify(PREREQ)}\nsteps:\n  - await: { idle: true }\n`,
      "utf8"
    );

    const result = await flowFinishRecordingTool.execute(
      {},
      { name: "idle-summary", project_root: tmpDir }
    );

    expect(result.summary).toEqual(["1. await: screen idle"]);
  });

  it("distinguishes contains, equals, and regex text comparisons in the summary", async () => {
    const name = "text-comparison-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      serializeFlow({
        executionPrerequisite: PREREQ,
        steps: [
          {
            kind: "await",
            condition: "text",
            selector: { identifier: "status" },
            expectedText: 'Ready "now"\nnext',
            textMatch: "contains",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "status" },
            expectedText: "Ready",
            textMatch: "equals",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "total" },
            expectedText: "^Total: \\$\\d+\\.\\d{2}$",
            textMatch: "matches",
          },
          {
            kind: "assert",
            condition: "text",
            selector: { identifier: "legacy-status" },
            expectedText: "Still running",
          },
        ],
      })
    );

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

    expect(result.summary).toEqual([
      '1. await: text {"id":"status"} contains "Ready \\"now\\"\\nnext"',
      '2. assert: text {"id":"status"} == "Ready"',
      '3. assert: text {"id":"total"} matches /^Total: \\$\\d+\\.\\d{2}$/',
      '4. assert: text {"id":"legacy-status"} contains "Still running"',
    ]);
  });

  it("renders when text guards with the same comparator spelling as await/assert", async () => {
    const name = "when-text-guard-summary";
    await flowStartRecordingTool.execute(
      {},
      { name, project_root: tmpDir, executionPrerequisite: PREREQ }
    );

    const guarded: FlowStep[] = [{ kind: "echo", message: "guarded" }];
    await fs.writeFile(
      path.join(tmpDir, ".argent", "flows", `${name}.yaml`),
      serializeFlow({
        executionPrerequisite: PREREQ,
        steps: [
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "status" },
              expectedText: 'Ready "now"\nnext',
              textMatch: "contains",
            },
            steps: guarded,
          },
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "status" },
              expectedText: "Ready",
              textMatch: "equals",
            },
            steps: guarded,
          },
          {
            kind: "when",
            condition: {
              kind: "ui",
              condition: "text",
              selector: { identifier: "total" },
              expectedText: "^Total: \\$\\d+\\.\\d{2}$",
              textMatch: "matches",
            },
            steps: [...guarded, { kind: "echo", message: "and again" }],
          },
        ],
      })
    );

    const result = await flowFinishRecordingTool.execute({}, { name, project_root: tmpDir });

    expect(result.summary).toEqual([
      '1. when: text {"id":"status"} contains "Ready \\"now\\"\\nnext" (1 step)',
      '2. when: text {"id":"status"} == "Ready" (1 step)',
      '3. when: text {"id":"total"} matches /^Total: \\$\\d+\\.\\d{2}$/ (2 steps)',
    ]);
  });
});

// ── A requires block hand-written mid-take ───────────────────────────

describe("a requires block hand-written mid-take", () => {
  // Hand-editing the .yaml mid-recording is the documented way to write a
  // `requires:` block, so the file can legitimately claim platforms its
  // recorded launches do not cover yet. That intermediate state must stay
  // appendable — flow-finish-recording is the gate that judges the whole flow.

  /** requires claims android too, but the only launch carries an ios id. */
  const MID_TAKE: FlowFile = {
    executionPrerequisite: "",
    requires: { platform: ["ios", "android"] },
    steps: [{ kind: "launch", app: { ios: "com.example.app" } }],
  };

  it("keeps recording steps onto the not-yet-covered take", async () => {
    const registry = createMockRegistry({ tap: { result: { ok: true } } });
    const addStep = createFlowAddStepTool(registry);

    await flowStartRecordingTool.execute({}, { name: "mid-take", project_root: tmpDir });
    await overwriteFlowFile("mid-take", MID_TAKE);

    await addStep.execute(
      {},
      { name: "mid-take", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
    );

    expect(parseFlow(await readFlowFile("mid-take"), { skipRequires: true }).steps).toEqual([
      ...MID_TAKE.steps,
      { kind: "tool", name: "tap", args: { x: 0.5 } },
    ]);
  });

  it("fails the finish while the block is uncovered, recoverably", async () => {
    await flowStartRecordingTool.execute({}, { name: "mid-take-finish", project_root: tmpDir });
    await overwriteFlowFile("mid-take-finish", MID_TAKE);
    const session = await getRecordingSession(tmpDir, "mid-take-finish");

    const err = await flowFinishRecordingTool
      .execute({}, { name: "mid-take-finish", project_root: tmpDir })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIRES_UNSATISFIABLE);
    expect((err as Error).message).toContain("declares no app id for android");

    // The session survived the failed finish, so a repair (the missing android
    // id) followed by a retried finish succeeds.
    expect(await getRecordingSession(tmpDir, "mid-take-finish")).toBe(session);
    await overwriteFlowFile("mid-take-finish", {
      ...MID_TAKE,
      steps: [{ kind: "launch", app: { ios: "com.example.app", android: "com.example.app" } }],
    });
    const finished = await flowFinishRecordingTool.execute(
      {},
      { name: "mid-take-finish", project_root: tmpDir }
    );
    expect(finished.steps).toBe(1);
    expect(await getRecordingSession(tmpDir, "mid-take-finish")).toBeUndefined();
  });
});

// ── flow-execute ─────────────────────────────────────────────────────

describe("flow-execute", () => {
  // An iOS-shaped id so resolveDevice classifies it without listing devices,
  // and the runner never shells out to a real status bar (no `expect` steps).
  const DEVICE = "00000000-0000-0000-0000-0000000000ab";

  it("executes all steps in order", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
      screenshot: {
        result: { url: "http://img", path: "/tmp/img.png" },
        outputHint: "image",
      },
    });
    const addStep = createFlowAddStepTool(registry);
    const runFlow = createRunFlowTool(registry);

    // Build a flow
    await flowStartRecordingTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, message: "Tap button" }
    );
    await addStep.execute(
      {},
      { name: "run-test", project_root: tmpDir, command: "tap", args: '{"x":0.5}' }
    );
    await flowInsertEchoTool.execute(
      {},
      { name: "run-test", project_root: tmpDir, message: "Take screenshot" }
    );
    await addStep.execute(
      {},
      { name: "run-test", project_root: tmpDir, command: "screenshot", args: "{}" }
    );
    await flowFinishRecordingTool.execute({}, { name: "run-test", project_root: tmpDir });

    // Reset mock call counts
    vi.mocked(registry.invokeTool).mockClear();

    // Run the flow
    const result = await runFlow.execute(
      {},
      { name: "run-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );
    assertFlowRunResult(result);

    expect(result.flow).toBe("run-test");
    expect(result.executionPrerequisite).toBe(PREREQ);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(4);

    // Echoes
    expect(result.steps[0]).toMatchObject({ kind: "echo", status: "pass", message: "Tap button" });
    expect(result.steps[2]).toMatchObject({
      kind: "echo",
      status: "pass",
      message: "Take screenshot",
    });

    // Tool calls
    expect(result.steps[1]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "tap",
      result: { tapped: true },
      args: { x: 0.5 },
    });
    expect(result.steps[3]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "screenshot",
      result: { url: "http://img", path: "/tmp/img.png" },
      outputHint: "image",
      args: {},
    });

    expect(registry.invokeTool).toHaveBeenCalledTimes(2);
  });

  it("propagates the request's telemetry attribution to each tool step", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
      swipe: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tele-run.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [
          { kind: "tool", name: "tap", args: { x: 0.5 } },
          { kind: "echo", message: "between" },
          { kind: "tool", name: "swipe", args: { direction: "up" } },
        ],
      })
    );

    const release = vi.fn();
    const recordChildInvocation = vi.fn((_id: string, _args?: unknown) => release);
    const ctx = { artifacts: {}, recordChildInvocation } as unknown as ToolContext;

    await runFlow.execute({}, { name: "tele-run", project_root: tmpDir, device: DEVICE }, ctx);

    // Only the two tool steps dispatch; the echo step records nothing.
    expect(recordChildInvocation).toHaveBeenCalledTimes(2);
    const ids = recordChildInvocation.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(2);
    // Each step's own args reach the recorder so per-step platform can be derived.
    expect(recordChildInvocation).toHaveBeenNthCalledWith(1, ids[0], { x: 0.5 });
    expect(recordChildInvocation).toHaveBeenNthCalledWith(2, ids[1], { direction: "up" });
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      1,
      "tap",
      { x: 0.5 },
      expect.objectContaining({ toolInvocationId: ids[0], recordChildInvocation })
    );
    expect(registry.invokeTool).toHaveBeenNthCalledWith(
      2,
      "swipe",
      { direction: "up" },
      expect.objectContaining({ toolInvocationId: ids[1], recordChildInvocation })
    );
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("stops on first error", async () => {
    const registry = createMockRegistry({
      tap: { result: null, throws: true },
    });
    const runFlow = createRunFlowTool(registry);

    // Manually write a flow file in YAML format
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "echo", message: "Should not reach" },
      ],
    });
    await fs.writeFile(path.join(dir, "error-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "error-test", project_root: tmpDir, device: DEVICE }
    );
    assertFlowRunResult(result);

    // tap errors (recorded), the trailing echo is skipped.
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "tap",
      reason: expect.stringContaining("failed"),
    });
    expect(result.steps[1]).toMatchObject({ kind: "echo", status: "skip" });
    expect(result.ok).toBe(false);
  });

  it("throws when flow file does not exist", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    await expect(
      runFlow.execute({}, { name: "nonexistent", project_root: tmpDir })
    ).rejects.toThrow();
  });

  it("carries outputHint from tool definition", async () => {
    const registry = createMockRegistry({
      screenshot: {
        result: { url: "http://img" },
        outputHint: "image",
      },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Ready",
      steps: [{ kind: "tool", name: "screenshot", args: { udid: "A" } }],
    });
    await fs.writeFile(path.join(dir, "hint-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "hint-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );
    assertFlowRunResult(result);

    expect(result.steps[0]).toMatchObject({
      kind: "tool",
      outputHint: "image",
    });
  });

  it("returns executionPrerequisite from the flow file", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App freshly reloaded",
      steps: [{ kind: "echo", message: "Start" }],
    });
    await fs.writeFile(path.join(dir, "prereq-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "prereq-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );

    expect(result.executionPrerequisite).toBe("App freshly reloaded");
  });

  it("returns a notice when prerequisite exists but is not acknowledged", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "gated.yaml"), content);

    const result = await runFlow.execute({}, { name: "gated", project_root: tmpDir });

    expect(result).toMatchObject({
      flow: "gated",
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "Device unlocked",
    });
    // Should NOT have a steps array — it's a notice, not a run result
    expect(result).not.toHaveProperty("steps");
  });

  it("runs normally when prerequisite exists and is acknowledged", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "Device unlocked",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "ack-test.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "ack-test", project_root: tmpDir, prerequisiteAcknowledged: true, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toHaveLength(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("runs normally when prerequisite is empty and not acknowledged", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.5 } }],
    });
    await fs.writeFile(path.join(dir, "no-gate.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "no-gate", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toHaveLength(1);
    expect(registry.invokeTool).toHaveBeenCalledTimes(1);
  });

  it("returns notice when prerequisiteAcknowledged is explicitly false", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App on settings page",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "explicit-false.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "explicit-false", project_root: tmpDir, prerequisiteAcknowledged: false }
    );

    expect(result).toMatchObject({
      flow: "explicit-false",
      notice: expect.stringContaining("prerequisite"),
      executionPrerequisite: "App on settings page",
    });
    expect(result).not.toHaveProperty("steps");
  });

  it("executes an empty flow (zero steps) successfully", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [],
    });
    await fs.writeFile(path.join(dir, "empty-flow.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "empty-flow", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    expect((result as { steps: unknown[] }).steps).toEqual([]);
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("executes a flow with only echo steps (no registry calls)", async () => {
    const registry = createMockRegistry({});
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "First" },
        { kind: "echo", message: "Second" },
        { kind: "echo", message: "Third" },
      ],
    });
    await fs.writeFile(path.join(dir, "echo-only.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "echo-only", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: { kind: string; status: string; message?: string }[] }).steps;
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => ({ kind: s.kind, status: s.status, message: s.message }))).toEqual([
      { kind: "echo", status: "pass", message: "First" },
      { kind: "echo", status: "pass", message: "Second" },
      { kind: "echo", status: "pass", message: "Third" },
    ]);
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("error mid-flow reports preceding successful steps", async () => {
    const registry = createMockRegistry({
      tap: { result: { tapped: true } },
      swipe: { result: null, throws: true },
    });
    const runFlow = createRunFlowTool(registry);

    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [
        { kind: "echo", message: "Start" },
        { kind: "tool", name: "tap", args: { x: 0.5 } },
        { kind: "tool", name: "swipe", args: { direction: "up" } },
        { kind: "echo", message: "Should not reach" },
      ],
    });
    await fs.writeFile(path.join(dir, "mid-error.yaml"), content);

    const result = await runFlow.execute(
      {},
      { name: "mid-error", project_root: tmpDir, device: DEVICE }
    );

    expect(result).toHaveProperty("steps");
    const steps = (result as { steps: { kind: string }[] }).steps;
    // echo, tap success, swipe error — then the trailing echo is skipped.
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({ kind: "echo", status: "pass", message: "Start" });
    expect(steps[1]).toMatchObject({
      kind: "tool",
      status: "pass",
      tool: "tap",
      result: { tapped: true },
    });
    expect(steps[2]).toMatchObject({
      kind: "tool",
      status: "error",
      tool: "swipe",
      reason: expect.stringContaining("failed"),
    });
    expect(steps[3]).toMatchObject({ kind: "echo", status: "skip" });
  });

  it("sleeps the step's delayMs before executing it", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    const runFlow = createRunFlowTool(registry);
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    // Small delay: the step's configured delayMs is honored before the tool
    // runs. The magnitude is irrelevant to the regression guard — without the
    // delay this completes in ~0ms, so a 25ms wait still proves the behavior
    // while keeping the test off a real ~300ms sleep.
    const delayMs = 25;
    await fs.writeFile(
      path.join(dir, "pre-delay.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        steps: [{ kind: "tool", name: "tap", args: { x: 0.5 }, delayMs }],
      })
    );
    const start = Date.now();
    await runFlow.execute({}, { name: "pre-delay", project_root: tmpDir, device: DEVICE });
    expect(Date.now() - start).toBeGreaterThanOrEqual(delayMs - 5);
  });

  it("does not interfere with active recording state", async () => {
    const registry = createMockRegistry({
      tap: { result: { ok: true } },
    });
    const runFlow = createRunFlowTool(registry);
    const addStep = createFlowAddStepTool(registry);

    // A flow to run in the recording's own project AND one in another project —
    // replay must be inert for the recording either way, and a replay under a
    // different project_root is exactly what a second agent's run looks like.
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: "tap", args: { x: 0.1 } }],
    });
    for (const root of [tmpDir, otherDir]) {
      const dir = path.join(root, ".argent", "flows");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "side-effect.yaml"), content);
    }

    // Start recording a different flow
    await flowStartRecordingTool.execute(
      {},
      { name: "recording", project_root: tmpDir, executionPrerequisite: PREREQ }
    );
    const before = await getRecordingSession(tmpDir, "recording");
    expect(before).toBeDefined();

    // Execute saved flows — neither should affect the active recording
    await runFlow.execute({}, { name: "side-effect", project_root: tmpDir, device: DEVICE });
    await runFlow.execute({}, { name: "side-effect", project_root: otherDir, device: DEVICE });

    // The recording still points at the flow it was opened for, in its own
    // project — a replay elsewhere must not rebind name/root/file.
    const after = await getRecordingSession(tmpDir, "recording");
    expect(after).toBe(before);
    expect(after).toMatchObject({
      name: "recording",
      projectRoot: tmpDir,
      filePath: path.join(tmpDir, ".argent", "flows", "recording.yaml"),
    });

    // We should still be able to add steps to the recording…
    const result = await flowInsertEchoTool.execute(
      {},
      { name: "recording", project_root: tmpDir, message: "still recording" }
    );
    expect(result.message).toContain("recording");
    await addStep.execute(
      {},
      { name: "recording", project_root: tmpDir, command: "tap", args: '{"x":0.9}' }
    );

    // …and they land in the original flow's file, not the replayed project's.
    expect(parseFlow(await readFlowFile("recording")).steps).toEqual([
      { kind: "echo", message: "still recording" },
      { kind: "tool", name: "tap", args: { x: 0.9 } },
    ]);
    await expect(readFlowFile("recording", otherDir)).rejects.toThrow();
  });
});

// ── saved-flow name spelling ─────────────────────────────────────────

/**
 * The `name` branch has to hold the same on-disk-spelling invariant the
 * flow_path branch holds: a case-insensitive filesystem (APFS, NTFS) opens
 * snap.yaml for "Snap", and the name — not the file — is what keys the report
 * and __baselines__/, so the run would seed baselines in a directory no entry
 * carries and fail on the first case-sensitive checkout. Every case here reads
 * the directory LISTING, which returns stored bytes on every platform, so they
 * decide identically on case-sensitive (Linux CI) and case-insensitive
 * filesystems.
 */
describe("saved-flow name spelling", () => {
  const DEVICE = "00000000-0000-0000-0000-0000000000ab";

  async function writeFlowFile(basename: string): Promise<string> {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, basename);
    await fs.writeFile(
      filePath,
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message: "hi" }] }),
      "utf8"
    );
    return filePath;
  }

  it("rejects a name the filesystem would case-fold, handing back the on-disk name", async () => {
    await writeFlowFile("snap.yaml");

    const err = await resolveFlowSource({ name: "Snap", project_root: tmpDir }).then(
      () => null,
      (e: unknown) => e as Error
    );

    // The refusal must name the phantom spelling, the real directory entry,
    // and the stake — then hand back a name, not a flow_path: the caller
    // passed a name and may have no filesystem to spell a path against.
    expect(err?.message).toContain('Invalid flow name "Snap"');
    expect(err?.message).toContain('matched it case-insensitively to "snap.yaml"');
    expect(err?.message).toContain("__baselines__");
    expect(err?.message).toContain('Pass name "snap".');
    expect(err?.message).not.toContain("flow_path");
  });

  it("suggests a rename when the on-disk flow's extension case is unaddressable", async () => {
    // upper.YAML is reachable by no name at all — this branch always builds
    // "<name>.yaml" — and `argent flow list` omits it, so the only honest
    // recovery is the rename.
    await writeFlowFile("upper.YAML");

    const err = await resolveFlowSource({ name: "upper", project_root: tmpDir }).then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(err?.message).toContain('matched it case-insensitively to "upper.YAML"');
    expect(err?.message).toContain(
      'Rename "upper.YAML" to "upper.yaml" to run it — flow files must be lowercase .yaml.'
    );
    expect(err?.message).not.toContain("Pass name");
  });

  it("accepts the exact on-disk spelling, mixed case included", async () => {
    // Byte-for-byte is the contract — not lowercasing: a flow really saved as
    // MixedCase.yaml runs under exactly that name.
    const filePath = await writeFlowFile("MixedCase.yaml");

    await expect(resolveFlowSource({ name: "MixedCase", project_root: tmpDir })).resolves.toEqual({
      filePath,
      flowName: "MixedCase",
      viaUpload: false,
    });
  });

  it("leaves a name that matches nothing as an ordinary missing flow", async () => {
    // No entry case-folds to "nonexistent.yaml", so this is not a spelling
    // problem at all: resolution succeeds and the read reports the absence,
    // exactly as before this gate existed.
    await writeFlowFile("other.yaml");
    const registry = createMockRegistry({});

    await expect(resolveFlowSource({ name: "nonexistent", project_root: tmpDir })).resolves.toEqual(
      {
        filePath: path.join(tmpDir, ".argent", "flows", "nonexistent.yaml"),
        flowName: "nonexistent",
        viaUpload: false,
      }
    );

    const err = await createRunFlowTool(registry)
      .execute({}, { name: "nonexistent", project_root: tmpDir, device: DEVICE })
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain("ENOENT");
    expect(err?.message).not.toContain("case-insensitively");
  });

  it("skips the check when the flows directory's listing is unavailable", async () => {
    // An execute-only flows directory refuses the listing while still opening
    // the file (here: no .argent/flows at all). An unreadable listing vouches
    // for nothing, so it must refuse nothing — the later read reports absence.
    await expect(resolveFlowSource({ name: "unlisted", project_root: tmpDir })).resolves.toEqual({
      filePath: path.join(tmpDir, ".argent", "flows", "unlisted.yaml"),
      flowName: "unlisted",
      viaUpload: false,
    });
  });

  it("trusts a boundary-materialized upload over the local flows directory", async () => {
    // A remote client's upload lands in a temp dir this server itself named
    // from `name`, so listing it could only agree with itself; the listing that
    // could disagree is the client's, on a host this process cannot read. The
    // co-located snap.yaml below is what THIS host happens to hold at the same
    // path — checking against it would reject a legitimate remote run.
    await writeFlowFile("snap.yaml");
    const uploaded = path.join(os.tmpdir(), "argent-file-input-abc", "Snap.yaml");

    await expect(
      resolveFlowSource(
        { name: "Snap", project_root: tmpDir, flow_file: uploaded },
        {
          clientPath: path.join(tmpDir, ".argent", "flows", "Snap.yaml"),
          presentOnHost: false,
          viaUpload: true,
        }
      )
    ).resolves.toEqual({ filePath: uploaded, flowName: "Snap", viaUpload: true });
  });

  it("flow-execute refuses the mis-cased name before running any step", async () => {
    const registry = createMockRegistry({ tap: { result: { tapped: true } } });
    await writeFlowFile("checkout.yaml");

    await expect(
      createRunFlowTool(registry).execute(
        {},
        { name: "Checkout", project_root: tmpDir, device: DEVICE }
      )
    ).rejects.toThrow('Pass name "checkout".');
    expect(registry.invokeTool).not.toHaveBeenCalled();
  });

  it("flow-read-prerequisite refuses the same name flow-execute would", async () => {
    // Both tools resolve through resolveFlowSource, so the pre-flight cannot
    // answer for a spelling the run itself refuses.
    await writeFlowFile("checkout.yaml");

    await expect(
      flowReadPrerequisiteTool.execute({}, { name: "Checkout", project_root: tmpDir })
    ).rejects.toThrow('Invalid flow name "Checkout"');
  });
});

// ── flow-read-prerequisite ───────────────────────────────────────────

describe("flow-read-prerequisite", () => {
  it("reads the prerequisite from a saved flow", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "App on home screen",
      steps: [{ kind: "echo", message: "Step 1" }],
    });
    await fs.writeFile(path.join(dir, "read-test.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "read-test", project_root: tmpDir }
    );

    expect(result.flow).toBe("read-test");
    expect(result.executionPrerequisite).toBe("App on home screen");
  });

  it("returns empty string when flow has no prerequisite", async () => {
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    const content = serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "echo", message: "Hello" }],
    });
    await fs.writeFile(path.join(dir, "empty-prereq.yaml"), content);

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "empty-prereq", project_root: tmpDir }
    );

    expect(result.flow).toBe("empty-prereq");
    expect(result.executionPrerequisite).toBe("");
  });

  it("reports the requires block in its YAML spelling", async () => {
    // The other half of the start contract: a run on a target this block
    // excludes is refused, so a pre-flight that reported only the
    // prerequisite would let the agent satisfy state for a run that never
    // starts.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tv-only.yaml"),
      serializeFlow({
        executionPrerequisite: "App on home screen",
        requires: { platform: ["ios", "android"], runtimeKind: "tv" },
        steps: [{ kind: "echo", message: "Step 1" }],
      })
    );

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "tv-only", project_root: tmpDir }
    );

    expect(result.executionPrerequisite).toBe("App on home screen");
    expect(result.requires).toBe("platform: [ios, android], runtimeKind: tv");
  });

  it("reports an empty requires when the flow runs anywhere", async () => {
    // Same convention as executionPrerequisite: "" is "no contract", so one
    // absent-value rule covers both halves of the result.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "anywhere.yaml"),
      serializeFlow({ executionPrerequisite: "", steps: [{ kind: "echo", message: "Hello" }] })
    );

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "anywhere", project_root: tmpDir }
    );

    expect(result.requires).toBe("");
  });

  it("reports the block folded across the leading run: chain, not the file's own", async () => {
    // The root declares nothing, so its own block is "runs anywhere" — but the
    // fragment its first step enters is certain to execute, and the runner
    // folds that fragment's block into what it judges the run by. Reporting
    // the file's own block here would answer "runs anywhere" for a run the
    // runner refuses on every non-ios target.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "ios-fragment.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        requires: { platform: ["ios"] },
        steps: [{ kind: "echo", message: "from the fragment" }],
      })
    );
    await fs.writeFile(
      path.join(dir, "composed-root.yaml"),
      serializeFlow({
        executionPrerequisite: "App on home screen",
        steps: [{ kind: "run", flow: "ios-fragment.yaml" }],
      })
    );

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "composed-root", project_root: tmpDir }
    );

    expect(result.requires).toBe("platform: [ios]");
  });

  it("anchors a symlinked root's chain at the real file, as the runner does", async () => {
    // The fragment sits beside the REAL file, so only a canonicalized anchor
    // reaches it. Without one this answers "runs anywhere" for a run the
    // runner still refuses - the exact divergence the field exists to close.
    const dir = path.join(tmpDir, ".argent", "flows");
    const vault = path.join(tmpDir, "vault");
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(vault, { recursive: true });
    await fs.writeFile(
      path.join(vault, "frag.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        requires: { platform: ["ios"] },
        steps: [{ kind: "echo", message: "from the vault" }],
      })
    );
    await fs.writeFile(
      path.join(vault, "real-root.yaml"),
      serializeFlow({
        executionPrerequisite: "App on home screen",
        steps: [{ kind: "run", flow: "frag.yaml" }],
      })
    );
    await fs.symlink(path.join(vault, "real-root.yaml"), path.join(dir, "sym-root.yaml"));

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { name: "sym-root", project_root: tmpDir }
    );

    expect(result.requires).toBe("platform: [ios]");
  });

  it("refuses a chain whose folded block can never be satisfied, as the run would", async () => {
    // Each file is fine alone; only the fold collides. Reporting the root's own
    // block here would answer "platform: [chromium]" for a run that cannot
    // start on any target at all.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "tv-fragment.yaml"),
      serializeFlow({
        executionPrerequisite: "",
        requires: { runtimeKind: "tv" },
        steps: [{ kind: "echo", message: "from the fragment" }],
      })
    );
    await fs.writeFile(
      path.join(dir, "impossible-root.yaml"),
      serializeFlow({
        executionPrerequisite: "App on home screen",
        requires: { platform: ["chromium"] },
        steps: [{ kind: "run", flow: "tv-fragment.yaml" }],
      })
    );

    let err: unknown;
    try {
      await flowReadPrerequisiteTool.execute({}, { name: "impossible-root", project_root: tmpDir });
    } catch (e) {
      err = e;
    }
    expect((err as Error | undefined)?.message).toMatch(
      /can never be satisfied together.*platform: \[chromium\].*runtimeKind: tv/s
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_REQUIRES_UNSATISFIABLE);
  });

  it("throws when the flow file does not exist", async () => {
    await expect(
      flowReadPrerequisiteTool.execute({}, { name: "nonexistent", project_root: tmpDir })
    ).rejects.toThrow();
  });

  it("advertises exactly one of name and flow_path as the flow source", () => {
    // The pre-flight must offer the same source contract as the run it
    // precedes — a schema still requiring `name` would leave flow_path flows
    // unaddressable and silently answer for a saved flow of the same stem.
    const schema = zodObjectToJsonSchema(flowReadPrerequisiteTool.zodSchema!);
    expect(schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        flow_path: { type: "string" },
      },
    });
    // Neither source may be `required`: the exactly-one rule cannot be a
    // top-level oneOf (tool-input-schema-contract.test.ts), so the zod
    // superRefine enforces it and the description states it.
    expect(schema.required as string[]).not.toContain("name");
    expect(schema.required as string[]).not.toContain("flow_path");
    expect(flowReadPrerequisiteTool.description).toMatch(/one and only one/i);
  });

  it("reads a boundary-verified flow_path's prerequisite, not the saved flow of the same stem", async () => {
    // Two flows share the stem "gate": the saved copy under .argent/flows and
    // an explicit file elsewhere. The flow_path call must answer with the
    // explicit file's contract and the basename-derived name — exactly what
    // flow-execute would run for the same params — never the saved copy's.
    const savedDir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(savedDir, { recursive: true });
    await fs.writeFile(
      path.join(savedDir, "gate.yaml"),
      serializeFlow({ executionPrerequisite: "SAVED-COPY: HOME screen", steps: [] })
    );
    const elsewhere = path.join(tmpDir, "elsewhere");
    await fs.mkdir(elsewhere, { recursive: true });
    const explicitPath = path.join(elsewhere, "gate.yaml");
    await fs.writeFile(
      explicitPath,
      serializeFlow({ executionPrerequisite: "SHARED-COPY: DETAIL screen", steps: [] })
    );

    const result = await flowReadPrerequisiteTool.execute(
      {},
      { project_root: tmpDir, flow_path: explicitPath },
      {
        artifacts: new ArtifactStore(),
        fileInputs: {
          flow_path: {
            clientPath: explicitPath,
            presentOnHost: true,
            viaUpload: false,
            statVerified: true,
          },
        },
      }
    );

    expect(result.flow).toBe("gate");
    expect(result.executionPrerequisite).toBe("SHARED-COPY: DETAIL screen");
  });

  it("rejects a raw flow_path that skipped the boundary even when the file exists", async () => {
    // Same gate as flow-execute: without boundary evidence an explicit path
    // must not be read — otherwise this tool would hand out prerequisites for
    // arbitrary server files the run tool itself refuses to touch.
    const rawPath = path.join(tmpDir, "raw.yaml");
    await fs.writeFile(rawPath, serializeFlow({ executionPrerequisite: "raw", steps: [] }));

    await expect(
      flowReadPrerequisiteTool.execute({}, { project_root: tmpDir, flow_path: rawPath })
    ).rejects.toThrow("flow_path file-input boundary");
  });

  it("rejects a presence-only flow_path without the client-stat match", async () => {
    // presentOnHost alone is satisfiable by a hand-crafted stat-less wrapper;
    // the read must require the same statVerified evidence flow-execute does,
    // not a weaker copy of the gate.
    const presentPath = path.join(tmpDir, "present.yaml");
    await fs.writeFile(presentPath, serializeFlow({ executionPrerequisite: "p", steps: [] }));

    await expect(
      flowReadPrerequisiteTool.execute(
        {},
        { project_root: tmpDir, flow_path: presentPath },
        {
          artifacts: new ArtifactStore(),
          fileInputs: {
            flow_path: { clientPath: presentPath, presentOnHost: true, viaUpload: false },
          },
        }
      )
    ).rejects.toThrow("flow_path file-input boundary");
  });

  it("rejects direct callers that provide both flow sources", async () => {
    // Direct execute() bypasses zod, so resolveFlowSource's own exactly-one
    // copy must refuse before either file is consulted.
    await expect(
      flowReadPrerequisiteTool.execute(
        {},
        { name: "gate", project_root: tmpDir, flow_path: path.join(tmpDir, "gate.yaml") }
      )
    ).rejects.toThrow("exactly one flow source");
  });

  it("rejects direct callers that provide NEITHER flow source", async () => {
    await expect(flowReadPrerequisiteTool.execute({}, { project_root: tmpDir })).rejects.toThrow(
      "exactly one flow source"
    );
  });
});

describe("the flow-add-step schema the CLI tests hand-copy", () => {
  // Three CLI test files encode this schema as a fixture — `run-help.test.ts`,
  // `flag-parser.test.ts` and `run-flow-add-step-payload.test.ts` — because
  // `@argent/cli` does not depend on the tool-server and so cannot derive it.
  // That makes drift silent in the direction that matters: relaxing the real
  // schema here (making `project_root` optional, renaming `args`) leaves all
  // three green while the CLI's `--args` handling and help output are decided
  // by a schema nothing resembles any more.
  //
  // So the guard lives on this side, where the schema is. If this fails,
  // update those three fixtures in the same change.
  const CLI_FIXTURE_PROPERTIES = ["name", "project_root", "command", "args", "delayMs"];
  const CLI_FIXTURE_REQUIRED = ["name", "project_root", "command"];

  it("still declares exactly the properties and required keys those fixtures encode", () => {
    const schema = zodObjectToJsonSchema(
      createFlowAddStepTool({} as unknown as Registry).zodSchema!
    ) as { properties: Record<string, unknown>; required?: string[] };

    expect(Object.keys(schema.properties).sort()).toEqual([...CLI_FIXTURE_PROPERTIES].sort());
    expect([...(schema.required ?? [])].sort()).toEqual([...CLI_FIXTURE_REQUIRED].sort());
    // `parseFlags` branches on this one specifically: a tool that declares its
    // own `args` must not also advertise the whole-payload `--args <json>`
    // escape hatch.
    expect(schema.properties["args"]).toMatchObject({ type: "string" });
  });

  it("still opens its description with the sentence those fixtures quote verbatim", () => {
    expect(createFlowAddStepTool({} as unknown as Registry).description).toContain(
      "Execute a tool call and record it as a step in the flow named by `name` + `project_root`"
    );
  });
});

// ── summarizeStep rendering ──────────────────────────────────────────
//
// summarizeStep is the single spelling shared by the recorder's per-step
// `recorded` line and flow-finish-recording's `summary`. `times` (tap),
// `duration` (long-press) and `delayMs` (tool) change what replays, so a
// summary that drops them misdescribes the file. long-press steps have no
// live recorder path, so this is the only coverage of that rendering.
describe("summarizeStep rendering", () => {
  it("renders a tap's times count", () => {
    // A recorded selector spells the id key `identifier`; selectorToYaml maps it
    // to the file's `id` spelling, so the rendered line reads {"id":…}.
    expect(summarizeStep({ kind: "tap", selector: { identifier: "b" }, times: 2 }, 1)).toBe(
      '1. tap: {"id":"b"} ×2'
    );
    expect(summarizeStep({ kind: "tap", x: 0.5, y: 0.3 }, 1)).toBe("1. tap: (0.5, 0.3)");
  });

  it("renders the count it was given, across the range the file can carry", () => {
    // Every other assertion that renders a count uses `times: 2`, so replacing
    // `×${step.times}` with a constant `×2` left the whole suite green. The rest
    // of the range is reachable: gesture-tap takes clickCount up to 10,
    // flow-add-step records it as `times`, and parseTapTimes admits 2..10. Under
    // that mutation a recorded triple-tap renders `×2` on the `recorded` line —
    // the author's only per-step view of what was appended.
    expect(summarizeStep({ kind: "tap", selector: { identifier: "b" }, times: 3 }, 1)).toBe(
      '1. tap: {"id":"b"} ×3'
    );
    expect(summarizeStep({ kind: "tap", x: 0.5, y: 0.3, times: 10 }, 1)).toBe(
      "1. tap: (0.5, 0.3) ×10"
    );
  });

  it("never renders ×1 — the file can't carry times: 1", () => {
    // parseTapTimes normalizes `times: 1` to absent, so a valid flow file never
    // spells a single tap with a count. summarizeStep renders the file's
    // spelling, so a stray in-memory `times: 1` must read as a plain tap, not ×1.
    expect(summarizeStep({ kind: "tap", x: 0.5, y: 0.3, times: 1 }, 1)).toBe("1. tap: (0.5, 0.3)");
    expect(summarizeStep({ kind: "tap", selector: { identifier: "b" }, times: 1 }, 1)).toBe(
      '1. tap: {"id":"b"}'
    );
  });

  it("renders a multi-field selector independently of its key order", () => {
    // This render is also the step anchor. The anchor compares an in-memory
    // selector, whose key order comes from the source object, with one from
    // `parseSelector`, whose key order comes from the zod schema. If the two
    // spellings render differently, the recording loses every verdict, and
    // nothing in the payload shows it. Today `deriveSelector` returns one field
    // on every branch, so nothing else pins this.
    const a = summarizeStep({ kind: "tap", selector: { identifier: "b", text: "Go" } }, 1);
    const b = summarizeStep({ kind: "tap", selector: { text: "Go", identifier: "b" } }, 1);
    expect(a).toBe(b);
    expect(a).toBe('1. tap: {"id":"b","text":"Go"}');
  });

  it("renders a long-press hold duration", () => {
    expect(
      summarizeStep({ kind: "long-press", selector: { text: "Row" }, duration: 1200 }, 3)
    ).toBe('3. long-press: {"text":"Row"} for 1200ms');
    expect(summarizeStep({ kind: "long-press", x: 0.4, y: 0.5 }, 3)).toBe(
      "3. long-press: (0.4, 0.5)"
    );
  });

  it("renders a launch step's app, per-platform map included", () => {
    // `launch` and `run` are the two kinds the recorder builds besides tap and
    // tool, so both reach the author through `recorded` — yet mutating either
    // arm to a constant used to fail nothing. A per-platform launch map is not
    // recorder-reachable (the rewrite only maps a plain bundleId), but it is
    // the arm's other branch and finish-recording renders it.
    expect(summarizeStep({ kind: "launch", app: "com.acme.app" }, 1)).toBe(
      "1. launch: com.acme.app"
    );
    expect(
      summarizeStep({ kind: "launch", app: { ios: "com.acme.app", android: "com.acme" } }, 2)
    ).toBe('2. launch: {"ios":"com.acme.app","android":"com.acme"}');
  });

  it("renders a run step's target as the file spells it", () => {
    // The as-written YAML path, not a resolved absolute one — the summary
    // quotes the file so a reader can find the line they are being told about.
    expect(summarizeStep({ kind: "run", flow: "login.yaml" }, 1)).toBe("1. run: login.yaml");
    expect(summarizeStep({ kind: "run", flow: "../shared/login.yaml" }, 5)).toBe(
      "5. run: ../shared/login.yaml"
    );
  });

  it("renders a tool step's pre-step delay", () => {
    expect(
      summarizeStep({ kind: "tool", name: "screenshot", args: { scale: 0.2 }, delayMs: 500 }, 4)
    ).toBe('4. tool: screenshot {"scale":0.2} (after 500ms)');
    expect(summarizeStep({ kind: "tool", name: "screenshot", args: {} }, 4)).toBe(
      "4. tool: screenshot {}"
    );
  });

  // `fromYamlStep` copies `delayMs` across without checking its type and
  // `validateFlow` does not check it either, so a hand-edited non-number
  // survives a parse and reaches the renderer. The line must describe what the
  // RUNNER does with such a value — it gates on truthiness and hands the raw
  // value to setTimeout — not what `typeof` says about it, since the two
  // disagree in both directions.
  const toolStepWithDelay = (yamlDelay: string) =>
    parseFlow(
      `executionPrerequisite: ""\nsteps:\n  - tool: screenshot\n    args: {}\n    delayMs: ${yamlDelay}\n`
    ).steps[0];

  it("renders no delay for a hand-edited delayMs the runner will not sleep", () => {
    // `soon` coerces to NaN, which setTimeout floors to an immediate tick.
    expect(summarizeStep(toolStepWithDelay("soon"), 4)).toBe("4. tool: screenshot {}");
    // `.nan` IS a number, so a `typeof` check announced `(after NaNms)` — but
    // it is falsy, so the runner's gate skips the sleep entirely.
    expect(summarizeStep(toolStepWithDelay(".nan"), 4)).toBe("4. tool: screenshot {}");
    // Same tick, same silence: neither reaches setTimeout's 1ms floor.
    expect(summarizeStep(toolStepWithDelay("0"), 4)).toBe("4. tool: screenshot {}");
    expect(summarizeStep(toolStepWithDelay("-5"), 4)).toBe("4. tool: screenshot {}");
  });

  it("renders the delay a quoted number really sleeps", () => {
    // A quoted numeric is an ordinary slip in the post-finish hand edit, and it is
    // not inert: the runner's gate is truthiness, and setTimeout coerces the
    // string, so this waits two real seconds on every replay. A `typeof` check
    // rendered nothing at all for it.
    expect(summarizeStep(toolStepWithDelay('"2000"'), 4)).toBe(
      "4. tool: screenshot {} (after 2000ms)"
    );
  });
});
