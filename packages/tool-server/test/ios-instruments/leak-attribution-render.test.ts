import { describe, it, expect } from "vitest";
import { renderNativeProfilerReport } from "../../src/utils/ios-profiler/render";
import type { MemoryLeak, ProfilerPayload } from "../../src/utils/ios-profiler/types";

// traceFile: null → no report file is written (pure, side-effect-free render),
// so we can assert the markdown directly.

function leak(frame: string, library = ""): MemoryLeak {
  return {
    type: "memory_leak",
    platform: "ios",
    objectType: "Malloc 1008 Bytes",
    totalSizeBytes: 1008,
    count: 1,
    responsibleFrame: frame,
    responsibleLibrary: library,
    severity: "RED",
  };
}

function payload(leaks: MemoryLeak[]): ProfilerPayload {
  return {
    metadata: { traceFile: null, platform: "iOS", timestamp: "2026-06-16T00:00:00Z" },
    bottlenecks: leaks,
  };
}

describe("leak attribution rendering", () => {
  it("flags unattributable leaks and points at malloc_stack_logging", async () => {
    const res = await renderNativeProfilerReport({
      payload: payload([leak("<Call stack limit reached>")]),
      traceFile: null,
    });
    expect(res.report).toContain("no allocation stack");
    expect(res.report).toContain("malloc_stack_logging: true");
  });

  it("treats (null) as unattributable too", async () => {
    const res = await renderNativeProfilerReport({
      payload: payload([leak("(null)", "(null)")]),
      traceFile: null,
    });
    expect(res.report).toContain("no allocation stack");
  });

  it("shows the real frame + library for an attributed leak", async () => {
    const frame = "hermes::vm::JSTypedArrayBase::createBuffer(...)";
    const res = await renderNativeProfilerReport({
      payload: payload([leak(frame, "hermes")]),
      traceFile: null,
    });
    expect(res.report).toContain(frame);
    expect(res.report).toContain("hermes");
    expect(res.report).not.toContain("no allocation stack");
  });
});
