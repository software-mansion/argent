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
