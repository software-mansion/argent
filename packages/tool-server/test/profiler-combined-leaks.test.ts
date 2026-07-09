/**
 * Combined-report leak honesty.
 *
 * The combined report (React × native cross-correlation) must apply the SAME
 * attribution split as the standalone iOS analyze report: unattributed leaks
 * (`<Call stack limit reached>` under `xctrace --attach`) are benign system
 * noise and must NOT be rendered as ordinary per-leak rows. They are collapsed
 * into a single low-confidence YELLOW caveat; only attributed leaks (with a
 * resolved responsible frame) appear individually.
 *
 * Regression guard for the flat "wall of leaks" the combined report used to
 * emit, which contradicted the analyze report and masqueraded benign
 * allocations as confirmed app leaks.
 */
import { describe, it, expect } from "vitest";
import { renderCombinedMemoryLeaks } from "../src/tools/profiler/combined/profiler-combined-report";
import type { MemoryLeak } from "../src/utils/profiler-shared/types";

function leak(partial: Partial<MemoryLeak> & Pick<MemoryLeak, "objectType">): MemoryLeak {
  const attributed = partial.attributed ?? false;
  return {
    type: "memory_leak",
    platform: "ios",
    objectType: partial.objectType,
    totalSizeBytes: partial.totalSizeBytes ?? 16,
    count: partial.count ?? 1,
    responsibleFrame: partial.responsibleFrame ?? "<Call stack limit reached>",
    responsibleLibrary: partial.responsibleLibrary ?? "",
    attributed,
    severity: partial.severity ?? (attributed ? "RED" : "YELLOW"),
  };
}

const ATTRIBUTED = leak({
  objectType: "MyModel",
  totalSizeBytes: 384,
  count: 3,
  responsibleFrame: "-[MyViewController loadData]",
  responsibleLibrary: "MyApp",
  attributed: true,
  severity: "RED",
});

const UNATTRIBUTED = leak({
  objectType: "dispatch_mach_msg_t",
  totalSizeBytes: 1024,
  count: 2,
  responsibleFrame: "<Call stack limit reached>",
  attributed: false,
  severity: "YELLOW",
});

describe("renderCombinedMemoryLeaks", () => {
  it("collapses an unattributed leak group into a YELLOW caveat — never a per-leak row", () => {
    const out = renderCombinedMemoryLeaks([UNATTRIBUTED], new Set()).join("\n");

    // It must NOT render the unattributed leak as a normal leak-table row.
    expect(out).not.toContain("**`dispatch_mach_msg_t`**");

    // Instead it shows the single low-confidence YELLOW caveat.
    expect(out).toContain("🟡");
    expect(out).toContain("1 unattributed leak group(s)");
    expect(out).toContain("`<Call stack limit reached>`");
    expect(out).toContain("benign system allocations rather than confirmed app leaks");

    // Nothing attributed → the capture was `--attach` (no malloc history), so the
    // hint DOES advise capturing with malloc stack logging.
    expect(out).toContain("capture with malloc");
    expect(out).toContain("stack logging enabled at launch");

    // With no attributed leaks, it says so explicitly.
    expect(out).toContain("No attributed leaks");
  });

  it("lists an attributed leak as its own row, with the unattributed ones still collapsed", () => {
    const out = renderCombinedMemoryLeaks([ATTRIBUTED, UNATTRIBUTED], new Set()).join("\n");

    // Attributed leak is listed individually.
    expect(out).toContain("**`MyModel`**");
    expect(out).toContain("-[MyViewController loadData]");

    // Unattributed leak is collapsed, not a per-leak row.
    expect(out).not.toContain("**`dispatch_mach_msg_t`**");
    expect(out).toContain("🟡");
    expect(out).toContain("1 unattributed leak group(s)");

    // Attributed + unattributed leaks coexist ONLY when malloc stack logging was
    // active, so the caveat must NOT tell the user to enable the thing they just
    // used. It names the active malloc capture and drops the "capture with malloc
    // stack logging enabled at launch" advice.
    expect(out).toContain("malloc stack logging was active");
    expect(out).not.toContain("capture with malloc");
    expect(out).not.toContain("stack logging enabled at launch");

    // No "no attributed leaks" line when an attributed leak exists.
    expect(out).not.toContain("No attributed leaks");
  });

  it("names the malloc capture — never --attach — when malloc_stack_logging was on but nothing attributed", () => {
    // Same inference gap as render.ts: with the capture mode passed in
    // explicitly, a malloc capture that attributed nothing must not get the
    // `--attach` framing or the advice to enable the flag that was already on.
    const out = renderCombinedMemoryLeaks([UNATTRIBUTED], new Set(), true).join("\n");

    expect(out).toContain("1 unattributed leak group(s)");
    expect(out).not.toContain("--attach");
    expect(out).not.toContain("stack logging enabled at launch");
    expect(out).toContain("ran with malloc stack logging enabled");
  });

  it("renders the identical caveat line as the analyze report (shared helper, no drift)", async () => {
    // The hint block used to be a verbatim copy in render.ts and here, kept in
    // sync by hand. Both now delegate to one helper — pin that the emitted
    // caveat line is byte-identical so a wording change can't silently diverge.
    const { renderNativeProfilerReport } = await import("../src/utils/ios-profiler/render");
    const combinedLine = renderCombinedMemoryLeaks([UNATTRIBUTED], new Set(), true)
      .join("\n")
      .split("\n")
      .find((l) => l.includes("unattributed leak group"));
    const res = await renderNativeProfilerReport({
      payload: {
        metadata: { traceFile: null, platform: "iOS", timestamp: "2026-06-16T00:00:00Z" },
        bottlenecks: [UNATTRIBUTED],
      },
      traceFile: null,
      mallocStackLogging: true,
    });
    const renderLine = res.report.split("\n").find((l) => l.includes("unattributed leak group"));
    expect(combinedLine).toBeDefined();
    expect(combinedLine).toBe(renderLine);
  });

  it("ties an attributed leak to a recently-mounted React component when names overlap", () => {
    const out = renderCombinedMemoryLeaks([ATTRIBUTED], new Set(["MyModel"])).join("\n");
    expect(out).toContain("may relate to `MyModel` mount/unmount");
  });

  it("lists ALL attributed leaks individually — no cap — matching the analyze report", () => {
    // 12 distinct attributed (RED) leaks: more than the old hardcoded cap of 10.
    const attributed = Array.from({ length: 12 }, (_, i) =>
      leak({
        objectType: `LeakModel${i}`,
        totalSizeBytes: 128 + i,
        count: i + 1,
        responsibleFrame: `-[Leaker${i} retainSomething]`,
        responsibleLibrary: "MyApp",
        attributed: true,
        severity: "RED",
      })
    );

    const out = renderCombinedMemoryLeaks(attributed, new Set()).join("\n");

    // Every one of the 12 attributed leaks must be rendered as its own row.
    for (let i = 0; i < 12; i++) {
      expect(out).toContain(`**\`LeakModel${i}\`**`);
      expect(out).toContain(`-[Leaker${i} retainSomething]`);
    }
    // Count the rendered per-leak rows: exactly 12, not capped at 10.
    const rowCount = out.split("\n").filter((l) => /^- \*\*`LeakModel\d+`\*\*/.test(l)).length;
    expect(rowCount).toBe(12);
  });

  it("returns nothing for an empty leak list", () => {
    expect(renderCombinedMemoryLeaks([], new Set())).toEqual([]);
  });
});
