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

  it("treats a cancelled nested run as a skip, not a failure", async () => {
    const { result } = await run("flow-execute", { ...FAILED_SUBFLOW, aborted: true });

    expect(result.steps[0].status).toBe("skip");
    expect(result.steps[0].reason).toMatch(/aborted/);
    expect(result.failed).toBe(0);
  });

  it("still names the failing step when the run was cancelled after it failed", async () => {
    // `summarize` folds the abort into the verdict. A step that failed and was
    // then cancelled takes the abort branch, not the `ok: false` one that
    // renders the detail. `reason` is the only string the recorder's refusal
    // can render, so a loss here is a loss everywhere.
    const { result } = await run("flow-execute", { ...FAILED_SUBFLOW, aborted: true });

    expect(result.steps[0].status).toBe("skip");
    expect(result.steps[0].reason).toBe(
      'flow "sub" was aborted (await-ui-element: no element matched the selector before timeout)'
    );
  });

  it("says only that it was aborted when no composed step failed", async () => {
    // The other side of the same branch: a cancel that reached no failure has
    // nothing to name, and must not grow an empty parenthesis.
    const { result } = await run("flow-execute", {
      ...FAILED_SUBFLOW,
      aborted: true,
      failed: 0,
      skipped: 1,
      steps: [{ index: 0, kind: "tap", status: "skip", reason: "run aborted" }],
    });

    expect(result.steps[0].status).toBe("skip");
    expect(result.steps[0].reason).toBe('flow "sub" was aborted');
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

  it("flags a nested failure whose error message is empty", () => {
    // A tool that throws `new Error("")` records `error: ""`. A check on a
    // non-empty message would skip that entry and score the failed sequence as
    // a pass. The empty message is named, so the reason does not trail off at
    // the colon.
    const out = nestedOrchestratorOutcome("run-sequence", {
      completed: 0,
      total: 1,
      steps: [{ tool: "keyboard", error: "" }],
    });

    expect(out?.status).toBe("fail");
    expect(out?.reason).toBe(
      "run-sequence stopped at keyboard after 0 of 1 steps: failed without an error message"
    );
  });

  it("reports the FIRST failure, not a later one", () => {
    const out = nestedOrchestratorOutcome("run-sequence", {
      completed: 0,
      total: 2,
      steps: [
        { tool: "keyboard", error: "first" },
        { tool: "gesture-tap", error: "second" },
      ],
    });

    expect(out?.reason).toMatch(/stopped at keyboard/);
    expect(out?.reason).toMatch(/first$/);
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
