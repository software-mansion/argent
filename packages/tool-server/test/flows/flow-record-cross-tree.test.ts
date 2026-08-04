import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { ToolNotFoundError, ToolExecutionError } from "@argent/registry";
import type { DescribeNode, DescribeTreeData } from "../../src/tools/describe/contract";

// `await-ui-element` evaluates against the ACCESSIBILITY tree; the
// `await:`/`assert:` directive the flow carries is evaluated against the full
// native hierarchy. They overlap but neither contains the other — an id in the
// runner tree can be absent from the AX tree, and a text field's value visible
// to the recorder can be invisible to the runner. So a check could pass live
// and fail on every replay, which makes "each step is executed live so you
// verify it works before it's recorded" untrue exactly where it matters.
//
// These tests serve the RUNNER's tree (what `fetchFlowTree` returns) while the
// await-ui-element tool is stubbed to report success, i.e. the AX tree agreed.

let runnerTree: () => DescribeNode;
vi.mock("../../src/tools/flows/flow-tree", () => ({
  fetchFlowTree: vi.fn(
    async (): Promise<DescribeTreeData> => ({
      tree: runnerTree(),
      source: "native-devtools",
      screen: { width: 390, height: 844 },
    })
  ),
}));

import { flowStartRecordingTool } from "../../src/tools/flows/flow-start-recording";
import { createFlowAddStepTool } from "../../src/tools/flows/flow-add-step";
import { __resetRecordingsForTesting, parseFlow } from "../../src/tools/flows/flow-utils";

const DEVICE = "00000000-0000-0000-0000-0000000000ab"; // iOS UDID shape
let tmpDir: string;

const FULL: DescribeNode["frame"] = { x: 0, y: 0, width: 1, height: 1 };

function screen(labels: string[]): DescribeNode {
  return {
    role: "AXWindow",
    frame: FULL,
    children: labels.map((label, i) => ({
      role: "AXStaticText",
      label,
      frame: { x: 0, y: 0.1 * i, width: 1, height: 0.08 },
      children: [],
    })),
  };
}

/** A registry whose `await-ui-element` always reports the condition met. */
function registryWhereWaitSucceeds(): Registry {
  return {
    invokeTool: vi.fn(async (id: string) => {
      if (id === "await-ui-element") return { success: true, elapsed: 120 };
      // The real registry throws `ToolNotFoundError` (not a plain Error) for an
      // unregistered id — `isToolNotFound` keys on that type, so the mock must
      // match production for the directive-hint path to be reached.
      throw new ToolNotFoundError(id);
    }),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

async function onDisk(name: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, ".argent", "flows", `${name}.yaml`), "utf8");
}

async function recordWait(name: string, selectorText: string, udid: string = DEVICE) {
  const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
  return tool.execute(
    {},
    {
      name,
      project_root: tmpDir,
      command: "await-ui-element",
      args: JSON.stringify({
        udid,
        condition: "visible",
        selector: { text: selectorText },
      }),
    }
  );
}

const ANDROID = "emulator-5554"; // adb-serial shape → classifies android
const CHROMIUM = "chromium-cdp-9222"; // chromium-cdp- prefix → classifies chromium

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-cross-tree-"));
  __resetRecordingsForTesting();
  runnerTree = () => screen(["Continue"]);
});

afterEach(async () => {
  __resetRecordingsForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("a recorded wait is re-probed against the runner's tree", () => {
  it("records the step when both trees agree", async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "agree", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("agree", "Continue");

    expect(result.message).toContain("Step added");
    expect(parseFlow(await onDisk("agree")).steps).toHaveLength(1);
  });

  it("warns — but still records — a check the runner's tree cannot see", async () => {
    // The wait passed against the AX tree and the element the runner reads has
    // no such text. The step IS recorded, because what the recorder writes is
    // a raw `tool: await-ui-element` step, and at replay that tool reads the
    // very tree it just passed against — "it would fail every run" was false.
    // What the probe really reports is that converting it to `await:`/`assert:`
    // at polish would not resolve, which is exactly what the warning says.
    runnerTree = () => screen(["Proceed"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "disagree", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("disagree", "Continue");

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    // The probe reads on the same short grace an `assert:` uses, so it predicts
    // that conversion exactly; an `await:` polls longer, so it is only warned as
    // conditional — not a flat "WILL fail" the probe's 1s window can't prove.
    expect(result.message).toContain("an `assert:` conversion WILL fail");
    expect(result.message).toContain("an `await:` will too unless the element reaches that tree");
    expect(result.message).not.toContain("`await:`/`assert:` at polish WILL fail");
    expect(result.message).toContain("native-find-views");
    expect(parseFlow(await onDisk("disagree")).steps).toHaveLength(1);
  }, 20_000);

  it("records with a warning when the runner's tree cannot be read at all", async () => {
    // The injection-free case: the runner's tree source is unavailable on this
    // device. Indeterminate is not a verdict, so refusing here would block a
    // form the skill explicitly sanctions.
    runnerTree = () => {
      throw new Error("native devtools is unavailable");
    };
    await flowStartRecordingTool.execute(
      {},
      { name: "blind", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("blind", "Continue");

    expect(result.message).toContain("Step added");
    expect(result.message).toContain("could not be re-verified against the tree the RUNNER reads");
    expect(parseFlow(await onDisk("blind")).steps).toHaveLength(1);
  }, 20_000);

  // The reader clause is platform-specific on purpose: no read-only tool reads
  // Android's runner tree (the full a11y hierarchy — native-find-views /
  // native-full-hierarchy are Apple-only), and Android `describe` returns the
  // TRIMMED tree the recorder already read. So the warning must NOT tell an
  // Android author that `describe` "reads the runner's side" — that would point
  // them at the recorder's own tree, the exact wrong-tree steer this warns
  // about. It also must not name the Apple-only `native-find-views`.
  it("on Android, does not claim `describe` reads the runner's side", async () => {
    runnerTree = () => screen(["Proceed"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "android", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("android", "Continue", ANDROID);

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    // The reader clause is its own sentence after the divergence sentence's
    // period, so it must start capitalized — not "…drops. no read-only…".
    expect(result.message).toContain(
      "drops. No read-only tool exposes the runner's full hierarchy on Android"
    );
    expect(result.message).not.toContain("reads the runner's side");
    expect(result.message).not.toContain("native-find-views");
    expect(parseFlow(await onDisk("android")).steps).toHaveLength(1);
  }, 20_000);

  // The Chromium reader clause is special-cased for the same reason Android is:
  // `describe` on Chromium is the recorder's UN-trimmed DOM (a superset), and it
  // still shows the very nodes — role-only, non-addressable — that the runner's
  // addressable-only tree drops. Telling the author `describe` "reads the
  // runner's side" would send them to a tool that shows the element the runner
  // can't see, so they'd ship an `assert:` that fails every replay. The warning
  // must NOT name `describe` as the runner's reader there.
  it("on Chromium, does not claim `describe` reads the runner's side", async () => {
    runnerTree = () => screen(["Proceed"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "chromium", project_root: tmpDir, executionPrerequisite: "on the form" }
    );

    const result = await recordWait("chromium", "Continue", CHROMIUM);

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    // Capitalized, as its own sentence after the divergence sentence's period.
    expect(result.message).toContain(
      "runner. No read-only tool exposes the runner's trimmed tree on Chromium"
    );
    expect(result.message).not.toContain("reads the runner's side");
    expect(result.message).not.toContain("native-find-views");
    expect(parseFlow(await onDisk("chromium")).steps).toHaveLength(1);
  }, 20_000);

  // A `condition: "text"` wait carries an expectedText (and optional textMatch)
  // that the probe must forward into the runner-tree evaluation. If they were
  // dropped, the probe would score `text` as false unconditionally and warn on
  // every text wait that actually agrees; if expectedText were ignored, a wrong
  // value would never warn. These two pin both directions.
  it("forwards expectedText on a `text` wait: no warning when the value matches", async () => {
    runnerTree = () => screen(["Total: $5.00"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "textok", project_root: tmpDir, executionPrerequisite: "on the form" }
    );
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());

    const result = await tool.execute(
      {},
      {
        name: "textok",
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({
          udid: DEVICE,
          condition: "text",
          selector: { text: "Total" },
          expectedText: "$5.00",
        }),
      }
    );

    expect(result.message).toContain("Step added");
    expect(result.message).not.toContain("does NOT hold");
    expect(parseFlow(await onDisk("textok")).steps).toHaveLength(1);
  });

  it("evaluates expectedText on a `text` wait: warns when the value is absent", async () => {
    runnerTree = () => screen(["Total: $3.00"]);
    await flowStartRecordingTool.execute(
      {},
      { name: "textbad", project_root: tmpDir, executionPrerequisite: "on the form" }
    );
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());

    const result = await tool.execute(
      {},
      {
        name: "textbad",
        project_root: tmpDir,
        command: "await-ui-element",
        args: JSON.stringify({
          udid: DEVICE,
          condition: "text",
          selector: { text: "Total" },
          expectedText: "$5.00",
        }),
      }
    );

    expect(result.message).toContain("does NOT hold against the tree the runner resolves");
    expect(parseFlow(await onDisk("textbad")).steps).toHaveLength(1);
  }, 20_000);

  it("throws AbortError when the run is cancelled during the re-probe", async () => {
    // The live await-ui-element still "passes" (the mock ignores the signal), so
    // the abort lands in the re-probe — strictly after the recorded tool ran.
    // The probe must surface that as an abort and record nothing.
    await flowStartRecordingTool.execute(
      {},
      { name: "cancel", project_root: tmpDir, executionPrerequisite: "on the form" }
    );
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute(
        {},
        {
          name: "cancel",
          project_root: tmpDir,
          command: "await-ui-element",
          args: JSON.stringify({
            udid: DEVICE,
            condition: "visible",
            selector: { text: "Continue" },
          }),
        },
        { signal: controller.signal } as never
      )
    ).rejects.toThrow(/aborted while re-probing/);

    // The abort fired before the append, so the flow still has no steps.
    expect(parseFlow(await onDisk("cancel")).steps).toHaveLength(0);
  });
});

// `command` names an MCP tool, but the vocabulary an author has in mind
// while recording is the flow file's own directives, so `command: "echo"`
// used to come back as a bare "Tool not found".
describe("a flow-directive name points at the tool that records it", () => {
  beforeEach(async () => {
    await flowStartRecordingTool.execute(
      {},
      { name: "hints", project_root: tmpDir, executionPrerequisite: "anywhere" }
    );
  });

  const hint = async (command: string) => {
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    return tool.execute({}, { name: "hints", project_root: tmpDir, command });
  };

  it("names flow-add-echo for `echo`", async () => {
    const result = await hint("echo");
    expect(result.message).toContain("flow-add-echo");
    expect(result.message).toContain("no step was recorded");
  });

  it("explains that `wait` has no recording tool at all", async () => {
    const result = await hint("wait");
    expect(result.message).toContain("a fixed sleep is not a readiness signal");
    expect(result.message).toContain("await-ui-element");
  });

  it("names restart-app for `launch`", async () => {
    expect((await hint("launch")).message).toContain("restart-app");
  });

  // Following the old `echo` hint appended TWO steps — flow-add-echo wrote its
  // own directive, and flow-add-step additionally recorded a raw
  // `tool: flow-add-echo` step that errors on every replay, because no
  // recording is open then. It reported success either way.
  it("refuses a recorder tool as `command` instead of nesting it", async () => {
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    for (const command of [
      "flow-add-echo",
      "flow-add-step",
      "flow-start-recording",
      "flow-finish-recording",
    ]) {
      const result = await tool.execute(
        {},
        { name: "hints", project_root: tmpDir, command, args: "{}" }
      );
      expect(result.message, command).toContain("no step was recorded");
      expect(result.stepCount, command).toBe(0);
    }
    expect(parseFlow(await onDisk("hints")).steps).toEqual([]);
  });

  it("refuses a recorder tool BEFORE parsing `args`, so malformed `args` cannot pre-empt the guidance", async () => {
    // The guard runs ahead of `JSON.parse(params.args)` on purpose: a nested
    // recorder tool must be refused even when `args` is malformed, or a bare
    // SyntaxError would replace the guidance the author needs. A regression that
    // moved the guard after the parse would throw here instead of returning the
    // refusal — and no other test would catch it (they all pass valid `args`).
    const tool = createFlowAddStepTool(registryWhereWaitSucceeds());
    const result = await tool.execute(
      {},
      { name: "hints", project_root: tmpDir, command: "flow-add-echo", args: "{not valid json" }
    );
    expect(result.message).toContain("must be called DIRECTLY");
    expect(result.message).toContain("no step was recorded");
    expect(result.stepCount).toBe(0);
    expect(parseFlow(await onDisk("hints")).steps).toEqual([]);
  });

  it("tells the author to call flow-add-echo directly, not through the recorder", async () => {
    const result = await hint("echo");
    expect(result.message).toContain("DIRECTLY");
    expect(result.message).toContain("fails on every replay");
  });

  it("does not claim a rewrite for the commands the recorder stores raw", async () => {
    // `type`/`await`/`assert` are recorded as `tool:` steps; polish converts
    // them. Promising a rewrite sends the author looking for a directive that
    // is not in the file.
    for (const command of ["type", "await", "assert"]) {
      const result = await hint(command);
      expect(result.message, command).toContain("stored as a raw");
      expect(result.message, command).toContain("polish pass");
    }
    // …while the four that ARE rewritten still say so.
    expect((await hint("launch")).message).toContain("rewrites it into the `launch:` step");
  });

  it("qualifies a rewrite hint with the delayMs opt-out", async () => {
    // `tap`/`launch`/`run` are rewritten only when the flow-add-step call sets no
    // `delayMs` (a replay delay has no directive form, so the step is kept raw).
    // The hint has to say so, or an author who adds delayMs is promised a `tap:`
    // step the recorder then declines to write.
    const tap = (await hint("tap")).message;
    expect(tap).toContain("rewrites it into the `tap:` step");
    expect(tap).toContain("delayMs");
    expect(tap).toContain("raw `tool: gesture-tap`");
  });

  it("names flow-execute for `run`, with the sibling-flow rewrite condition", async () => {
    // `run` is rewritten into a `run:` step only when its target resolves as a
    // sibling flow; the hint must state that condition (and the delayMs opt-out),
    // or the author is promised a `run:` step the recorder may decline to write.
    const msg = (await hint("run")).message;
    expect(msg).toContain("flow-execute");
    expect(msg).toContain("rewrites it into the `run:` step");
    expect(msg).toContain("sibling flow");
    expect(msg).toContain("delayMs");
  });

  it("lets a genuine tool failure report itself", async () => {
    // "screenshot" is not a directive name, so a not-found for it must surface
    // as the registry's own error rather than being rewritten.
    await expect(hint("screenshot")).rejects.toThrow(/not found/i);
  });

  it("does not rewrite a REGISTERED tool's own 'not found' failure into a directive hint", async () => {
    // The identity check in `isToolNotFound`: a tool that RAN and failed with a
    // message containing "not found" (e.g. "element not found") is a
    // ToolExecutionError, not a ToolNotFoundError — so even a command sharing a
    // directive name (`tap`) surfaces its own error rather than the gesture-tap
    // hint. A message-substring check would have masked it.
    const registryWhereTapRanAndFailed = {
      invokeTool: vi.fn(async () => {
        throw new ToolExecutionError("tap", "element not found");
      }),
      getTool: vi.fn(() => undefined),
    } as unknown as Registry;
    const tool = createFlowAddStepTool(registryWhereTapRanAndFailed);
    await expect(
      tool.execute({}, { name: "hints", project_root: tmpDir, command: "tap", args: "{}" })
    ).rejects.toThrow(/element not found/);
  });

  it("treats a prototype-member command name as a plain not-found, not a table hit", async () => {
    // `command` is caller-controlled. A value equal to an inherited member
    // (`__proto__`, `constructor`, …) must not read truthy off the directive
    // tables' prototype and refuse the call with a garbage message — it falls
    // through to the ordinary not-found, and records nothing.
    for (const command of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      await expect(hint(command), command).rejects.toThrow(/not found/i);
    }
    expect(parseFlow(await onDisk("hints")).steps).toEqual([]);
  });
});

// flow-execute now accepts `flow_name` as an alias for `name`. A nested
// flow-execute recorded via that alias must still be captured as the portable
// `run: <name>` directive — not kept as a raw, non-portable `tool: flow-execute`
// step with a false "had no flow name" warning.
describe("a recorded flow-execute honors the flow_name alias", () => {
  // A registry whose only registered tool is flow-execute, which succeeds — so
  // the recorder reaches `captureRunTarget` (which runs only after the sub-tool
  // returns).
  const registryWhereRunSucceeds = (): Registry =>
    ({
      invokeTool: vi.fn(async (id: string) => {
        if (id === "flow-execute") return { ok: true };
        throw new ToolNotFoundError(id);
      }),
      getTool: vi.fn(() => undefined),
    }) as unknown as Registry;

  const recordRun = async (execArgs: Record<string, unknown>) => {
    const tool = createFlowAddStepTool(registryWhereRunSucceeds());
    return tool.execute(
      {},
      {
        name: "wrapper",
        project_root: tmpDir,
        command: "flow-execute",
        args: JSON.stringify(execArgs),
      }
    );
  };

  beforeEach(async () => {
    // `run:` capture resolves the target against the recording's own flows dir,
    // so the sibling must exist and parse.
    const dir = path.join(tmpDir, ".argent", "flows");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "helper.yaml"), "steps:\n  - echo: hi\n");
    await flowStartRecordingTool.execute({}, { name: "wrapper", project_root: tmpDir });
  });

  it("captures `run: <name>` when the nested call named the flow via flow_name", async () => {
    const result = await recordRun({ flow_name: "helper", project_root: tmpDir, device: DEVICE });
    expect(result.message).not.toContain("had no flow name");
    const steps = parseFlow(await onDisk("wrapper")).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ kind: "run", flow: "helper" });
  });

  it("still captures `run: <name>` for the canonical `name` (no regression)", async () => {
    await recordRun({ name: "helper", project_root: tmpDir, device: DEVICE });
    const steps = parseFlow(await onDisk("wrapper")).steps;
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ kind: "run", flow: "helper" });
  });
});
