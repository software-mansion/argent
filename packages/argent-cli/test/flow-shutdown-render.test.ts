import { describe, it, expect } from "vitest";
import {
  renderReport,
  renderFailedSteps,
  summarizeFailure,
  type FlowReport,
  type StepReport,
} from "../src/e2e.js";

function report(steps: StepReport[]): FlowReport {
  const failing = steps.filter((s) => s.status === "fail" || s.status === "error");
  return {
    e2eTest: "t",
    device: "",
    ok: failing.length === 0,
    ...(failing.some((s) => s.shutdown) ? { shutdownFailed: true } : {}),
    passed: steps.filter((s) => s.status === "pass").length,
    failed: steps.filter((s) => s.status === "fail").length,
    skipped: steps.filter((s) => s.status === "skip").length,
    errored: steps.filter((s) => s.status === "error").length,
    steps,
  };
}

const step = (status: StepReport["status"], target: string, extra: Partial<StepReport> = {}) =>
  ({ index: 0, kind: "script", status, target, e2eTest: "t", ...extra }) as StepReport;

describe("shutdown rendering", () => {
  it("prints a header once, above the first shutdown step, and numbers on", () => {
    const out = renderReport(
      report([
        step("pass", "a.mjs"),
        step("pass", "down1.mjs", { shutdown: true }),
        step("pass", "down2.mjs", { shutdown: true }),
      ])
    ).split("\n");

    expect(out.filter((l) => l === "  shutdown:")).toHaveLength(1);
    const header = out.indexOf("  shutdown:");
    expect(out[header - 1]).toContain(" 1 script a.mjs");
    expect(out[header + 1]).toContain(" 2 script down1.mjs");
    expect(out[header + 2]).toContain(" 3 script down2.mjs");
  });

  it("heads a run that failed only in shutdown with that failure", () => {
    const r = report([
      step("pass", "a.mjs"),
      step("error", "down.mjs", { shutdown: true, reason: "boom" }),
    ]);
    expect(summarizeFailure(r)).toEqual({
      headline: "shutdown did not finish: step 2 script down.mjs",
      detail: "boom",
    });
    expect(renderReport(r)).toContain("✗ shutdown did not finish: step 2 script down.mjs");
  });

  it("keeps the steps' own failure first and adds the shutdown one under it", () => {
    const r = report([
      step("fail", "a.mjs", { reason: "first" }),
      step("error", "down.mjs", { shutdown: true, reason: "boom" }),
    ]);
    expect(summarizeFailure(r)).toEqual({
      headline: "step 1 script a.mjs",
      detail: "first\nshutdown did not finish: step 2 script down.mjs — boom",
    });
  });

  it("marks shutdown in the batch's failed-step lines", () => {
    const lines = renderFailedSteps(
      report([step("pass", "a.mjs"), step("error", "down.mjs", { shutdown: true })])
    );
    expect(lines[0]).toBe("  shutdown:");
    expect(lines[1]).toContain(" 2 script down.mjs");
  });
});
