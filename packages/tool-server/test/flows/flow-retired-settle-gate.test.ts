/**
 * End-to-end regression for the retired `settle` key on the production dispatch
 * path, where two independent lines refuse it: flow-execute's pre-run pass, and
 * `registry.invokeTool`'s schema validation.
 *
 * Neither existing suite can see them. The schema tests in test/tools call
 * `safeParse` directly, and every other flow test runs against ./harness.ts's
 * mock registry, whose `invokeTool` validates nothing - so a raw `tool:` step
 * carrying `settle` sails through both green even with either line removed. This
 * file drives a REAL `Registry` with the REAL tool definitions instead.
 *
 * Each case gets its own temp project root, passed explicitly to `flow-execute`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FAILURE_CODES, Registry, getFailureSignal } from "@argent/registry";

import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { serializeFlow, type FlowStep } from "../../src/tools/flows/flow-utils";
import { gestureSwipeTool } from "../../src/tools/gesture-swipe";
import { gestureDragTool } from "../../src/tools/gesture-drag";
import { createRunSequenceTool } from "../../src/tools/run-sequence";

// Ids only need the right SHAPE: flow-run resolves an explicit `device` purely
// by shape, and the settle steps are refused at validation, before any service
// is resolved - no simulator / CDP backend is ever contacted.
const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";
const CHROMIUM_DEVICE = "chromium-cdp-19222";

/**
 * The guidance both gestures declare on their retired `settle` field, verbatim.
 * The gate carries this description and never the `z.never` error text, so it is
 * the whole of what a flow author is told, and it has to name what BOTH old
 * values become: `settle: true` became `momentum: false`, while `settle: false`
 * was the default and becomes no key at all.
 */
const RENAME_GUIDANCE =
  "renamed to `momentum` with the opposite sense. Pass `momentum: false` for what `settle: true` meant; `settle: false` was the default, so drop the key.";

let tmpDir: string;

function buildRegistry(): Registry {
  const registry = new Registry();
  registry.registerTool(gestureSwipeTool);
  registry.registerTool(gestureDragTool);
  // The real batching tool, built as setup-registry builds it: it is the
  // recorded shape that carries a gesture's args one level down.
  registry.registerTool(createRunSequenceTool(registry));
  return registry;
}

/** Writes a flow file verbatim from parsed steps. */
async function writeSteps(name: string, steps: FlowStep[]): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({ executionPrerequisite: "", steps })
  );
}

/**
 * Writes a flow whose single step is a raw `tool:` step, shaped like a recorded
 * one: gesture coordinates but no device key - the runner strips any recorded
 * device id and injects the run device's udid via `bindDeviceArgs`.
 */
async function writeFlow(name: string, tool: string, args: Record<string, unknown>): Promise<void> {
  await writeSteps(name, [{ kind: "tool", name: tool, args }]);
}

/** A recorded gesture's args, minus the device key the runner rebinds. */
function swipeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return { fromX: 0.5, fromY: 0.75, toX: 0.5, toY: 0.35, ...args };
}

/** A recorded gesture step carrying those args. */
function swipeStep(args: Record<string, unknown>): FlowStep {
  return { kind: "tool", name: "gesture-swipe", args: swipeArgs(args) };
}

/**
 * A recorded run-sequence batch: each gesture's args sit one level down, in a
 * nested `{ tool, args }` entry, and carry no udid (run-sequence injects it).
 */
function sequenceStep(steps: Array<{ tool: string; args: Record<string, unknown> }>): FlowStep {
  return { kind: "tool", name: "run-sequence", args: { steps } };
}

type StepReport = { kind: string; status: string; tool?: string; reason?: string };

async function runFlowSteps(name: string, device: string): Promise<StepReport[]> {
  const runFlow = createRunFlowTool(buildRegistry());
  const result = await runFlow.execute({}, { name, project_root: tmpDir, device });
  expect(result).toHaveProperty("steps");
  return (result as { steps: StepReport[] }).steps;
}

async function runSingleStepFlow(name: string, device: string): Promise<StepReport> {
  const steps = await runFlowSteps(name, device);
  expect(steps).toHaveLength(1);
  return steps[0]!;
}

/**
 * Runs a flow that must be refused BEFORE it starts, and returns the refusal.
 *
 * A run that resolves at all fails the test whatever its report says: "step 0
 * pass, step 1 error" is exactly the resolved shape this gate exists to
 * prevent, so the reported steps are printed rather than asserted over.
 */
async function refusalOf(name: string, device: string): Promise<unknown> {
  const runFlow = createRunFlowTool(buildRegistry());
  return await runFlow.execute({}, { name, project_root: tmpDir, device }).then(
    (result) => {
      throw new Error(`flow ran instead of being refused: ${JSON.stringify(result)}`);
    },
    (err: unknown) => err
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The outermost position a refusal names: the step the counting qualifier follows. */
function positionIn(message: string): string {
  const named = /step \d+(?= as written)/.exec(message);
  if (!named) throw new Error(`refusal names no step position: ${message}`);
  return named[0];
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-retired-settle-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow-execute refuses the retired `settle` key through the real registry", () => {
  it("gesture-swipe: a recorded step carrying settle is refused at load, with the rename guidance", async () => {
    await writeFlow("swipe-settle", "gesture-swipe", {
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      settle: true,
    });

    const err = await refusalOf("swipe-settle", IOS_DEVICE);

    // The refusal is what the flow author reads, so it must locate the step and
    // carry the rename guidance whole.
    expect(messageOf(err)).toContain('Flow "swipe-settle" step 1');
    expect(messageOf(err)).toContain("gesture-swipe's retired `settle` key");
    expect(messageOf(err)).toContain(RENAME_GUIDANCE);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
  });

  it("gesture-drag: a recorded step carrying settle is refused at load, with the rename guidance", async () => {
    await writeFlow("drag-settle", "gesture-drag", {
      fromX: 0.3,
      fromY: 0.5,
      toX: 0.7,
      toY: 0.5,
      settle: true,
    });

    const err = await refusalOf("drag-settle", CHROMIUM_DEVICE);

    expect(messageOf(err)).toContain("gesture-drag's retired `settle` key");
    expect(messageOf(err)).toContain(RENAME_GUIDANCE);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
  });

  // The reason the gate is pre-run rather than per-step: refused at the step,
  // this flow reports step 1 pass and step 2 error - after the echo has run and,
  // in a real recording, after every preceding step has driven the device.
  it("refuses a settle step that FOLLOWS an echo, so the echo never reports pass", async () => {
    await writeSteps("echo-then-settle", [
      { kind: "echo", message: "runs first" },
      swipeStep({ settle: true }),
    ]);

    const err = await refusalOf("echo-then-settle", IOS_DEVICE);

    expect(messageOf(err)).toContain("step 2");
    expect(messageOf(err)).toContain("gesture-swipe's retired `settle` key");
    expect(messageOf(err)).toContain("momentum: false");
  });

  // The numbering itself: the position is the step's place in the FILE as
  // written, so an echo ahead of it DOES shift the number. Deliberate, since a
  // flow refused before the run starts has no report line to point at and the
  // renderers do not agree on a numbering anyway. The message therefore carries
  // the counting rule, which is what makes a bare "step 2" readable.
  it("names the step's authored position, echo counted, and says which counting that is", async () => {
    await writeSteps("gate-echo", [
      { kind: "echo", message: "runs first" },
      swipeStep({ settle: true }),
    ]);
    await writeSteps("gate-no-echo", [swipeStep({ settle: true })]);

    const withEcho = messageOf(await refusalOf("gate-echo", IOS_DEVICE));
    const withoutEcho = messageOf(await refusalOf("gate-no-echo", IOS_DEVICE));

    expect(positionIn(withEcho)).toBe("step 2");
    expect(positionIn(withoutEcho)).toBe("step 1");
    // Stated once per message, whatever the nesting, and adjacent to the number
    // it qualifies.
    expect(withEcho).toContain("step 2 as written (echo included) passes");
    expect(withEcho.match(/as written/g)).toHaveLength(1);
  });

  // `when:` bodies are walked because their steps are already parsed and in
  // hand, and a guarded step drives the device exactly as late as any other.
  it("refuses a settle step inside a when: block, naming where it sits", async () => {
    await writeSteps("when-settle", [
      { kind: "echo", message: "runs first" },
      {
        kind: "when",
        condition: { kind: "platform", platform: "ios" },
        steps: [swipeStep({ settle: true })],
      },
    ]);

    const err = await refusalOf("when-settle", IOS_DEVICE);

    // Both levels in one name, qualified once, at the end where it covers both.
    expect(messageOf(err)).toContain(
      "step 1 of the when: block at step 2 as written (echo included)"
    );
    expect(messageOf(err)).toContain("gesture-swipe's retired `settle` key");
  });

  // The batched recording (`run-sequence` is how the skills document a swipe
  // batch): the key rides one level down, in a nested step's args, and reaches
  // gesture-swipe's schema exactly as a `tool:` step's own args do. Refused
  // before the run, so the echo ahead of it never reports pass either.
  it("refuses a settle key nested in a run-sequence batch, naming the nested step and tool", async () => {
    await writeSteps("sequence-settle", [
      { kind: "echo", message: "runs first" },
      sequenceStep([{ tool: "gesture-swipe", args: swipeArgs({ settle: true }) }]),
    ]);

    const err = await refusalOf("sequence-settle", IOS_DEVICE);

    expect(messageOf(err)).toContain("step 1 of the run-sequence step at step 2");
    expect(messageOf(err)).toContain("gesture-swipe's retired `settle` key");
    expect(messageOf(err)).toContain(RENAME_GUIDANCE);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
  });

  // The position named is the offending nested step's own, not the batch's
  // first - here a live gesture precedes it, and would have driven the device
  // before a run-time refusal could land.
  it("gesture-drag: refuses a settle key in a later nested step, naming that position", async () => {
    const drag = (args: Record<string, unknown>) => ({
      tool: "gesture-drag",
      args: { fromX: 0.3, fromY: 0.5, toX: 0.7, toY: 0.5, ...args },
    });
    await writeSteps("sequence-drag-settle", [
      sequenceStep([drag({ momentum: false }), drag({ settle: true })]),
    ]);

    const err = await refusalOf("sequence-drag-settle", CHROMIUM_DEVICE);

    expect(messageOf(err)).toContain("step 2 of the run-sequence step at step 1");
    expect(messageOf(err)).toContain("gesture-drag's retired `settle` key");
    expect(messageOf(err)).toContain("momentum: false");
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.FLOW_FILE_INVALID);
  });

  // A `run:` target is NOT read by the pre-run pass (it is resolved at run
  // time), so the fragment is gated the moment it loads: the composition point
  // errors and not one of the fragment's own steps runs.
  it("refuses a fragment carrying settle at the composition point", async () => {
    await writeSteps("settle-fragment", [swipeStep({ settle: true })]);
    await writeSteps("composed", [{ kind: "run", flow: "settle-fragment.yaml" }]);

    const steps = await runFlowSteps("composed", IOS_DEVICE);

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "run", status: "error" });
    expect(steps[0]!.reason).toContain('fragment "settle-fragment.yaml" step 1');
    expect(steps[0]!.reason).toContain("gesture-swipe's retired `settle` key");
    expect(steps[0]!.reason).toContain("momentum: false");
  });

  // The gate never guesses at a tool it cannot look up: an unknown tool's step
  // fails on its own, with a message about the tool rather than about a key.
  it("leaves an unknown tool's step to its own failure", async () => {
    await writeFlow("unknown-tool-settle", "not-a-real-tool", { settle: true });

    const step = await runSingleStepFlow("unknown-tool-settle", IOS_DEVICE);

    expect(step).toMatchObject({ kind: "tool", status: "error" });
    expect(step.reason).not.toContain("retired");
  });

  // Controls: the renamed spelling gets PAST the gate and validation. The step
  // still errors, but at service resolution - this registry has no blueprints -
  // which is what proves both lines were cleared.
  it("control: gesture-swipe with momentum: false passes validation and fails only at service resolution", async () => {
    await writeFlow("swipe-momentum", "gesture-swipe", {
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      momentum: false,
    });

    const step = await runSingleStepFlow("swipe-momentum", IOS_DEVICE);

    expect(step).toMatchObject({ kind: "tool", status: "error", tool: "gesture-swipe" });
    expect(step.reason).toContain("Service dependency failed");
    expect(step.reason).not.toContain("Invalid params");
    expect(step.reason).not.toContain("settle");
  });

  it("control: gesture-drag with momentum: false passes validation and fails only at service resolution", async () => {
    await writeFlow("drag-momentum", "gesture-drag", {
      fromX: 0.3,
      fromY: 0.5,
      toX: 0.7,
      toY: 0.5,
      momentum: false,
    });

    const step = await runSingleStepFlow("drag-momentum", CHROMIUM_DEVICE);

    expect(step).toMatchObject({ kind: "tool", status: "error", tool: "gesture-drag" });
    expect(step.reason).toContain("Service dependency failed");
    expect(step.reason).not.toContain("Invalid params");
    expect(step.reason).not.toContain("settle");
  });

  // The nested pass must refuse a retired key and nothing else: a batch of live
  // args runs, and reaches the same service resolution the direct controls do
  // (through run-sequence, which reports a stopped sub-step as a failing step).
  it("control: a run-sequence batch whose nested args are all live keys is not refused", async () => {
    await writeSteps("sequence-momentum", [
      sequenceStep([{ tool: "gesture-swipe", args: swipeArgs({ momentum: false }) }]),
    ]);

    const step = await runSingleStepFlow("sequence-momentum", IOS_DEVICE);

    expect(step).toMatchObject({ kind: "tool", tool: "run-sequence" });
    expect(step.reason).toContain("Service dependency failed");
    expect(step.reason).not.toContain("Invalid params");
    expect(step.reason).not.toContain("settle");
  });

  // The nested pass reads only args the carrying tool DECLARES. A non-batching
  // tool's schema strips an unknown field before execute, so a stray value that
  // merely looks like `{ tool, args }` never becomes an invocation.
  it("control: an arg the tool does not declare is not read as a nested invocation", async () => {
    await writeSteps("swipe-junk", [
      swipeStep({ junk: { tool: "gesture-drag", args: { settle: true } } }),
    ]);

    const step = await runSingleStepFlow("swipe-junk", IOS_DEVICE);

    expect(step).toMatchObject({ kind: "tool", status: "error", tool: "gesture-swipe" });
    expect(step.reason).toContain("Service dependency failed");
    expect(step.reason).not.toContain("retired");
    expect(step.reason).not.toContain("gesture-drag");
  });

  // The second line, pinned directly: every dispatch path that is not a flow
  // step (HTTP, run-sequence, a sub-invoke) still meets the declaration's own
  // refusal, so the flow gate is an earlier catch and not the only one.
  it("registry.invokeTool still refuses settle on its own", async () => {
    await expect(
      buildRegistry().invokeTool("gesture-swipe", {
        udid: IOS_DEVICE,
        fromX: 0.5,
        fromY: 0.8,
        toX: 0.5,
        toY: 0.2,
        settle: true,
      })
    ).rejects.toThrow(/gesture-swipe's `settle` was renamed to `momentum`/);
  });
});

// The description is the only retirement text the CLI's parse refusal and usage
// notice can render - the property serializes to `{description, not: {}}`, so the
// `z.never` error text is not in the schema they read. `@argent/cli` cannot
// depend on the tool-server, so the string is hand-copied into
// packages/argent-cli/test/flag-parser.test.ts and run-flag-parse-failure.test.ts:
// if this fails, update both fixtures in the same change.
describe("the retired `settle` guidance the CLI tests hand-copy", () => {
  it.each([["gesture-swipe"], ["gesture-drag"]])(
    "%s publishes it whole, behind the `Retired: ` label every caller strips",
    (tool) => {
      const schema = buildRegistry().getTool(tool)!.inputSchema as {
        properties: Record<string, unknown>;
      };

      expect(schema.properties["settle"]).toEqual({
        description: `Retired: ${RENAME_GUIDANCE}`,
        not: {},
      });
    }
  );
});
