import { describe, it, expect } from "vitest";
import {
  renderReport,
  renderFailedSteps,
  renderScriptLogLines,
  type FlowReport,
  type StepReport,
} from "../src/flow.js";

/**
 * A `script` step's captured output in the CLI's text report. It is the only
 * record of what the step did to the backend, so it prints on a PASS as well as
 * a failure — and, in batch mode, beside the failed steps that need attention.
 */

function report(steps: StepReport[]): FlowReport {
  const counted = steps.filter((s) => s.kind !== "echo");
  return {
    flow: "seed",
    device: "",
    ok: counted.every((s) => s.status === "pass" || s.status === "skip"),
    passed: counted.filter((s) => s.status === "pass").length,
    failed: counted.filter((s) => s.status === "fail").length,
    skipped: counted.filter((s) => s.status === "skip").length,
    errored: counted.filter((s) => s.status === "error").length,
    steps,
  };
}

const PASSING: StepReport = {
  index: 0,
  kind: "script",
  status: "pass",
  target: "scripts/seed.mjs",
  scriptLog: "creating order\norder 4711 created\n",
};

describe("script log rendering", () => {
  it("prints one indented line per line the script wrote, under the step line", () => {
    const out = renderReport(report([PASSING]));
    expect(out).toContain("✓  1 script scripts/seed.mjs");
    expect(out).toContain("       │ creating order");
    expect(out).toContain("       │ order 4711 created");
    // The trailing newline scripts end their output with is not a blank line.
    expect(out).not.toMatch(/│ \n/);
  });

  it("says so when a log limit dropped output, since the text carries no marker", () => {
    const lines = renderScriptLogLines({ ...PASSING, scriptLogTruncated: true }, 1);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toContain("… output truncated (script log limit reached)");
  });

  it("prints the truncation notice alone when the whole log was dropped", () => {
    // A run-wide budget an earlier script exhausted leaves a later step with no
    // text at all; printing nothing would read as a script that printed nothing.
    const lines = renderScriptLogLines(
      { ...PASSING, scriptLog: undefined, scriptLogTruncated: true },
      1
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("… output truncated (script log limit reached)");
  });

  it("prints nothing for a step with no log, or a non-string one off the wire", () => {
    expect(renderScriptLogLines({ ...PASSING, scriptLog: undefined }, 1)).toEqual([]);
    expect(renderScriptLogLines({ ...PASSING, scriptLog: "" }, 1)).toEqual([]);
    expect(
      renderScriptLogLines({ ...PASSING, scriptLog: { evil: true } as unknown as string }, 1)
    ).toEqual([]);
    // A truthy non-boolean off the wire is not a truncation claim.
    expect(
      renderScriptLogLines(
        { ...PASSING, scriptLog: undefined, scriptLogTruncated: "yes" as unknown as boolean },
        1
      )
    ).toEqual([]);
  });

  it("carries a failed script's log into batch mode's failed-step list", () => {
    const failed: StepReport = {
      index: 0,
      kind: "script",
      status: "fail",
      target: "scripts/seed.mjs",
      reason: "Error: seed API returned 500",
      scriptLog: "POST /orders -> 500\n",
    };
    const lines = renderFailedSteps(report([failed]));
    expect(lines[0]).toContain("script scripts/seed.mjs — Error: seed API returned 500");
    expect(lines[1]).toContain("│ POST /orders -> 500");
  });

  it("indents a nested script step's log with the step, not against the margin", () => {
    const nested = renderScriptLogLines({ ...PASSING, depth: 2 }, 3);
    expect(nested[0]).toBe(`${" ".repeat(7)}    │ creating order`);
  });
});
