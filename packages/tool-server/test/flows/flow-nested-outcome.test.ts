import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Registry } from "@argent/registry";
import { createRunFlowTool, type FlowRunResult } from "../../src/tools/flows/flow-run";
import { nestedOrchestratorOutcome } from "../../src/tools/flows/flow-nested-outcome";

/**
 * Issue #606: a step that runs a nested orchestrator reported `pass` whatever
 * the nested run actually did. The generic `tool` step treats any non-throwing
 * result as a pass, and both `flow-execute` and `run-sequence` report failure in
 * their result rather than by throwing.
 *
 * Measured before the fix: the same flow reported `ok=false, failed=1` when run
 * directly and `ok=true, passed=1` when nested — with the failing sub-report
 * sitting inside the result object being called a pass.
 */

const PROJECT_ROOT = path.join(os.tmpdir(), `flow-nested-tests-${process.pid}`);

function makeRegistry(invoke: (id: string, args: unknown) => Promise<unknown>) {
  return {
    invokeTool: vi.fn(invoke),
    getTool: vi.fn(() => undefined),
  } as unknown as Registry;
}

async function writeFlow(yaml: string): Promise<string> {
  const flowsDir = path.join(PROJECT_ROOT, ".argent", "flows");
  const file = path.join(flowsDir, "outer.yaml");
  await fs.mkdir(flowsDir, { recursive: true });
  await fs.writeFile(file, yaml, "utf8");
  return file;
}

afterEach(async () => {
  await fs.rm(PROJECT_ROOT, { recursive: true, force: true });
});

function asRun(r: FlowRunResult | { notice: string }): FlowRunResult {
  if (!("steps" in r)) throw new Error(`expected a FlowRunResult, got a notice: ${r.notice}`);
  return r;
}

/** A nested orchestrator step, followed by a step that must not run if it fails. */
const OUTER = (tool: string) => `executionPrerequisite: ""
steps:
  - tool: ${tool}
    args:
      name: sub
  - tool: gesture-tap
    args:
      udid: X
      x: 0.5
      y: 0.5
`;

async function run(tool: string, nestedResult: unknown) {
  const flowFile = await writeFlow(OUTER(tool));
  const registry = makeRegistry(async (id) => (id === tool ? nestedResult : { ok: true }));
  const result = asRun(
    await createRunFlowTool(registry).execute(
      {},
      { name: "outer", project_root: PROJECT_ROOT, flow_file: flowFile, device: "DEV" }
    )
  );
  return { result, registry };
}

/** A sub-flow that ran and failed. */
const FAILED_SUBFLOW = {
  flow: "sub",
  device: "DEV",
  executionPrerequisite: "",
  ok: false,
  passed: 0,
  failed: 1,
  skipped: 0,
  errored: 0,
  steps: [
    {
      index: 0,
      kind: "await",
      status: "fail",
      tool: "await-ui-element",
      reason: "no element matched the selector before timeout",
    },
  ],
};

/** An inner assert that read the element and found other text. */
const TEXT_MISMATCH_STEP = {
  index: 0,
  kind: "assert",
  status: "fail",
  reason: 'element matched id="total" but its text did not equal "$42.00"',
  expected: "$42.00",
  actual: "Total $41.50",
  hint: 'the element\'s own text is "Total"; the check accepts the subtree text or the own text',
};

/** An inner cropOn snapshot whose element changed size: the one snapshot failure with a hint. */
const SNAPSHOT_SIZE_STEP = {
  index: 0,
  kind: "snapshot",
  status: "fail",
  reason:
    "baseline is 50x60 but the cropOn region is 50x50 (cv__chromium-1280x713-crop-1a2b3c4d.png)",
  expected: "50x60",
  actual: "50x50",
  hint: "the element's size drifted; crop a fixed-size container, or re-adopt with updateBaselines",
};

describe("a nested flow-execute reports its own verdict", () => {
  it("fails the step when the composed flow failed", async () => {
    const { result, registry } = await run("flow-execute", FAILED_SUBFLOW);

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/flow "sub" failed/);
    expect(result.steps[0].reason).toMatch(/1 failed/);
    // The sub-flow's own reason is surfaced, so the CLI — which renders only
    // `reason` — says what actually went wrong rather than just "it failed".
    expect(result.steps[0].reason).toMatch(/no element matched/);
    // The whole sub-report still rides along for clients that render results.
    expect(result.steps[0].result).toEqual(FAILED_SUBFLOW);

    // …and the run hard-stops, exactly as an inline `run:` composition would.
    expect(result.steps[1].status).toBe("skip");
    expect(registry.invokeTool).not.toHaveBeenCalledWith("gesture-tap", expect.anything());
    expect(result.ok).toBe(false);
    expect(result.failed).toBe(1);
  });

  it("errors the step when the composed flow ran nothing at all", async () => {
    // An unmet executionPrerequisite returns a notice and zero steps. Nothing
    // was asserted, so this is not a failure of the app — it is a step that was
    // never runnable as written.
    const { result } = await run("flow-execute", {
      flow: "sub",
      notice: "This flow has an execution prerequisite that must be fulfilled before it can run.",
      executionPrerequisite: "Settings is open on the root page",
    });

    expect(result.steps[0].status).toBe("error");
    expect(result.steps[0].reason).toMatch(/did not run/);
    expect(result.steps[0].reason).toMatch(/Settings is open on the root page/);
    // The remedy has to be in the reason: it is all the CLI shows.
    expect(result.steps[0].reason).toMatch(/prerequisiteAcknowledged/);
    expect(result.errored).toBe(1);
    expect(result.ok).toBe(false);
  });

  it("carries the failed inner step's expected, actual and hint", async () => {
    // A failed check keeps the found text and the advice BESIDE its reason, so
    // a step built from the inner reason alone says "did not equal" with no
    // found text. Nothing else in a composed run prints the inner step.
    const { result } = await run("flow-execute", {
      ...FAILED_SUBFLOW,
      steps: [TEXT_MISMATCH_STEP],
    });

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].expected).toBe("$42.00");
    expect(result.steps[0].actual).toBe("Total $41.50");
    expect(result.steps[0].hint).toBe(TEXT_MISMATCH_STEP.hint);
    // A check that read the screen is a verdict on the app.
    expect(result.steps[0].indeterminate).toBeUndefined();
  });

  it("carries the indeterminate flag and hint of an inner step that could not read the tree", async () => {
    const hint =
      "check the app first, then the device and the tree source; re-run before you edit the flow";
    const { result } = await run("flow-execute", {
      ...FAILED_SUBFLOW,
      steps: [
        {
          index: 0,
          kind: "assert",
          status: "fail",
          reason: "could not read the UI tree: native devtools disconnected",
          indeterminate: true,
          hint,
        },
      ],
    });

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toContain("could not read the UI tree");
    expect(result.steps[0].indeterminate).toBe(true);
    // The inner step's own hint, not a generic one put in its place.
    expect(result.steps[0].hint).toBe(hint);
    // Nothing was read, so there is no found text to carry.
    expect(result.steps[0].expected).toBeUndefined();
    expect(result.steps[0].actual).toBeUndefined();
  });

  it("carries the detail fields through a flow-execute nested in a flow-execute", async () => {
    // The middle report is a real run of its own: its failed step is the
    // `tool: flow-execute` step that ran the innermost flow.
    const { result: middle } = await run("flow-execute", {
      ...FAILED_SUBFLOW,
      steps: [TEXT_MISMATCH_STEP],
    });
    expect(middle.steps[0]).toMatchObject({ kind: "tool", tool: "flow-execute" });

    const { result } = await run("flow-execute", middle);

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toContain('(flow-execute: flow "sub" failed');
    expect(result.steps[0].reason).toContain("did not equal");
    expect(result.steps[0].expected).toBe("$42.00");
    expect(result.steps[0].actual).toBe("Total $41.50");
    expect(result.steps[0].hint).toBe(TEXT_MISMATCH_STEP.hint);
    expect(result.steps[0].indeterminate).toBeUndefined();
  });

  it("keeps a snapshot's values out of expected and actual two levels up", async () => {
    // The middle level already drops them; the outer level copies the middle
    // `tool` step as it is, so they stay dropped and the hint still arrives.
    const { result: middle } = await run("flow-execute", {
      ...FAILED_SUBFLOW,
      steps: [SNAPSHOT_SIZE_STEP],
    });

    const { result } = await run("flow-execute", middle);

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toContain("(snapshot: baseline is 50x60 but the cropOn region");
    expect(result.steps[0].expected).toBeUndefined();
    expect(result.steps[0].actual).toBeUndefined();
    expect(result.steps[0].hint).toBe(SNAPSHOT_SIZE_STEP.hint);
  });

  it("carries the pattern marker so the outer step prints the pattern as one", async () => {
    const { result } = await run("flow-execute", {
      ...FAILED_SUBFLOW,
      steps: [
        {
          index: 0,
          kind: "assert",
          status: "fail",
          reason: 'element matched id="count" but its text did not match /^Taps: \\d$/',
          expected: "^Taps: \\d$",
          expectedKind: "pattern",
          actual: "Taps: 42",
        },
      ],
    });

    expect(result.steps[0].expected).toBe("^Taps: \\d$");
    expect(result.steps[0].expectedKind).toBe("pattern");
    // A value the inner step did not mark stays unmarked.
    expect(result.steps[0].actual).toBe("Taps: 42");
  });

  it("keeps an inner snapshot's values in the label, not in quoted expected and actual", async () => {
    // A snapshot's values print unquoted only on a `snapshot` step. On the outer
    // `tool` step they would print as quoted device text, "50x60".
    const { result } = await run("flow-execute", {
      ...FAILED_SUBFLOW,
      steps: [SNAPSHOT_SIZE_STEP],
    });

    expect(result.steps[0].reason).toContain("(snapshot: baseline is 50x60 but the cropOn region");
    expect(result.steps[0].expected).toBeUndefined();
    expect(result.steps[0].actual).toBeUndefined();
    expect(result.steps[0].hint).toBe(SNAPSHOT_SIZE_STEP.hint);
  });

  it("carries no detail fields when the failed inner step has none", async () => {
    const { result } = await run("flow-execute", FAILED_SUBFLOW);

    expect(result.steps[0].expected).toBeUndefined();
    expect(result.steps[0].actual).toBeUndefined();
    expect(result.steps[0].hint).toBeUndefined();
    expect(result.steps[0].indeterminate).toBeUndefined();
  });

  it("treats a cancelled nested run as a skip, not a failure", async () => {
    const { result } = await run("flow-execute", { ...FAILED_SUBFLOW, aborted: true });

    expect(result.steps[0].status).toBe("skip");
    expect(result.steps[0].reason).toMatch(/aborted/);
    expect(result.failed).toBe(0);
  });

  it("still passes a composed flow that succeeded", async () => {
    const passing = { ...FAILED_SUBFLOW, ok: true, passed: 1, failed: 0, steps: [] };
    const { result, registry } = await run("flow-execute", passing);

    expect(result.steps[0].status).toBe("pass");
    expect(result.steps[0].result).toEqual(passing);
    expect(result.steps[1].status).toBe("pass");
    expect(registry.invokeTool).toHaveBeenCalledWith("gesture-tap", expect.anything());
    expect(result.ok).toBe(true);
  });
});

describe("a nested run-sequence reports its own verdict", () => {
  // run-sequence has no verdict field at all: every failure path pushes an
  // `error` entry, breaks the loop and returns normally, so a sequence that
  // stopped on its first step looked like an ordinary result.
  it("fails the step when a step in the sequence failed", async () => {
    const { result } = await run("run-sequence", {
      completed: 1,
      total: 3,
      steps: [
        { tool: "gesture-tap", result: { tapped: true } },
        { tool: "keyboard", error: "keyboard failed: device not found" },
      ],
    });

    expect(result.steps[0].status).toBe("fail");
    expect(result.steps[0].reason).toMatch(/run-sequence stopped at keyboard/);
    expect(result.steps[0].reason).toMatch(/1 of 3/);
    expect(result.steps[0].reason).toMatch(/device not found/);
    expect(result.steps[1].status).toBe("skip");
    expect(result.ok).toBe(false);
  });

  it("skips when the sequence was cut short by cancellation", async () => {
    // No error entry, but fewer step results than steps requested — the only
    // other way run-sequence leaves its loop.
    const { result } = await run("run-sequence", {
      completed: 1,
      total: 4,
      steps: [{ tool: "gesture-tap", result: { tapped: true } }],
    });

    expect(result.steps[0].status).toBe("skip");
    expect(result.steps[0].reason).toMatch(/aborted/);
    expect(result.failed).toBe(0);
  });

  it("still passes a sequence that ran every step", async () => {
    const { result } = await run("run-sequence", {
      completed: 2,
      total: 2,
      steps: [
        { tool: "gesture-tap", result: { tapped: true } },
        { tool: "keyboard", result: { typed: true } },
      ],
    });

    expect(result.steps[0].status).toBe("pass");
    expect(result.ok).toBe(true);
  });
});

describe("the check is deliberately scoped to the two orchestrator tools", () => {
  // There is no `ok` contract in this codebase to generalise: await-ui-element
  // spells it `success`, run-sequence spells it neither way, and the generic
  // `tool` step dispatches tools whose results are typed `unknown` — some
  // carrying app-derived payloads. A blanket "ok: false fails the step" rule
  // would bind all of those, and everything added later, to a key name.
  it("leaves an ordinary tool's `ok` field alone", async () => {
    const { result } = await run("gesture-tap", { ok: false });
    expect(result.steps[0].status).toBe("pass");
  });

  it("ignores a result shape it does not recognise", async () => {
    for (const shape of [null, "text", 42, {}, { steps: [] }, { ok: "no" }]) {
      expect(nestedOrchestratorOutcome("flow-execute", shape)).toBeUndefined();
    }
  });

  it("never throws on a malformed nested report", () => {
    expect(() =>
      nestedOrchestratorOutcome("flow-execute", { ok: false, steps: [null, 7, { status: "fail" }] })
    ).not.toThrow();
    expect(() => nestedOrchestratorOutcome("run-sequence", { steps: "nope" })).not.toThrow();
  });

  it("says which step failed even when the sub-report is partly malformed", () => {
    const out = nestedOrchestratorOutcome("flow-execute", {
      ok: false,
      steps: [null, { status: "fail", kind: "assert" }],
    });
    expect(out?.status).toBe("fail");
    // No tool and no reason on that entry — it still names the kind rather than
    // rendering "undefined".
    expect(out?.reason).toMatch(/assert: no reason given/);
  });
});
