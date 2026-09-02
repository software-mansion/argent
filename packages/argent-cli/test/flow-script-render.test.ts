import { describe, it, expect } from "vitest";
import { renderReport, renderFailedSteps, type FlowReport, type StepReport } from "../src/flow.js";

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
};

const WITH_LOG_ON_THE_WIRE = {
  ...PASSING,
  scriptLog: "creating order\nDATABASE_URL=postgres://user:hunter2@db/prod\n",
  scriptLogTruncated: true,
} as StepReport;

describe("script step rendering", () => {
  it("prints a script step as a bare status line", () => {
    const out = renderReport(report([PASSING]));
    expect(out).toContain("✓  1 script scripts/seed.mjs");
    expect(out).not.toContain("│");
  });

  it("prints nothing a script wrote, even when the report carries it", () => {
    const out = renderReport(report([WITH_LOG_ON_THE_WIRE]));
    expect(out).toContain("✓  1 script scripts/seed.mjs");
    expect(out).not.toContain("creating order");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("truncated");
  });

  it("keeps a failed script step to its reason", () => {
    const failed: StepReport = {
      index: 0,
      kind: "script",
      status: "fail",
      target: "scripts/seed.mjs",
      reason: "Error: seed API returned 500",
      scriptLog: "POST /orders -> 500\n",
    } as StepReport;
    const lines = renderFailedSteps(report([failed]));
    expect(lines[0]).toContain("script scripts/seed.mjs — Error: seed API returned 500");
    expect(lines.join("\n")).not.toContain("POST /orders");
  });

  it("carries a passing script's executor note into batch mode", () => {
    // A silent script under a clamped time limit is the case with nothing else
    // to show: no warning, a pass — and a host that quietly lowered the bound
    // the flow asked for. The note is the executor's, not anything the script
    // printed, so dropping the log channel leaves it standing.
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

  it("leaves a passing script step out of batch mode, log on the wire or not", () => {
    const tapped: StepReport = { index: 0, kind: "tap", status: "pass", target: "#checkout" };
    expect(renderFailedSteps(report([tapped, PASSING]))).toEqual([]);
    expect(renderFailedSteps(report([tapped, WITH_LOG_ON_THE_WIRE]))).toEqual([]);
  });

  it("still prints a passing script step that carries a warning", () => {
    const warned = { ...WITH_LOG_ON_THE_WIRE, warning: "took 41s" } as StepReport;
    const lines = renderFailedSteps(report([warned]));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("⚠ took 41s");
    expect(lines.join("\n")).not.toContain("creating order");
  });
});
