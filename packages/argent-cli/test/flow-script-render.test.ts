import { describe, it, expect } from "vitest";
import {
  renderReport,
  renderFailedSteps,
  renderScriptLogLines,
  type FlowReport,
  type StepReport,
} from "../src/flow.js";

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
    expect(out).not.toMatch(/│ \n/);
  });

  it("says so when a log limit dropped output, since the text carries no marker", () => {
    const lines = renderScriptLogLines({ ...PASSING, scriptLogTruncated: true }, 1);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toContain("… output truncated");
  });

  it("prints the truncation notice alone when the whole log was dropped", () => {
    const lines = renderScriptLogLines(
      { ...PASSING, scriptLog: undefined, scriptLogTruncated: true },
      1
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("… output truncated");
  });

  it("prints nothing for a step with no log, or a non-string one off the wire", () => {
    expect(renderScriptLogLines({ ...PASSING, scriptLog: undefined }, 1)).toEqual([]);
    expect(renderScriptLogLines({ ...PASSING, scriptLog: "" }, 1)).toEqual([]);
    expect(
      renderScriptLogLines({ ...PASSING, scriptLog: { evil: true } as unknown as string }, 1)
    ).toEqual([]);
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

  it("carries a passing script's log into batch mode, the surface CI reads", () => {
    const lines = renderFailedSteps(report([PASSING]));
    expect(lines[0]).toContain("✓  1 script scripts/seed.mjs");
    expect(lines[1]).toContain("│ creating order");
    expect(lines[2]).toContain("│ order 4711 created");
  });

  it("keeps a passing seed script's log beside the later step that failed", () => {
    const failed: StepReport = {
      index: 1,
      kind: "tap",
      status: "fail",
      target: "#checkout",
      reason: "not found",
    };
    const lines = renderFailedSteps(report([PASSING, failed]));
    expect(lines[0]).toContain("✓  1 script scripts/seed.mjs");
    expect(lines[1]).toContain("│ creating order");
    expect(lines.at(-1)).toContain("✗  2 tap #checkout — not found");
  });

  it("prints a passing script's truncation notice in batch mode as well", () => {
    const lines = renderFailedSteps(
      report([{ ...PASSING, scriptLog: undefined, scriptLogTruncated: true }])
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("✓  1 script scripts/seed.mjs");
    expect(lines[1]).toContain("… output truncated");
  });

  it("carries a passing script's executor note into batch mode, log or no log", () => {
    // A silent script under a clamped time limit is the case with nothing else
    // to show: no log, no warning, a pass — and a host that quietly lowered the
    // bound the flow asked for.
    const clamped: StepReport = {
      index: 0,
      kind: "script",
      status: "pass",
      target: "scripts/seed.mjs",
      reason:
        "The requested 10m time limit is above this host's maximum of 5m; the step ran with the maximum.",
    };
    const lines = renderFailedSteps(report([clamped]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("✓  1 script scripts/seed.mjs");
    expect(lines[0]).toContain("above this host's maximum of 5m");
  });

  it("leaves a passing NON-script step's self-narrating reason out of batch mode", () => {
    // A `when` guard, a snapshot and a chromium launch all report a reason on a
    // pass. Those narrate a result the summary already counts, so admitting
    // every passing reason would print most of the run back.
    const guard: StepReport = {
      index: 0,
      kind: "when",
      status: "pass",
      reason: "condition met (platform ios)",
    };
    expect(renderFailedSteps(report([guard]))).toEqual([]);
  });

  it("leaves a passing step that wrote no log out of batch mode", () => {
    const tapped: StepReport = { index: 0, kind: "tap", status: "pass", target: "#checkout" };
    const lines = renderFailedSteps(report([tapped, PASSING]));
    expect(lines.some((l) => l.includes("tap #checkout"))).toBe(false);
    expect(lines[0]).toContain("✓  2 script scripts/seed.mjs");
  });

  it("indents a nested script step's log with the step, not against the margin", () => {
    const nested = renderScriptLogLines({ ...PASSING, depth: 2 }, 3);
    expect(nested[0]).toBe(`${" ".repeat(7)}    │ creating order`);
  });
});
