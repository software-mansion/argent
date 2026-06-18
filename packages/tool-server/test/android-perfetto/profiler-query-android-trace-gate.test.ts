import { describe, it, expect, vi, beforeEach } from "vitest";

// Both gates short-circuit BEFORE any .pftrace query, so the Android pipeline
// helpers are stubbed to throw: if a gate were missing, the tool would reach
// loadAndroidCombinedData / runAndroidStackQuery and we'd see that explosion
// instead of the expected "No Android trace loaded" error.
vi.mock("../../src/utils/android-profiler/pipeline/index", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/android-profiler/pipeline/index")>()),
  loadAndroidCombinedData: vi.fn(async () => {
    throw new Error("loadAndroidCombinedData should not be reached when the trace gate trips");
  }),
  runAndroidStackQuery: vi.fn(async () => {
    throw new Error("runAndroidStackQuery should not be reached when the trace gate trips");
  }),
}));

import { profilerStackQueryTool } from "../../src/tools/profiler/query/profiler-stack-query";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";
import type { NativeProfilerSessionApi } from "../../src/blueprints/native-profiler-session";

const DEVICE_ID = "emulator-5554";

// traceFile is set at native-profiler-start; exportedFiles.pftrace is only set
// once native-profiler-stop has exported the trace. A session that started but
// never stopped/analyzed therefore has traceFile WITHOUT exportedFiles.pftrace —
// the exact state both gates guard against (so the tools error clearly instead
// of rendering an empty "0 hangs" report off an unexported trace).
const startedButNotStopped: Partial<NativeProfilerSessionApi> = {
  platform: "android",
  traceFile: "/fake.pftrace",
  exportedFiles: undefined,
  appProcess: "com.example.app",
  wallClockStartMs: 1_700_000_000_000,
};

const GATE_MESSAGE =
  "No Android trace loaded. Run native-profiler-stop → native-profiler-analyze first.";

describe("profiler-combined-report Android trace gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws the trace-not-loaded error when exportedFiles.pftrace is absent (does not render an empty report)", async () => {
    await expect(
      profilerCombinedReportTool.execute({ nativeSession: startedButNotStopped } as never, {
        port: 8081,
        device_id: DEVICE_ID,
      })
    ).rejects.toThrow(GATE_MESSAGE);
  });
});

describe("profiler-stack-query Android trace gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // thread_breakdown is a non-leak Android mode, so it would normally fall
  // through to runAndroidStackQuery — the gate at executeAndroid must trip first.
  it("throws the trace-not-loaded error for thread_breakdown when exportedFiles.pftrace is absent", async () => {
    await expect(
      profilerStackQueryTool.execute({ session: startedButNotStopped } as never, {
        device_id: DEVICE_ID,
        mode: "thread_breakdown",
        top_n: 15,
      })
    ).rejects.toThrow(GATE_MESSAGE);
  });

  it("also gates leak_stacks (which would otherwise short-circuit to the iOS-only message)", async () => {
    await expect(
      profilerStackQueryTool.execute({ session: startedButNotStopped } as never, {
        device_id: DEVICE_ID,
        mode: "leak_stacks",
        top_n: 15,
      })
    ).rejects.toThrow(GATE_MESSAGE);
  });
});
