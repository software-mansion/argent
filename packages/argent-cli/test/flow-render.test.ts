import { describe, it, expect } from "vitest";
import {
  renderReport,
  renderStepLine,
  renderEchoLine,
  renderSummary,
  renderArtifactLines,
  renderUnderStepLine,
  renderStepLines,
  renderFailedSteps,
  renderBatchSummary,
  renderFailedFlows,
  renderSingleFailure,
  summarizeFailure,
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
  it("buffered renderReport prints every step, then the failure recap and the summary", () => {
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
        '  ✗ step 3 snapshot "home"',
        "    diff 2.10% > 1%",
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
      live.push(...renderStepLines(s, n, report.flow));
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

  it("renderStepLines prints expected, actual and hint under the label, values quoted and aligned", () => {
    // How each value is spelled is the shared renderer's (tools-client); this
    // pins where the CLI puts the lines.
    const step: StepReport = {
      index: 0,
      kind: "assert",
      status: "fail",
      target: 'text "Total"',
      reason: "text did not match",
      expected: "$12.00",
      actual: "$10.00",
      hint: "the cart may still be loading",
    };
    const lines = renderStepLines(step, 3, "f");
    expect(lines).toEqual([
      '  ✗  3 assert text "Total" — text did not match',
      '       expected: "$12.00"',
      '       actual:   "$10.00"',
      "       hint: the cart may still be loading",
    ]);
    expect(lines[1]!.indexOf('"')).toBe(lines[2]!.indexOf('"'));
    expect(lines[1]!.indexOf("expected")).toBe(lines[0]!.indexOf("assert"));
  });

  it("renderStepLines keeps the detail lines under the label when nested and past step 99", () => {
    // The number column widens at 100+ and the label shifts with depth; each
    // detail line has to move with both.
    const step: StepReport = {
      index: 0,
      kind: "assert",
      status: "fail",
      target: 'text "Total"',
      expected: "$12.00",
      actual: "$10.00",
      indeterminate: true,
      hint: "wait for the cart",
    };
    for (const n of [3, 100, 1000]) {
      for (const depth of [undefined, 1, 2]) {
        const [label, ...details] = renderStepLines({ ...step, depth }, n, "f");
        const labelCol = label!.indexOf("assert");
        expect(details).toHaveLength(4);
        for (const line of details) expect(line.search(/\S/)).toBe(labelCol);
      }
    }
    expect(renderStepLines({ ...step, depth: 2 }, 1000, "f")).toEqual([
      '  ✗ 1000     assert text "Total"',
      '             expected: "$12.00"',
      '             actual:   "$10.00"',
      "             indeterminate: the check did not run",
      "             hint: wait for the cart",
    ]);
    expect(renderStepLines({ ...step, depth: 1 }, 100, "f").slice(0, 2)).toEqual([
      '  ✗ 100   assert text "Total"',
      '          expected: "$12.00"',
    ]);
  });

  it("buffered report prints detail lines under the step and its warning, before its artifacts", () => {
    const out = renderReport(
      mkReport([
        { index: 0, kind: "launch", status: "pass" },
        {
          index: 1,
          kind: "assert",
          status: "fail",
          target: 'text "Total"',
          reason: "text did not match",
          expected: "$12.00",
          actual: "$10.00",
          hint: "the cart may still be loading",
        },
        {
          index: 2,
          kind: "snapshot",
          status: "fail",
          reason: "diff 3.10% > 0.5%",
          target: '"home"',
          warning: "baseline seeded",
          expected: "≤ 0.5%",
          actual: "3.10%",
          hint: "an animation may still be running",
          artifacts: { diff: "/tmp/d.png" },
        },
        { index: 3, kind: "tap", status: "skip", target: '"Pay"' },
      ])
    );
    expect(out).toBe(
      [
        'Flow "checkout" on UDID-1',
        "  ✓  1 launch",
        '  ✗  2 assert text "Total" — text did not match',
        '       expected: "$12.00"',
        '       actual:   "$10.00"',
        "       hint: the cart may still be loading",
        '  ✗  3 snapshot "home" — diff 3.10% > 0.5%',
        "       ⚠ baseline seeded",
        "       expected: ≤ 0.5%",
        "       actual:   3.10%",
        "       hint: an animation may still be running",
        "       diff: /tmp/d.png",
        '  ·  4 tap "Pay"',
        "",
        '  ✗ step 2 assert text "Total"',
        "    text did not match",
        '    expected: "$12.00"',
        '    actual:   "$10.00"',
        "    hint: the cart may still be loading",
        "",
        "FAIL — 1 passed, 2 failed, 0 errored, 1 skipped, 1 warning",
      ].join("\n")
    );
  });

  it("renderSummary carries the device only when asked (live tail)", () => {
    const report = mkReport(STEPS);
    expect(renderSummary(report)).toBe("FAIL — 2 passed, 1 failed, 0 errored, 1 skipped");
    // "started on": a chromium run can move onto runner-booted instances, so
    // the summary must not claim the whole run happened on the starting device.
    expect(renderSummary(report, { withDevice: true })).toBe(
      "FAIL (started on UDID-1) — 2 passed, 1 failed, 0 errored, 1 skipped"
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

  it("renderFailedSteps keeps full-report numbering and under-lines, echoes excluded", () => {
    // Only the failing snapshot appears, numbered 3 as in the full report so
    // the line matches a single-mode rerun; its artifact paths ride along.
    expect(renderFailedSteps(mkReport(STEPS))).toEqual([
      '  ✗  3 snapshot "home" — diff 2.10% > 1%',
      "       baseline: /tmp/b.png",
      "       diff: /tmp/d.png",
    ]);
  });

  it("renderFailedSteps includes errored steps and their warnings", () => {
    expect(
      renderFailedSteps(
        mkReport([
          { index: 0, kind: "tap", status: "pass" },
          {
            index: 1,
            kind: "tool",
            tool: "screenshot",
            status: "error",
            reason: "device gone",
            warning: "no baseline; adopted",
          },
        ])
      )
    ).toEqual(["  ✗  2 tool screenshot — device gone", "       ⚠ no baseline; adopted"]);
  });

  it("renderFailedSteps is empty for a clean pass", () => {
    expect(renderFailedSteps(mkReport([{ index: 0, kind: "tap", status: "pass" }]))).toEqual([]);
  });

  it("renderFailedSteps prints a passing step's warning, which renderSummary counts", () => {
    // `await: { idle: true }` only ever warns on a step that PASSED, and the
    // summary counts warnings whatever the status — so a directory run used to
    // report "1 warning" with the text nowhere on screen.
    const report = mkReport([
      { index: 0, kind: "tap", status: "pass" },
      { index: 1, kind: "idle", status: "pass", warning: "the screen never held still" },
    ]);
    expect(renderFailedSteps(report)).toEqual([
      "  ⚠  2 idle",
      "       ⚠ the screen never held still",
    ]);
    expect(renderSummary(report)).toContain("1 warning");
  });

  it("renderFailedSteps prints detail lines under the step and its warning, before its artifacts", () => {
    const report = mkReport([
      { index: 0, kind: "launch", status: "pass" },
      {
        index: 1,
        kind: "assert",
        status: "fail",
        target: 'text "Total"',
        reason: "text did not match",
        expected: "$12.00",
        actual: "$10.00",
        hint: "the cart may still be loading",
      },
      {
        index: 2,
        kind: "snapshot",
        status: "error",
        reason: "diff 3.10% > 0.5%",
        target: '"home"',
        warning: "baseline seeded",
        expected: "≤ 0.5%",
        actual: "3.10%",
        hint: "an animation may still be running",
        artifacts: { diff: "/tmp/d.png" },
      },
    ]);
    expect(renderFailedSteps(report)).toEqual([
      '  ✗  2 assert text "Total" — text did not match',
      '       expected: "$12.00"',
      '       actual:   "$10.00"',
      "       hint: the cart may still be loading",
      '  ✗  3 snapshot "home" — diff 3.10% > 0.5%',
      "       ⚠ baseline seeded",
      "       expected: ≤ 0.5%",
      "       actual:   3.10%",
      "       hint: an animation may still be running",
      "       diff: /tmp/d.png",
    ]);
  });

  it("renderStepLine puts the step time between the label and the reason", () => {
    const step: StepReport = {
      index: 0,
      kind: "tap",
      status: "fail",
      target: '"Pay"',
      flow: "login",
      reason: "no match",
    };
    expect(renderStepLine(step, 1, "checkout")).toBe('  ✗  1 tap "Pay" [login] — no match');
    expect(renderStepLine({ ...step, durationMs: 5002 }, 1, "checkout")).toBe(
      '  ✗  1 tap "Pay" [login] (5.0s) — no match'
    );
  });

  it("formats a duration as tenths under a minute and minutes plus seconds from one", () => {
    const line = (durationMs: unknown) =>
      renderStepLine({ index: 0, kind: "tap", status: "pass", durationMs } as StepReport, 1, "f");
    expect(line(0)).toBe("  ✓  1 tap (0.0s)");
    expect(line(440)).toBe("  ✓  1 tap (0.4s)");
    expect(line(12_345)).toBe("  ✓  1 tap (12.3s)");
    expect(line(59_940)).toBe("  ✓  1 tap (59.9s)");
    expect(line(59_950)).toBe("  ✓  1 tap (1m 0s)");
    expect(line(92_400)).toBe("  ✓  1 tap (1m 32s)");
    for (const bad of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, "5000"]) {
      expect(line(bad)).toBe("  ✓  1 tap");
    }
  });

  it("renderSummary ends with the run time, after the warning and no-steps notes", () => {
    expect(renderSummary(mkReport(STEPS, { durationMs: 9912 }))).toBe(
      "FAIL — 2 passed, 1 failed, 0 errored, 1 skipped (9.9s)"
    );
    const warned = mkReport([{ index: 0, kind: "idle", status: "pass", warning: "moving" }], {
      durationMs: 1200,
    });
    expect(renderSummary(warned)).toBe(
      "PASS — 1 passed, 0 failed, 0 errored, 0 skipped, 1 warning (1.2s)"
    );
    expect(renderSummary(mkReport([], { durationMs: 50 }))).toBe(
      "PASS — 0 passed, 0 failed, 0 errored, 0 skipped (no test steps) (0.1s)"
    );
  });

  it("renderBatchSummary mirrors the step summary's verdict shape", () => {
    expect(renderBatchSummary({ total: 3, passed: 2, failed: 1, skipped: 0 })).toBe(
      "FAIL — 3 flows: 2 passed, 1 failed, 0 skipped"
    );
    expect(renderBatchSummary({ total: 1, passed: 1, failed: 0, skipped: 0 })).toBe(
      "PASS — 1 flow: 1 passed, 0 failed, 0 skipped"
    );
    // Skips only ever follow a failure, so they never turn the verdict alone.
    expect(renderBatchSummary({ total: 2, passed: 1, failed: 0, skipped: 1 })).toBe(
      "PASS — 2 flows: 1 passed, 0 failed, 1 skipped"
    );
    expect(renderBatchSummary({ total: 2, passed: 1, failed: 1, skipped: 0 }, 92_400)).toBe(
      "FAIL — 2 flows: 1 passed, 1 failed, 0 skipped (1m 32s)"
    );
  });
});

describe("failure recap", () => {
  it("numbers the failing step as the per-flow block does, skipping echo narration", () => {
    expect(summarizeFailure(mkReport(STEPS))).toEqual({
      headline: 'step 3 snapshot "home"',
      detail: "diff 2.10% > 1%",
    });
  });

  it("names the first failing step, errors included, with its fragment", () => {
    const report = mkReport([
      { index: 0, kind: "echo", status: "pass", message: "go" },
      { index: 1, kind: "tap", status: "pass" },
      { index: 2, kind: "tool", status: "error", tool: "screenshot", flow: "login" },
      { index: 3, kind: "assert", status: "fail", reason: "later" },
    ]);
    expect(summarizeFailure(report)).toEqual({
      headline: "step 2 tool screenshot [login]",
      detail: undefined,
    });
  });

  it("renders a non-string wire reason the way the step line does, instead of throwing", () => {
    const step = { index: 0, kind: "tap", status: "fail", reason: 42 } as unknown as StepReport;
    const report = mkReport([step]);
    expect(renderStepLine(step, 1, "checkout")).toBe("  ✗  1 tap — 42");
    expect(renderSingleFailure(report)).toEqual(["", "  ✗ step 1 tap", "    42"]);
  });

  it("says so when a failed report has no failing step", () => {
    const report = mkReport([{ index: 0, kind: "tap", status: "skip" }], { ok: false });
    expect(summarizeFailure(report)).toEqual({ headline: "failed with no failing step" });
  });

  it("carries the failing step's expected, actual and hint under its reason, one line each", () => {
    const report = mkReport([
      { index: 0, kind: "tap", status: "pass" },
      {
        index: 1,
        kind: "assert",
        status: "fail",
        target: "id=count matches /^Taps: \\d+$/",
        reason: 'element matched id="count" but its text did not match /^Taps: \\d+$/',
        expected: "^Taps: \\d+$",
        expectedKind: "pattern",
        actual: "Taps:\n0",
        hint: 'the element\'s own text is "0"',
      },
    ]);
    expect(renderSingleFailure(report)).toEqual([
      "",
      "  ✗ step 2 assert id=count matches /^Taps: \\d+$/",
      '    element matched id="count" but its text did not match /^Taps: \\d+$/',
      "    expected: /^Taps: \\d+$/",
      '    actual:   "Taps:\\n0"',
      '    hint: the element\'s own text is "0"',
    ]);
  });

  it("prints nothing when no flow failed", () => {
    expect(renderFailedFlows([])).toEqual([]);
  });

  it("lists each failed flow in the order given, with its detail and re-run command", () => {
    expect(
      renderFailedFlows([
        {
          path: "a-login.yaml",
          headline: 'step 2 assert visible "Home"',
          detail: 'no element matched selector text="Home"',
          rerun: "argent flow run flows/a-login.yaml --platform ios",
        },
        {
          path: "sub/c-search.yaml",
          headline: "not run (invalid flow)",
          detail: "flow file is not valid YAML\n\n  at line 4",
          rerun: "argent flow run flows/sub/c-search.yaml --platform ios",
        },
        {
          path: "b-checkout.yaml",
          headline: "failed with no failing step",
          rerun: "argent flow run flows/b-checkout.yaml --platform ios",
        },
      ])
    ).toEqual([
      "",
      "Failed flows (3)",
      "",
      '  ✗ a-login.yaml › step 2 assert visible "Home"',
      '    no element matched selector text="Home"',
      "    re-run: argent flow run flows/a-login.yaml --platform ios",
      "",
      "  ✗ sub/c-search.yaml › not run (invalid flow)",
      "    flow file is not valid YAML",
      "      at line 4",
      "    re-run: argent flow run flows/sub/c-search.yaml --platform ios",
      "",
      "  ✗ b-checkout.yaml › failed with no failing step",
      "    re-run: argent flow run flows/b-checkout.yaml --platform ios",
    ]);
  });

  it("recaps a single failed run without a flow name or a re-run command", () => {
    expect(renderSingleFailure(mkReport(STEPS))).toEqual([
      "",
      '  ✗ step 3 snapshot "home"',
      "    diff 2.10% > 1%",
    ]);
    expect(renderSingleFailure(mkReport([{ index: 0, kind: "tap", status: "pass" }]))).toEqual([]);
  });
});
