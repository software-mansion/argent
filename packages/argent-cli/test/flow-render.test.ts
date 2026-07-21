import { describe, it, expect } from "vitest";
import {
  renderReport,
  renderStepLine,
  renderEchoLine,
  renderSummary,
  renderArtifactLines,
  renderUnderStepLine,
  type FlowReport,
  type StepReport,
} from "../src/flow.js";

function mkReport(steps: StepReport[], overrides: Partial<FlowReport> = {}): FlowReport {
  // Mirror the runner's summarize(): echo narration is not a counted step.
  const counted = steps.filter((s) => s.kind !== "echo");
  const passed = counted.filter((s) => s.status === "pass").length;
  const failed = counted.filter((s) => s.status === "fail").length;
  const skipped = counted.filter((s) => s.status === "skip").length;
  const errored = counted.filter((s) => s.status === "error").length;
  return {
    flow: "checkout",
    device: "UDID-1",
    ok: failed === 0 && errored === 0,
    passed,
    failed,
    skipped,
    errored,
    steps,
    ...overrides,
  };
}

const STEPS: StepReport[] = [
  { index: 0, kind: "echo", status: "pass", message: "starting" },
  { index: 1, kind: "launch", status: "pass" },
  { index: 2, kind: "tap", status: "pass", flow: "login", target: '"Login"' },
  {
    index: 3,
    kind: "snapshot",
    status: "fail",
    reason: "diff 2.10% > 1%",
    target: '"home"',
    artifacts: { baseline: "/tmp/b.png", diff: "/tmp/d.png" },
  },
  { index: 4, kind: "await", status: "skip", target: 'visible "Done"' },
];

describe("flow report rendering", () => {
  it("buffered renderReport keeps its historical shape", () => {
    const out = renderReport(mkReport(STEPS));
    expect(out).toBe(
      [
        'Flow "checkout" on UDID-1',
        "  › starting",
        "  ✓  1 launch",
        '  ✓  2 tap "Login" [login]',
        '  ✗  3 snapshot "home" — diff 2.10% > 1%',
        "       baseline: /tmp/b.png",
        "       diff: /tmp/d.png",
        '  ·  4 await visible "Done"',
        "",
        "FAIL — 2 passed, 1 failed, 0 errored, 1 skipped",
      ].join("\n")
    );
  });

  it("live step lines match the buffered renderer's step lines", () => {
    const report = mkReport(STEPS);
    const buffered = renderReport(report).split("\n");

    // Reproduce the live loop: number only non-echo steps, same top flow.
    const live: string[] = [];
    let n = 0;
    for (const s of report.steps) {
      if (s.kind === "echo") {
        const line = renderEchoLine(s);
        if (line) live.push(line);
        continue;
      }
      n++;
      live.push(renderStepLine(s, n, report.flow));
    }

    // Every live line appears verbatim in the buffered output (which adds the
    // header, inline artifact paths, and summary around them).
    for (const line of live) expect(buffered).toContain(line);
  });

  it("pass with a warning renders the warning glyph", () => {
    const step: StepReport = {
      index: 0,
      kind: "snapshot",
      status: "pass",
      warning: "baseline seeded",
    };
    expect(renderStepLine(step, 1, "checkout")).toBe("  ⚠  1 snapshot");
  });

  it("renders a skipped echo distinctly from one that ran", () => {
    // A `when:` block that didn't run reports its echo as skipped. It must not
    // print identically to an echo that executed, or the report lies about
    // what happened.
    const ran: StepReport = { index: 0, kind: "echo", status: "pass", message: "entering block" };
    const skipped: StepReport = {
      index: 1,
      kind: "echo",
      status: "skip",
      reason: "when block skipped",
      message: "entering block",
    };
    expect(renderEchoLine(ran)).toBe("  › entering block");
    expect(renderEchoLine(skipped)).toBe("  · › entering block — when block skipped");
    // The two must be visually distinguishable.
    expect(renderEchoLine(ran)).not.toBe(renderEchoLine(skipped));
  });

  it("a hard-stopped echo (skip, no reason) still renders instead of vanishing", () => {
    const stopped: StepReport = { index: 5, kind: "echo", status: "skip", message: "cleanup note" };
    expect(renderEchoLine(stopped)).toBe("  · › cleanup note");
  });

  it("an echo without a message renders nothing", () => {
    expect(renderEchoLine({ index: 0, kind: "echo", status: "pass" })).toBeUndefined();
  });

  it("a skipped echo appears in the buffered report as a marked line", () => {
    const out = renderReport(
      mkReport([
        { index: 0, kind: "launch", status: "pass" },
        {
          index: 1,
          kind: "when",
          status: "skip",
          reason: 'condition not met (visible "Promo") — block skipped (1 step)',
          target: 'visible "Promo"',
        },
        {
          index: 2,
          kind: "echo",
          status: "skip",
          reason: "when block skipped",
          message: "THIS MUST NOT RUN",
        },
      ])
    );
    expect(out).toContain("  · › THIS MUST NOT RUN — when block skipped");
    expect(out).not.toContain("  › THIS MUST NOT RUN");
  });

  it("indents step and echo labels by depth, keeping the glyph/number columns", () => {
    const tap: StepReport = {
      index: 2,
      kind: "tap",
      status: "pass",
      target: '"Dismiss"',
      depth: 1,
    };
    expect(renderStepLine(tap, 3, "checkout")).toBe('  ✓  3   tap "Dismiss"');
    expect(renderStepLine({ ...tap, depth: 2 }, 3, "checkout")).toBe('  ✓  3     tap "Dismiss"');
    // Absent depth (a pre-depth tool-server) and explicit 0 both render flat.
    expect(renderStepLine({ ...tap, depth: undefined }, 3, "checkout")).toBe(
      '  ✓  3 tap "Dismiss"'
    );
    expect(renderStepLine({ ...tap, depth: 0 }, 3, "checkout")).toBe('  ✓  3 tap "Dismiss"');

    const echo: StepReport = {
      index: 3,
      kind: "echo",
      status: "pass",
      message: "inside",
      depth: 1,
    };
    expect(renderEchoLine(echo)).toBe("    › inside");
    const skippedEcho: StepReport = {
      ...echo,
      status: "skip",
      reason: "when block skipped",
      depth: 2,
    };
    expect(renderEchoLine(skippedEcho)).toBe("  ·     › inside — when block skipped");
  });

  it("clamps a hostile wire depth instead of throwing or exploding", () => {
    // depth arrives over the wire: a negative value must not throw
    // (String.repeat rejects it) and a huge one must not allocate a huge line.
    const tap: StepReport = { index: 0, kind: "tap", status: "pass", target: '"A"', depth: -3 };
    expect(renderStepLine(tap, 1, "f")).toBe('  ✓  1 tap "A"');
    expect(renderStepLine({ ...tap, depth: 1.5 }, 1, "f")).toBe('  ✓  1 tap "A"');
    // The cap clamps, it does not discard: legitimate depth can exceed it
    // (the producer's run-chain and when-nesting limits accumulate), so a
    // too-deep step keeps the maximum indent rather than snapping back flat.
    const atCap = renderStepLine({ ...tap, depth: 20 }, 1, "f");
    expect(atCap).toBe(`  ✓  1 ${"  ".repeat(20)}tap "A"`);
    expect(renderStepLine({ ...tap, depth: 21 }, 1, "f")).toBe(atCap);
    expect(renderStepLine({ ...tap, depth: 1e9 }, 1, "f")).toBe(atCap);
  });

  it("buffered report shifts under-step lines (warnings, artifacts) with the step", () => {
    const out = renderReport(
      mkReport([
        {
          index: 0,
          kind: "when",
          status: "pass",
          reason: 'condition met (visible "Promo")',
          target: 'visible "Promo"',
        },
        {
          index: 1,
          kind: "snapshot",
          status: "fail",
          reason: "diff 2.10% > 1%",
          target: '"home"',
          depth: 1,
          warning: "baseline seeded",
          artifacts: { baseline: "/tmp/b.png" },
        },
      ])
    );
    expect(out).toContain('  ✗  2   snapshot "home" — diff 2.10% > 1%');
    expect(out).toContain("         ⚠ baseline seeded");
    expect(out).toContain("         baseline: /tmp/b.png");
  });

  it("the live tail's warning line (renderUnderStepLine) shifts with depth too", () => {
    // The live path prints warnings through the same helper as the buffered
    // renderer — pin the helper so the two can't drift apart.
    const step: StepReport = { index: 0, kind: "snapshot", status: "pass", depth: 1 };
    expect(renderUnderStepLine(step, 3, "⚠ baseline seeded")).toBe("         ⚠ baseline seeded");
    expect(renderUnderStepLine({ ...step, depth: undefined }, 3, "⚠ w")).toBe("       ⚠ w");
  });

  it("under-step lines stay under the label when the step number grows past 99", () => {
    // padStart(2) widens the number column at 100+; the under-step pad must
    // widen with it, at any depth.
    for (const n of [9, 99, 100, 1000]) {
      for (const depth of [undefined, 1]) {
        const step: StepReport = { index: 0, kind: "snapshot", status: "pass", depth };
        const labelCol = renderStepLine(step, n, "f").indexOf("snapshot");
        expect(renderUnderStepLine(step, n, "⚠ w").indexOf("⚠")).toBe(labelCol);
      }
    }
  });

  it("renderSummary carries the device only when asked (live tail)", () => {
    const report = mkReport(STEPS);
    expect(renderSummary(report)).toBe("FAIL — 2 passed, 1 failed, 0 errored, 1 skipped");
    expect(renderSummary(report, { withDevice: true })).toBe(
      "FAIL on UDID-1 — 2 passed, 1 failed, 0 errored, 1 skipped"
    );
  });

  it("renderArtifactLines labels paths by step number, skipping echo steps", () => {
    const lines = renderArtifactLines(mkReport(STEPS));
    // The snapshot is the 3rd numbered step (echo carries no number).
    expect(lines).toEqual([
      "  snapshot (step 3):",
      "       baseline: /tmp/b.png",
      "       diff: /tmp/d.png",
    ]);
  });
});
