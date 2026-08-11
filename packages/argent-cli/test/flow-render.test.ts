import { describe, it, expect } from "vitest";
import {
  renderFailures,
  renderReport,
  renderStepLine,
  renderEchoLine,
  renderSummary,
  renderArtifactLines,
  renderUnderStepLine,
  renderFailedSteps,
  renderBatchSummary,
  type FlowReport,
  type FlowStepFailure,
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
  });
});

// ── Step timings ─────────────────────────────────────────────────────────

describe("step timings", () => {
  it("adds the duration between the label and the reason, only when it is known", () => {
    const s: StepReport = { index: 0, kind: "tap", status: "fail", target: '"Go"', reason: "nope" };
    // A pre-timing tool-server sends no durationMs, and the line is unchanged.
    expect(renderStepLine(s, 3, "checkout")).toBe('  ✗  3 tap "Go" — nope');
    expect(renderStepLine({ ...s, durationMs: 5002 }, 3, "checkout")).toBe(
      '  ✗  3 tap "Go" (5.0s) — nope'
    );
  });

  it("keeps one decimal at every scale, including sub-100ms", () => {
    const s: StepReport = { index: 0, kind: "launch", status: "pass" };
    const at = (ms: number): string => renderStepLine({ ...s, durationMs: ms }, 1, "f");
    expect(at(3100)).toBe("  ✓  1 launch (3.1s)");
    expect(at(400)).toBe("  ✓  1 launch (0.4s)");
    // Sub-100ms still shows a decimal — a bare (0s) reads as "not measured".
    expect(at(42)).toBe("  ✓  1 launch (0.0s)");
    expect(at(0)).toBe("  ✓  1 launch (0.0s)");
    // Wire data: neither a negative nor a NaN duration may print junk.
    expect(at(-500)).toBe("  ✓  1 launch (0.0s)");
    expect(at(Number.NaN)).toBe("  ✓  1 launch (0.0s)");
  });

  it("sits after the fragment tag so the label stays whole", () => {
    const s: StepReport = {
      index: 0,
      kind: "tap",
      status: "pass",
      target: '"Login"',
      flow: "login",
      durationMs: 400,
    };
    expect(renderStepLine(s, 2, "checkout")).toBe('  ✓  2 tap "Login" [login] (0.4s)');
  });

  it("omitReason drops the suffix for the context window, and nothing else", () => {
    const s: StepReport = {
      index: 0,
      kind: "tap",
      status: "fail",
      target: '"Go"',
      reason: "nope",
      durationMs: 5002,
    };
    expect(renderStepLine(s, 3, "checkout", { omitReason: true })).toBe('  ✗  3 tap "Go" (5.0s)');
    // The default is unchanged, so no existing caller is affected.
    expect(renderStepLine(s, 3, "checkout", {})).toBe(renderStepLine(s, 3, "checkout"));
  });
});

// ── Failure blocks ───────────────────────────────────────────────────────

function node(
  over: Partial<{
    role: string;
    label: string;
    identifier: string;
    frame: { x: number; y: number; width: number; height: number };
  }> = {}
): Record<string, unknown> {
  return {
    role: "button",
    frame: { x: 0.4, y: 0.84, width: 0.2, height: 0.04 },
    ...over,
  };
}

const SELECTOR_FAILURE: FlowStepFailure = {
  code: "selector-not-found",
  category: "selector",
  determinacy: "determinate",
  message: 'no visible element matched selector text="Checkout"',
  hint: "the closest match differs only by a space — fix the step's text, or add `loose: true`",
  step: { index: 3, ordinal: 3, kind: "tap", flow: "checkout", target: '"Checkout"' },
  selector: { described: 'text="Checkout"' },
  screen: {
    state: "available",
    capturedAt: "at-failure",
    elementCount: 47,
    elements: [],
    size: { width: 390, height: 844 },
  },
  candidates: [
    {
      score: 0.86,
      basis: "text-near",
      node: node({ label: "Check out", identifier: "checkout-cta" }),
    },
    {
      score: 0.62,
      basis: "text-contains",
      node: node({
        label: "Checkout later",
        identifier: "checkout-later",
        frame: { x: 0.4, y: 0.91, width: 0.2, height: 0.04 },
      }),
    },
    {
      score: 0.41,
      basis: "text-exact",
      node: node({
        label: "Checkout",
        identifier: "checkout-cta",
        frame: { x: 0.4, y: 1.32, width: 0.2, height: 0.04 },
      }),
    },
  ],
  candidateCount: 3,
  screenshot: "flow-artifacts/checkout/step-03-screen.png",
  tree: "flow-artifacts/checkout/step-03-tree.txt",
  timing: { startedAt: 1, durationMs: 5002 },
};

const CHECKOUT_STEPS: StepReport[] = [
  { index: 0, kind: "echo", status: "pass", message: "Opening the cart" },
  { index: 1, kind: "launch", status: "pass", target: "com.acme.shop", durationMs: 3100 },
  { index: 2, kind: "tap", status: "pass", target: '"Cart"', durationMs: 400 },
  {
    index: 3,
    kind: "tap",
    status: "fail",
    target: '"Checkout"',
    durationMs: 5002,
    reason: 'no visible element matched selector text="Checkout"',
    failure: SELECTOR_FAILURE,
  },
  { index: 4, kind: "await", status: "skip", target: 'visible "Order placed"' },
];

/** One failing step, wrapped in enough context to exercise the window. */
function failingReport(failure: FlowStepFailure, over: Partial<StepReport> = {}): FlowReport {
  return mkReport([
    { index: 0, kind: "launch", status: "pass", target: "com.acme.shop", durationMs: 3100 },
    { index: 1, kind: "tap", status: "pass", target: '"Cart"', durationMs: 400 },
    {
      index: 2,
      kind: "assert",
      status: "fail",
      target: '"Total"',
      durationMs: 5002,
      reason: failure.message,
      failure,
      ...over,
    },
  ]);
}

describe("renderFailures", () => {
  it("pins the worked selector-not-found block", () => {
    expect(renderFailures(mkReport(CHECKOUT_STEPS, { device: "SIM-1" })).join("\n")).toBe(
      [
        "",
        "Failures:",
        "",
        '  3) tap "Checkout"  @ .argent/flows/checkout.yaml',
        '     selector-not-found: no visible element matched selector text="Checkout"',
        "     context:",
        "       › Opening the cart",
        "       ✓  1 launch com.acme.shop (3.1s)",
        '       ✓  2 tap "Cart" (0.4s)',
        '       ✗  3 tap "Checkout" (5.0s)',
        "     candidates:",
        '       0.86  "Check out"       button  id=checkout-cta    visible     at 0.50, 0.86',
        '       0.62  "Checkout later"  button  id=checkout-later  visible     at 0.50, 0.93',
        '       0.41  "Checkout"        button  id=checkout-cta    off-screen  at 0.50, 1.34',
        "     screen: 47 elements, 390x844",
        "     hint: the closest match differs only by a space — fix the step's text, or add `loose: true`",
        "     screenshot: flow-artifacts/checkout/step-03-screen.png",
        "     tree: flow-artifacts/checkout/step-03-tree.txt",
      ].join("\n")
    );
  });

  it("sits between the step list and the verdict in the buffered report", () => {
    const out = renderReport(mkReport(CHECKOUT_STEPS, { device: "SIM-1" }));
    const lines = out.split("\n");
    // The verdict is still the very last line — a CI log tail must not end on
    // a candidate table.
    expect(lines.at(-1)).toBe("FAIL — 2 passed, 1 failed, 0 errored, 1 skipped");
    expect(lines.indexOf('  ·  4 await visible "Order placed"')).toBeLessThan(
      lines.indexOf("Failures:")
    );
    expect(lines.indexOf("Failures:")).toBeLessThan(lines.length - 1);
  });

  it("renders nothing when no step carries a failure", () => {
    // ok:false does NOT imply a failing step: a cancelled run fails the verdict
    // with every step pass/skip and no failure object anywhere.
    const cancelled = mkReport(
      [
        { index: 0, kind: "launch", status: "pass" },
        { index: 1, kind: "tap", status: "skip", reason: "run aborted" },
      ],
      { ok: false, aborted: true }
    );
    expect(renderFailures(cancelled)).toEqual([]);
    expect(renderReport(cancelled)).not.toContain("Failures:");
    expect(renderReport(cancelled)).toContain("FAIL (run cancelled)");
  });

  it("swaps candidates for expected/actual on a text mismatch", () => {
    const out = renderFailures(
      failingReport({
        code: "text-mismatch",
        category: "assertion",
        determinacy: "determinate",
        message: 'expected "$42.00" but read "Total $41.50"',
        step: { kind: "assert", flow: "checkout" },
        expected: { kind: "condition", condition: "text", text: "$42.00", textMatch: "equals" },
        actual: { text: "Total $41.50", element: node({ role: "text", label: "Total $41.50" }) },
        screen: { state: "available", capturedAt: "at-failure", elementCount: 31, elements: [] },
        candidates: [],
        candidateCount: 0,
        screenshot: "flow-artifacts/checkout/step-03-screen.png",
      })
    ).join("\n");
    expect(out).toContain('     expected: "$42.00" (equals)');
    expect(out).toContain('     actual: "Total $41.50"');
    expect(out).toContain("     screen: 31 elements");
    expect(out).not.toContain("candidates:");
    // The reading is already on the `actual:` line; a `match:` row of the same
    // element would just repeat it.
    expect(out).not.toContain("     match: ");
  });

  it("swaps candidates for a single match row when a hidden assertion stayed visible", () => {
    const out = renderFailures(
      failingReport({
        code: "assert-hidden-unmet",
        category: "assertion",
        determinacy: "determinate",
        message: 'element matching text="Loading" was still visible after 5.0s',
        step: { kind: "assert", flow: "checkout" },
        expected: { kind: "condition", condition: "hidden", timeoutMs: 5000 },
        actual: {
          matchCount: 1,
          visibleMatchCount: 1,
          element: {
            role: "progressbar",
            label: "Loading…",
            identifier: "spinner",
            frame: { x: 0.4, y: 0.48, width: 0.2, height: 0.04 },
          },
        },
        screen: { state: "available", capturedAt: "at-failure", elementCount: 12, elements: [] },
        candidates: [],
        candidateCount: 0,
      })
    ).join("\n");
    expect(out).toContain("     expected: hidden");
    expect(out).toContain(
      '     match: "Loading…"  progressbar  id=spinner  visible  at 0.50, 0.50'
    );
    expect(out).not.toContain("candidates:");
  });

  it("prints a snapshot diff's three roles and no screenshot line", () => {
    const out = renderFailures(
      failingReport(
        {
          code: "snapshot-diff",
          category: "snapshot",
          determinacy: "determinate",
          message: "diff 2.10% > 1%",
          step: { kind: "snapshot", flow: "checkout" },
          expected: { kind: "snapshot", snapshotKey: "home__ios-390x844", maxMismatch: 1 },
          actual: { mismatchPercentage: 2.1 },
          screen: { state: "available", capturedAt: "at-failure", elementCount: 47, elements: [] },
          candidates: [],
          candidateCount: 0,
          // Even if a server does attach one, `current` wins: it is the frame
          // that was actually diffed.
          screenshot: "flow-artifacts/checkout/step-03-screen.png",
        },
        {
          kind: "snapshot",
          artifacts: {
            baseline: "flow-artifacts/checkout/home__ios-390x844-baseline.png",
            current: "flow-artifacts/checkout/home__ios-390x844-current.png",
            diff: "flow-artifacts/checkout/home__ios-390x844-diff.png",
          },
        }
      )
    ).join("\n");
    expect(out).toContain("     expected: snapshot home__ios-390x844 (max 1% mismatch)");
    expect(out).toContain("     actual: 2.10% differs");
    expect(out).toContain("     baseline: flow-artifacts/checkout/home__ios-390x844-baseline.png");
    expect(out).toContain("     current: flow-artifacts/checkout/home__ios-390x844-current.png");
    expect(out).toContain("     diff: flow-artifacts/checkout/home__ios-390x844-diff.png");
    // `current` IS the screenshot; a second capture would show a different
    // screen than the one that was diffed.
    expect(out).not.toContain("screenshot:");
  });

  it("replaces screen/tree with the device on a launch failure, and says the shot is missing", () => {
    const out = renderFailures(
      failingReport({
        code: "launch-failed",
        category: "launch",
        determinacy: "determinate",
        message: "com.acme.shop did not start within 30s",
        step: { kind: "launch", flow: "checkout" },
        screen: { state: "unavailable", reason: "never-readable" },
        candidates: [],
        candidateCount: 0,
        data: { platform: "ios" },
        timing: { startedAt: 1, durationMs: 30000 },
      })
    ).join("\n");
    expect(out).toContain("     device: UDID-1 (ios)");
    // The evidence itself is what failed — there is no screen and no tree.
    expect(out).not.toContain("screen:");
    expect(out).not.toContain("tree:");
    // Silence would read as "argent forgot"; the absence is the information.
    expect(out).toContain("     screenshot: (unavailable — the device did not return an image)");
  });

  it("names the flow file the CLI actually ran, not one derived from the name", () => {
    // `.argent/flows/<name>.yaml` is a guess that is WRONG for both documented
    // invocations that don't live there: an out-of-tree flow, and every nested
    // flow of a recursive directory run.
    const failure: FlowStepFailure = {
      code: "selector-not-found",
      category: "selector",
      determinacy: "determinate",
      message: 'no element matched selector id="cta"',
      step: { kind: "assert", flow: "checkout" },
      screen: { state: "available", source: "ax", capturedAt: "at-failure", elementCount: 3 },
      candidates: [],
      candidateCount: 0,
      timing: { startedAt: 1, durationMs: 1000 },
    };
    const resolved = "/home/me/shared-flows/checkout.yaml";

    expect(renderFailures(failingReport(failure), resolved).join("\n")).toContain(`@ ${resolved}`);
    // With no resolved path the derived guess still stands in.
    expect(renderFailures(failingReport(failure)).join("\n")).toContain(
      "@ .argent/flows/checkout.yaml"
    );
  });

  it("keeps the derived path for a step from a NESTED flow", () => {
    // The caller's resolved path is the ROOT flow's file; a fragment's step
    // names a different one the CLI has no way to know. The producer sets the
    // fragment's name on BOTH the step report and `failure.step`, so the
    // fixture must too — an earlier version set only the latter, which no real
    // tool-server emits, and that made this assertion pass for the wrong
    // reason while the guard it was pinning was a tautology.
    const out = renderFailures(
      failingReport(
        {
          code: "selector-not-found",
          category: "selector",
          determinacy: "determinate",
          message: 'no element matched selector id="cta"',
          step: { kind: "assert", flow: "login" },
          screen: { state: "available", source: "ax", capturedAt: "at-failure", elementCount: 3 },
          candidates: [],
          candidateCount: 0,
          timing: { startedAt: 1, durationMs: 1000 },
        },
        { flow: "login" }
      ),
      "/home/me/shared-flows/checkout.yaml"
    ).join("\n");
    expect(out).toContain("@ .argent/flows/login.yaml");
    expect(out).not.toContain("shared-flows");
  });

  it("infers determinacy and environmental from the code on a pre-determinacy server", () => {
    // The ONE place a code STRING drives renderer behaviour rather than being
    // printed verbatim: an older tool-server sends no `determinacy` and no
    // `category`, so the prefixes have to carry it. Everywhere else the code is
    // opaque, which is why an unknown one degrades to prose rather than to a
    // blank line (see the hostile-wire-data case).
    const bare = (code: string): string =>
      renderFailures(
        failingReport({
          code,
          message: "something went wrong",
          step: { kind: "assert", flow: "checkout" },
          screen: { state: "unavailable", reason: "never-readable" },
          candidates: [],
          candidateCount: 0,
          timing: { startedAt: 1, durationMs: 1000 },
        } as unknown as FlowStepFailure)
      ).join("\n");

    // Indeterminate prefixes earn the "not a failed assertion" hint...
    for (const code of [
      "condition-dark-tail",
      "when-guard-indeterminate",
      "tree-source-not-ready",
    ]) {
      expect(bare(code), code).toContain("not a failed assertion");
    }
    // ...and a determinate one does not.
    expect(bare("selector-not-found")).not.toContain("not a failed assertion");
    // Environmental prefixes give their screen slot to `device:` instead.
    expect(bare("launch-failed")).toContain("device: UDID-1");
    expect(bare("launch-failed")).not.toContain("screen:");
    expect(bare("selector-not-found")).toContain("screen:");
  });

  it("shows the zero-area element that IS the selector-not-visible diagnosis", () => {
    // `invisibleMatches` reaches no other surface, so without this the one
    // shape whose fix is "find out why it has no size" rendered with no
    // element at all — and its candidate list is deliberately empty, because
    // the operator did not mean a different element.
    const out = renderFailures(
      failingReport({
        code: "selector-not-visible",
        category: "selector",
        determinacy: "determinate",
        message: 'element matched id="cta" but its frame has zero area',
        step: { kind: "assert", flow: "checkout" },
        actual: {
          matchCount: 1,
          visibleMatchCount: 0,
          invisibleMatches: [
            {
              role: "button",
              label: "Check out",
              identifier: "cta",
              frame: { x: 0.5, y: 0.5, width: 0, height: 0 },
            },
          ],
        },
        screen: { state: "available", source: "ax", capturedAt: "at-failure", elementCount: 8 },
        candidates: [],
        candidateCount: 0,
        timing: { startedAt: 1, durationMs: 1000 },
      } as unknown as FlowStepFailure)
    ).join("\n");

    // Visibility is DERIVED from the frame, never taken from wire prose.
    expect(out).toContain('match: "Check out"  button  id=cta  hidden  at 0.50, 0.50');
  });

  it("keeps a tree-source cause visible on an environmental failure", () => {
    // The environmental shapes give their screen slot to `device:` — except
    // when the screen carries a DETAIL, which for the tree-source codes is the
    // only statement of why the step failed (the message is generic selector
    // prose). Suppressing the slot wholesale deleted the cause.
    const out = renderFailures(
      failingReport({
        code: "tree-source-unavailable",
        category: "environment",
        determinacy: "indeterminate",
        message: 'no element matched selector id="cta"',
        step: { kind: "assert", flow: "checkout" },
        screen: {
          state: "unavailable",
          reason: "never-readable",
          detail: "native devtools disconnected",
        },
        candidates: [],
        candidateCount: 0,
        data: { platform: "ios" },
        timing: { startedAt: 1, durationMs: 1000 },
      })
    ).join("\n");

    expect(out).toContain("screen: unavailable — never-readable: native devtools disconnected");
    expect(out).toContain("device: UDID-1 (ios)");
  });

  it("marks a post-hoc screen read, and a last-trusted one, for what they are", () => {
    const base = {
      code: "selector-not-found",
      category: "selector",
      message: "nope",
      step: { kind: "assert", flow: "checkout" },
      candidates: [],
      candidateCount: 0,
      timing: { startedAt: 1, durationMs: 1000 },
    };

    const after = renderFailures(
      failingReport({
        ...base,
        determinacy: "determinate",
        screen: { state: "available", source: "ax", capturedAt: "after-failure", elementCount: 8 },
      } as unknown as FlowStepFailure)
    ).join("\n");
    expect(after).toContain("screen: 8 elements (captured after the failure)");

    // An indeterminate failure's tree is by definition the last read argent
    // could trust, not the state at the deadline.
    const trusted = renderFailures(
      failingReport({
        ...base,
        code: "condition-dark-tail",
        category: "indeterminate",
        determinacy: "indeterminate",
        screen: { state: "available", source: "ax", capturedAt: "at-failure", elementCount: 8 },
      } as unknown as FlowStepFailure)
    ).join("\n");
    expect(trusted).toContain("screen: 8 elements (last trusted read)");
  });

  it("renders the scroll expectation and a candidate's paste-able selector", () => {
    const out = renderFailures(
      failingReport({
        code: "scroll-target-not-found",
        category: "scroll",
        determinacy: "determinate",
        message: "reached the end of the scroll",
        step: { kind: "scroll-to", flow: "checkout" },
        expected: { kind: "scroll", direction: "down", within: 'id="list"', maxIterations: 12 },
        screen: { state: "available", source: "ax", capturedAt: "at-failure", elementCount: 8 },
        candidates: [
          {
            node: {
              role: "button",
              label: "Order #1234",
              identifier: "order-1234",
              frame: { x: 0.1, y: 0.4, width: 0.8, height: 0.06 },
            },
            score: 0.87,
            basis: "text-near",
            selectorYaml: '{"id":"order-1234"}',
            note: "scrolled out of its container — add a scroll-to step",
          },
        ],
        candidateCount: 3,
        timing: { startedAt: 1, durationMs: 1000 },
      } as unknown as FlowStepFailure)
    ).join("\n");

    expect(out).toContain('expected: scroll down within id="list" (max 12 iterations)');
    // The suggestion is the headline output of ranking — it belongs on the CI
    // surface, not only on the MCP one.
    expect(out).toContain('→ {"id":"order-1234"}');
    expect(out).toContain("— scrolled out of its container");
  });

  it("says WHY there is no screenshot when the run typed a secret", () => {
    // Pixels are the one projection the report's scrubber cannot reach, so the
    // capture is declined outright. A silently missing line reads as a broken
    // capture and invites the reader to take the shot themselves.
    const out = renderFailures(
      failingReport({
        code: "selector-not-found",
        category: "selector",
        determinacy: "determinate",
        message: 'no element matched selector id="order-confirmation"',
        step: { kind: "assert", flow: "checkout" },
        screen: {
          state: "available",
          source: "chromium",
          capturedAt: "at-failure",
          elementCount: 3,
        },
        candidates: [],
        candidateCount: 0,
        data: { platform: "chromium", screenshotOmitted: "secret-typed" },
        timing: { startedAt: 1, durationMs: 1000 },
      })
    ).join("\n");
    expect(out).toContain(
      "     screenshot: (omitted — this run typed a secret, and a capture of this screen could reveal it)"
    );
  });

  it("marks an indeterminate failure as unreadable, not as a failed assertion", () => {
    const out = renderFailures(
      failingReport({
        code: "condition-never-readable",
        category: "indeterminate",
        determinacy: "indeterminate",
        message: 'could not evaluate visible "Order placed" — no trusted read in 5.0s',
        step: { kind: "assert", flow: "checkout" },
        screen: {
          state: "available",
          capturedAt: "at-failure",
          elementCount: 12,
          elements: [],
          size: { width: 390, height: 844 },
        },
        candidates: [],
        candidateCount: 0,
        timing: {
          startedAt: 1,
          durationMs: 5000,
          attempts: 21,
          trustedAttempts: 14,
          darkTailMs: 3200,
        },
      })
    ).join("\n");
    expect(out).toContain("     screen: 12 elements, 390x844 (last trusted read)");
    expect(out).toContain(
      "     reads: 21 attempted, 14 trusted, last trusted 3.2s before the deadline"
    );
    expect(out).toContain(
      "     hint: not a failed assertion — argent could not read the screen; re-run or fix the device/tree source rather than editing the flow"
    );
    // No new glyph: the status is still `fail`, and a glyph disagreeing with
    // the counters would desync three surfaces.
    expect(out).not.toContain("?");
  });

  it("emits only the mandatory line when a failure fills no other slot", () => {
    const out = renderFailures(
      mkReport([
        {
          index: 0,
          kind: "tap",
          status: "fail",
          target: '"Go"',
          reason: "something went wrong",
          failure: {
            code: "unclassified",
            message: "something went wrong",
            candidates: [],
            candidateCount: 0,
          },
        },
      ])
    );
    expect(out).toEqual([
      "",
      "Failures:",
      "",
      '  1) tap "Go"  @ .argent/flows/checkout.yaml',
      "     unclassified: something went wrong",
      "     context:",
      '       ✗  1 tap "Go"',
    ]);
  });

  it("windows the context to the failing step plus two, with the echo that introduces them", () => {
    const steps: StepReport[] = [
      { index: 0, kind: "echo", status: "pass", message: "first block" },
      { index: 1, kind: "tap", status: "pass", target: '"A"' },
      { index: 2, kind: "tap", status: "pass", target: '"B"' },
      { index: 3, kind: "echo", status: "pass", message: "second block" },
      { index: 4, kind: "tap", status: "pass", target: '"C"' },
      { index: 5, kind: "tap", status: "pass", target: '"D"' },
      {
        index: 6,
        kind: "tap",
        status: "fail",
        target: '"E"',
        reason: "nope",
        failure: {
          code: "selector-not-found",
          message: "nope",
          candidates: [],
          candidateCount: 0,
        },
      },
    ];
    const out = renderFailures(mkReport(steps)).join("\n");
    expect(out).toContain(
      [
        "     context:",
        "       › second block",
        '       ✓  3 tap "C"',
        '       ✓  4 tap "D"',
        '       ✗  5 tap "E"',
      ].join("\n")
    );
    // Steps outside the window, and the narration that belongs to them, stay out.
    expect(out).not.toContain("first block");
    expect(out).not.toContain('tap "B"');
  });
});

describe("renderFailures with hostile wire data", () => {
  it("clamps counts, lengths and scores instead of throwing or exploding", () => {
    const hostile = {
      code: "x".repeat(1000),
      message: "m".repeat(1024 * 1024),
      determinacy: "sideways",
      category: 42,
      hint: { not: "a string" },
      step: { flow: "../../etc/passwd", source: { file: 12, line: -1e9 } },
      selector: { described: 7 },
      screen: {
        state: "available",
        elementCount: Number.NaN,
        elements: Array.from({ length: 5000 }, () => ({ role: "cell" })),
        size: { width: 1e300, height: -5 },
      },
      candidates: Array.from({ length: 10000 }, (_, i) => ({
        score: i === 0 ? Number.NaN : 1e9,
        node: {
          role: "b".repeat(500),
          label: "l".repeat(5000),
          identifier: "i".repeat(5000),
          frame: { x: 0, y: 0, width: 1, height: 1 },
        },
      })),
      candidateCount: -1,
      screenshot: { __argentArtifact: true, filename: "shot.png" },
      tree: 999,
      timing: { attempts: -3, darkTailMs: "soon" },
    } as unknown as FlowStepFailure;

    const lines = renderFailures(
      mkReport([
        { index: 0, kind: "tap", status: "fail", target: '"Go"', reason: "x", failure: hostile },
      ])
    );
    const out = lines.join("\n");

    // Every rendered string is bounded, and no line runs away.
    for (const line of lines) expect(line.length).toBeLessThan(2000);
    // The candidate list is capped at five rows regardless of what arrived —
    // a 10 000-entry array is sliced before it is ever walked.
    expect(lines.filter((l) => l.includes("id=i"))).toHaveLength(5);
    // A NaN score is dropped rather than printed; an out-of-range one clamps.
    expect(out).not.toContain("NaN");
    expect(out).toContain("1.00");
    // A traversing flow name never becomes a printed path.
    expect(out).not.toContain("etc/passwd");
    expect(out).not.toContain(" @ ");
    // A non-string screenshot/tree contributes no line; a handle still resolves.
    expect(out).toContain("screenshot: shot.png");
    expect(out).not.toContain("tree:");
    // An unknown determinacy is not indeterminate, so no reads line and no
    // "could not read the screen" claim.
    expect(out).not.toContain("reads:");
    expect(out).not.toContain("not a failed assertion");
  });

  it("survives a failure that is not an object at all", () => {
    for (const junk of [null, 0, "boom", [], true]) {
      const report = mkReport([
        {
          index: 0,
          kind: "tap",
          status: "fail",
          reason: "x",
          failure: junk as unknown as FlowStepFailure,
        },
      ]);
      expect(() => renderFailures(report)).not.toThrow();
    }
  });
});

describe("wire compatibility", () => {
  it("renders a report with no failure and no durationMs byte-identically to today", () => {
    // The whole back-compat gate: an older tool-server sends neither field, and
    // its output must match the historical pin character for character.
    expect(renderReport(mkReport(STEPS))).toBe(
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
    expect(renderFailures(mkReport(STEPS))).toEqual([]);
  });
});
