/**
 * End-to-end regression for the retired `settle` key on the production dispatch
 * path.
 *
 * gesture-swipe and gesture-drag declare-and-refuse `settle` (renamed to
 * `momentum` with the opposite sense) via a `z.never()` field, and the refusal
 * is enforced by `registry.invokeTool`'s schema validation. The schema-level
 * tests in test/tools pin the declaration by calling `safeParse` directly, but
 * every flow test runs against the mock registry in ./harness.ts, whose
 * `invokeTool` validates nothing - so a raw `tool:` step carrying `settle`
 * would sail through that suite green even if the validation in
 * `Registry.invokeTool` were removed or the `settle` declaration dropped.
 *
 * This file drives a REAL `Registry` with the REAL tool definitions, so what it
 * pins is the refusal actually reaching a flow-run caller:
 *
 *   - a recorded step carrying `settle: true` errors, and the step reason
 *     teaches the new spelling (`momentum`) and the flipped sense
 *     (`momentum: false`);
 *   - the same step with `momentum: false` instead passes validation - it then
 *     fails at service resolution (this bare registry has no blueprints, which
 *     is deterministic and never touches a device backend), proving the control
 *     got past the schema.
 *
 * Each case gets its own temp project root, passed explicitly to `flow-execute`,
 * so nothing is shared between them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Registry } from "@argent/registry";

import { createRunFlowTool } from "../../src/tools/flows/flow-run";
import { serializeFlow } from "../../src/tools/flows/flow-utils";
import { gestureSwipeTool } from "../../src/tools/gesture-swipe";
import { gestureDragTool } from "../../src/tools/gesture-drag";

// Ids only need the right SHAPE: flow-run resolves an explicit `device` purely
// by shape, and the settle steps are refused at validation, before any service
// is resolved - no simulator / CDP backend is ever contacted.
const IOS_DEVICE = "00000000-0000-0000-0000-0000000000ab";
const CHROMIUM_DEVICE = "chromium-cdp-19222";

let tmpDir: string;

function buildRegistry(): Registry {
  const registry = new Registry();
  registry.registerTool(gestureSwipeTool);
  registry.registerTool(gestureDragTool);
  return registry;
}

/**
 * Writes a flow whose single step is a raw `tool:` step, shaped like a recorded
 * one: gesture coordinates but no device key - the runner strips any recorded
 * device id and injects the run device's udid via `bindDeviceArgs`.
 */
async function writeFlow(name: string, tool: string, args: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpDir, ".argent", "flows");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.yaml`),
    serializeFlow({
      executionPrerequisite: "",
      steps: [{ kind: "tool", name: tool, args }],
    })
  );
}

type StepReport = { kind: string; status: string; tool?: string; reason?: string };

async function runSingleStepFlow(name: string, device: string): Promise<StepReport> {
  const runFlow = createRunFlowTool(buildRegistry());
  const result = await runFlow.execute({}, { name, project_root: tmpDir, device });
  expect(result).toHaveProperty("steps");
  const steps = (result as { steps: StepReport[] }).steps;
  expect(steps).toHaveLength(1);
  return steps[0]!;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "flow-retired-settle-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("flow-execute refuses the retired `settle` key through the real registry", () => {
  it("gesture-swipe: a recorded step carrying settle errors with the rename guidance", async () => {
    await writeFlow("swipe-settle", "gesture-swipe", {
      fromX: 0.5,
      fromY: 0.8,
      toX: 0.5,
      toY: 0.2,
      settle: true,
    });

    const step = await runSingleStepFlow("swipe-settle", IOS_DEVICE);

    expect(step).toMatchObject({ kind: "tool", status: "error", tool: "gesture-swipe" });
    // The report is what the flow author reads, so it must teach both the new
    // spelling and the flipped sense.
    expect(step.reason).toContain("gesture-swipe's `settle` was renamed to `momentum`");
    expect(step.reason).toContain("momentum: false");
  });

  it("gesture-drag: a recorded step carrying settle errors with the rename guidance", async () => {
    await writeFlow("drag-settle", "gesture-drag", {
      fromX: 0.3,
      fromY: 0.5,
      toX: 0.7,
      toY: 0.5,
      settle: true,
    });

    const step = await runSingleStepFlow("drag-settle", CHROMIUM_DEVICE);

    expect(step).toMatchObject({ kind: "tool", status: "error", tool: "gesture-drag" });
    expect(step.reason).toContain("gesture-drag's `settle` was renamed to `momentum`");
    expect(step.reason).toContain("momentum: false");
  });

  // Controls: the renamed spelling gets PAST validation. The step still errors
  // - this registry has no blueprints, so `execute` is never reached - but at
  // service resolution, which proves the schema accepted the args: a validation
  // refusal would carry "Invalid params" and never mention a service.
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
});
