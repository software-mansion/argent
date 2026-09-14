import { describe, it, expect } from "vitest";
import { renderReport, renderSummary, type FlowReport } from "../src/flow.js";

function report(overrides: Partial<FlowReport> = {}): FlowReport {
  return {
    flow: "echo-only",
    device: "",
    ok: true,
    passed: 0,
    failed: 0,
    skipped: 0,
    errored: 0,
    steps: [],
    ...overrides,
  } as FlowReport;
}

describe("rendering a run that resolved no device", () => {
  it("does not claim the run happened on a device", () => {
    const line = renderSummary(report(), { withDevice: true });

    expect(line).not.toContain(" on ");
    expect(line).toBe("PASS — 0 passed, 0 failed, 0 errored, 0 skipped (no test steps)");
  });

  it("omits the device from the report header too", () => {
    const lines = renderReport(report()).split("\n");

    expect(lines[0]).toBe('Flow "echo-only"');
  });

  it("still names a device when the run had one", () => {
    const line = renderSummary(report({ device: "UDID-1", passed: 2 }), { withDevice: true });

    expect(line).toBe("PASS (started on UDID-1) — 2 passed, 0 failed, 0 errored, 0 skipped");
  });
});

describe("the no-test-steps note", () => {
  it("explains a passing run whose counters are all zero", () => {
    expect(renderSummary(report())).toContain("(no test steps)");
  });

  it("is absent whenever anything was counted", () => {
    expect(renderSummary(report({ passed: 1 }))).not.toContain("(no test steps)");
    expect(renderSummary(report({ skipped: 1 }))).not.toContain("(no test steps)");
  });

  it("is absent on a failure, where the counts are not what needs explaining", () => {
    // A cancelled run can be a FAIL with every counter still zero; calling that
    // "no test steps" would read as though the failure had no cause.
    const line = renderSummary(report({ ok: false }));

    expect(line).toBe("FAIL — 0 passed, 0 failed, 0 errored, 0 skipped");
    expect(line).not.toContain("(no test steps)");
  });

  it("leaves an ordinary summary byte-for-byte unchanged", () => {
    const line = renderSummary(report({ ok: false, passed: 2, failed: 1, skipped: 1 }));

    expect(line).toBe("FAIL — 2 passed, 1 failed, 0 errored, 1 skipped");
  });
});
