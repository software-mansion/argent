import { describe, it, expect } from "vitest";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import type { MemoryLeak, ProfilerPayload } from "../../src/utils/ios-profiler/types";

// traceFile: null → no report file is written (pure, side-effect-free render),
// so we can assert the markdown directly. Attribution is driven by the leak's
// `attributed` flag (set in the pipeline via isLeakAttributed): captures via
// `xctrace --attach` have no malloc-stack history, so a leak with no resolved
// responsible frame comes back unattributed and is demoted to a low-confidence
// note rather than listed like a real app bug.

function leak(attributed: boolean, frame: string, library = ""): MemoryLeak {
  return {
    type: "memory_leak",
    platform: "ios",
    objectType: "Malloc 1008 Bytes",
    totalSizeBytes: 1008,
    count: 1,
    responsibleFrame: frame,
    responsibleLibrary: library,
    attributed,
    severity: attributed ? "RED" : "YELLOW",
  };
}

function payload(leaks: MemoryLeak[]): ProfilerPayload {
  return {
    metadata: { traceFile: null, platform: "iOS", timestamp: "2026-06-16T00:00:00Z" },
    bottlenecks: leaks,
  };
}

describe("leak attribution rendering", () => {
  it("collapses unattributed leaks into a low-confidence note pointing at malloc stack logging", async () => {
    const res = await renderNativeProfilerReport({
      payload: payload([leak(false, "<Call stack limit reached>")]),
      traceFile: null,
    });
    expect(res.report).toContain("unattributed leak group");
    expect(res.report).toContain("malloc stack logging enabled at launch");
  });

  it("does not advise re-running with malloc when the capture already attributed some leaks", async () => {
    // A capture with BOTH attributed and unattributed leaks was clearly run under
    // malloc stack logging (the only way a frame is recorded). The unattributed note
    // must NOT tell the user to "capture with malloc stack logging enabled" — the
    // thing they just did — and should instead frame the remainder as pre-existing.
    const res = await renderNativeProfilerReport({
      payload: payload([
        leak(true, "hermes::vm::JSTypedArrayBase::createBuffer(...)", "hermes"),
        leak(false, "<Call stack limit reached>"),
      ]),
      traceFile: null,
    });
    expect(res.report).toContain("unattributed leak group");
    expect(res.report).not.toContain("capture with malloc stack logging enabled at launch");
    expect(res.report).toContain("malloc stack logging was active");
  });

  it("names the malloc capture — never --attach — when malloc_stack_logging was on but nothing attributed", async () => {
    // The one case the attributed-count inference gets wrong: a capture that ran
    // with malloc_stack_logging: true yet attributed nothing (short capture,
    // freed-region reuse, system-lib leaks). With the capture mode threaded in
    // explicitly, the note must not claim the capture used `--attach` and must
    // not advise enabling the flag the user just used.
    const res = await renderNativeProfilerReport({
      payload: payload([leak(false, "<Call stack limit reached>")]),
      traceFile: null,
      mallocStackLogging: true,
    });
    expect(res.report).toContain("unattributed leak group");
    expect(res.report).not.toContain("--attach");
    expect(res.report).not.toContain("stack logging enabled at launch");
    expect(res.report).toContain("ran with malloc stack logging enabled");
  });

  it("attribution evidence outranks an explicit attach flag", async () => {
    // A responsible frame exists ONLY if the target process ran under malloc
    // stack logging — even when argent itself attached (the app can be launched
    // with the diagnostic externally, e.g. an Xcode scheme). An attributed
    // table above a "no malloc-stack history" note would contradict itself, so
    // attributed>0 must win over mallocStackLogging: false.
    const res = await renderNativeProfilerReport({
      payload: payload([
        leak(true, "hermes::vm::JSTypedArrayBase::createBuffer(...)", "hermes"),
        leak(false, "<Call stack limit reached>"),
      ]),
      traceFile: null,
      mallocStackLogging: false,
    });
    expect(res.report).toContain("malloc stack logging was active");
    expect(res.report).not.toContain("--attach");
    expect(res.report).not.toContain("stack logging enabled at launch");
  });

  it("keeps the --attach hint when the capture mode is explicitly attach", async () => {
    const res = await renderNativeProfilerReport({
      payload: payload([leak(false, "<Call stack limit reached>")]),
      traceFile: null,
      mallocStackLogging: false,
    });
    expect(res.report).toContain("unattributed leak group");
    expect(res.report).toContain("xctrace --attach");
    expect(res.report).toContain("malloc stack logging enabled at launch");
  });

  it("falls back to the attributed-count inference when the capture mode is unknown", async () => {
    // Sessions restored from disk (profiler-load) have no capture-mode sidecar:
    // mallocStackLogging is null and the renderer infers the mode the old way —
    // attributed leaks present ⇒ malloc logging must have been on.
    const res = await renderNativeProfilerReport({
      payload: payload([
        leak(true, "hermes::vm::JSTypedArrayBase::createBuffer(...)", "hermes"),
        leak(false, "<Call stack limit reached>"),
      ]),
      traceFile: null,
      mallocStackLogging: null,
    });
    expect(res.report).toContain("malloc stack logging was active");
    expect(res.report).not.toContain("stack logging enabled at launch");
  });

  it("does not surface an unattributed leak as an attributed one", async () => {
    // Use a real classifier sentinel ("" → isLeakAttributed === false) so the
    // fixture's attributed:false matches what the pipeline would actually assign;
    // a non-sentinel frame like "(null)" classifies as attributed (RED).
    const res = await renderNativeProfilerReport({
      payload: payload([leak(false, "")]),
      traceFile: null,
    });
    expect(res.report).toContain("No attributed leaks");
  });

  it("escapes '|' in leak table cells so demangled operator frames can't break the row", async () => {
    // GFM splits table cells on unescaped pipes even inside code spans. A
    // demangled C++ frame like `operator|` was unreachable in argent's own
    // captures before malloc_stack_logging (attach mode never attributed), so
    // the leak table must escape it now that real frames are the headline.
    const frame = "folly::operator|(folly::Range<char const*>, folly::Range<char const*>)";
    const res = await renderNativeProfilerReport({
      payload: payload([leak(true, frame, "folly")]),
      traceFile: null,
    });
    const header = res.report.split("\n").find((l) => l.includes("| # | Object Type"));
    const row = res.report.split("\n").find((l) => l.includes("folly::operator"));
    expect(row).toBeDefined();
    expect(row).toContain("operator\\|");
    // Splitting on unescaped pipes yields the same cell count as the header —
    // the row's columns stay aligned.
    const unescapedPipes = (s: string) => s.split(/(?<!\\)\|/).length;
    expect(unescapedPipes(row!)).toBe(unescapedPipes(header!));
  });

  it("shows the real frame + library for an attributed leak", async () => {
    const frame = "hermes::vm::JSTypedArrayBase::createBuffer(...)";
    const res = await renderNativeProfilerReport({
      payload: payload([leak(true, frame, "hermes")]),
      traceFile: null,
    });
    expect(res.report).toContain(frame);
    expect(res.report).toContain("hermes");
    expect(res.report).not.toContain("unattributed leak group");
  });
});
