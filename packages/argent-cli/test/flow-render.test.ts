import { describe, it, expect } from "vitest";
import {
  renderReport,
  renderStepLine,
  renderEchoLine,
  renderSummary,
  renderArtifactLines,
  renderUnderStepLine,
  renderFailedSteps,
  renderBatchSummary,
  type FlowReport,
  type StepReport,
} from "../src/flow.js";

function mkReport(steps: StepReport[], overrides: Partial<FlowReport> = {}): FlowReport {
  // Mirror the runner's summarize(): neither echo narration nor a structural
  // block marker is a counted step.
  const counted = steps.filter((s) => s.kind !== "echo" && s.structural !== true);
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

/**
 * A `repeat: 2` block over one tap, as the tool-server reports it. The opening
 * marker carries the bound as its target and no reason: the block has not run,
 * so a reason could only restate the bound the target already gives.
 */
const REPEAT_STEPS: StepReport[] = [
  { index: 0, kind: "repeat", status: "pass", target: "2 times", structural: true },
  { index: 1, kind: "repeat", status: "pass", target: "iteration 1/2", depth: 1, structural: true },
  { index: 2, kind: "tap", status: "pass", target: '"Clear"', depth: 1 },
  { index: 3, kind: "repeat", status: "pass", target: "iteration 2/2", depth: 1, structural: true },
  { index: 4, kind: "tap", status: "pass", target: '"Clear"', depth: 1 },
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

  it("prints a repeat block's markers unnumbered, without shifting the sequence", () => {
    // The markers are block structure: they keep the glyph, the depth indent
    // and the label column so the shape reads, but take no step number — the
    // numbered lines are the two taps, matching the counts the server sends.
    const out = renderReport(mkReport(REPEAT_STEPS));
    expect(out).toBe(
      [
        'Flow "checkout" on UDID-1',
        "  ✓    repeat 2 times",
        "  ✓      repeat iteration 1/2",
        '  ✓  1   tap "Clear"',
        "  ✓      repeat iteration 2/2",
        '  ✓  2   tap "Clear"',
        "",
        "PASS — 2 passed, 0 failed, 0 errored, 0 skipped",
      ].join("\n")
    );
    // The unnumbered lines' labels sit in the same column as the numbered
    // ones' at the same depth — the block shape is the point of printing them.
    const lines = out.split("\n");
    expect(lines[2]!.indexOf("repeat")).toBe(lines[3]!.indexOf("tap"));
  });

  it("keeps a marker's label column aligned once numbering reaches three digits", () => {
    // A marker's blank spans the width of the NEXT number to be issued, so a
    // repeat block opening after step 99 lines up with its 3-digit body, not
    // the 2-digit step it trails. `repeat: 100` is legal and re-reports its
    // body each pass, so 100+ numbered steps is an easy report to produce.
    const steps: StepReport[] = [];
    for (let i = 0; i < 99; i++) {
      steps.push({ index: i, kind: "tap", status: "pass", target: '"Pad"' });
    }
    steps.push({ index: 99, kind: "repeat", status: "pass", target: "2 times", structural: true });
    steps.push({
      index: 100,
      kind: "repeat",
      status: "pass",
      target: "iteration 1/2",
      depth: 1,
      structural: true,
    });
    steps.push({ index: 101, kind: "tap", status: "pass", target: '"Clear"', depth: 1 });
    steps.push({ index: 102, kind: "tap", status: "pass", target: '"Done"' });

    const lines = renderReport(mkReport(steps)).split("\n");
    // lines[0] is the header; [1..99] are steps 1–99, [100] the block marker,
    // [101] the iteration marker, [102] step 100 (depth 1), [103] step 101.
    expect(lines[99]).toBe('  ✓ 99 tap "Pad"');
    expect(lines[100]).toBe("  ✓     repeat 2 times");
    expect(lines[102]).toBe('  ✓ 100   tap "Clear"');
    // Each marker's label shares a column with the 3-digit numbered line at
    // its own depth — the alignment the block shape depends on.
    expect(lines[100]!.indexOf("repeat")).toBe(lines[103]!.indexOf("tap"));
    expect(lines[101]!.indexOf("repeat")).toBe(lines[102]!.indexOf("tap"));
  });

  it("live step lines match the buffered renderer's for a repeat block", () => {
    const report = mkReport(REPEAT_STEPS);
    const buffered = renderReport(report).split("\n");

    // Reproduce the live loop: structural markers print unnumbered but carry
    // the running count (which sizes their blank), so the live sequence can't
    // drift from the buffered one.
    const live: string[] = [];
    let n = 0;
    for (const s of report.steps) {
      if (s.structural === true) {
        live.push(renderStepLine(s, { unnumbered: n }, report.flow));
        continue;
      }
      n++;
      live.push(renderStepLine(s, n, report.flow));
    }
    for (const line of live) expect(buffered).toContain(line);
  });

  it("numbers a line whose structural flag is not literally true", () => {
    // Wire data: a bogus value must not quietly pull a real step out of the
    // sequence — anything but `true` renders exactly as it did before the flag
    // existed (which is also what a pre-structural tool-server sends).
    const tap: StepReport = { index: 0, kind: "tap", status: "pass", target: '"A"' };
    expect(renderStepLine({ ...tap, structural: false }, 1, "f")).toBe('  ✓  1 tap "A"');
    const hostile = { ...tap, structural: "yes" } as unknown as StepReport;
    expect(renderReport(mkReport([hostile]))).toContain('  ✓  1 tap "A"');
  });

  it("renderArtifactLines numbers past a structural marker the same way", () => {
    const lines = renderArtifactLines(
      mkReport([
        { index: 0, kind: "repeat", status: "pass", target: "2 times", structural: true },
        {
          index: 1,
          kind: "snapshot",
          status: "fail",
          target: '"home"',
          artifacts: { diff: "/tmp/d.png" },
        },
      ])
    );
    // The snapshot is step 1: the marker consumed no number here either, or
    // the label would disagree with the step line it points at.
    expect(lines).toEqual(["  snapshot (step 1):", "       diff: /tmp/d.png"]);
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

  it("renderFailedSteps numbers past structural markers to match a single-mode rerun", () => {
    // A drain that hit its cap: the repeat block's markers plus the failing
    // verdict line the tool-server pushes at the enclosing depth — no target,
    // reason only, and NOT structural (the verdict is the block's assertion).
    const report = mkReport([
      ...REPEAT_STEPS,
      {
        index: 5,
        kind: "repeat",
        status: "fail",
        reason: 'still not hidden "Spinner" after 2 iterations (max)',
      },
    ]);
    const failed = renderFailedSteps(report);
    // Step 3: the two taps take 1 and 2, the three markers take none — the
    // sequence a single-mode rerun of the same flow prints. A walk that
    // counted the markers would say 6 (off by 1+N per entered block).
    expect(failed).toEqual(['  ✗  3 repeat — still not hidden "Spinner" after 2 iterations (max)']);
    // Pin the equivalence directly: the batch line must be byte-identical to
    // the line renderReport prints for the same report.
    expect(renderReport(report).split("\n")).toContain(failed[0]!);
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
