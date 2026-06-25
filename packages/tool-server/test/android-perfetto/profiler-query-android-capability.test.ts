import { describe, it, expect, vi } from "vitest";
import { assertSupported } from "../../src/utils/capability";
import type { DeviceInfo } from "@argent/registry";

// runAndroidStackQuery is stubbed so the leak_stacks guard test never touches a
// real .pftrace. It should never be called for leak_stacks (the guard returns
// early), so we make it throw to prove the early return.
vi.mock("../../src/utils/android-profiler/pipeline/index", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/android-profiler/pipeline/index")>()),
  runAndroidStackQuery: vi.fn(async () => {
    throw new Error("runAndroidStackQuery should not be reached for leak_stacks on Android");
  }),
}));

import { profilerStackQueryTool } from "../../src/tools/profiler/query/profiler-stack-query";
import { profilerCombinedReportTool } from "../../src/tools/profiler/combined/profiler-combined-report";
import type { NativeProfilerSessionApi } from "../../src/blueprints/native-profiler-session";

const iosSim: DeviceInfo = { id: "ios-sim", platform: "ios", kind: "simulator" };
const iosDevice: DeviceInfo = { id: "ios-dev", platform: "ios", kind: "device" };
const androidEmu: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
const androidDevice: DeviceInfo = { id: "android-dev", platform: "android", kind: "device" };
const androidUnknown: DeviceInfo = { id: "android-unknown", platform: "android", kind: "unknown" };

describe("profiler-stack-query / profiler-combined-report Android capability", () => {
  // Both tools ship complete Android implementations (executeAndroid /
  // loadAndroidCombinedData). These tests pin the capability so the Android
  // path can actually be reached by the dispatcher.
  for (const tool of [profilerStackQueryTool, profilerCombinedReportTool]) {
    describe(tool.id, () => {
      it("is supported on Android emulator / device / unknown", () => {
        expect(() => assertSupported(tool.id, tool.capability, androidEmu)).not.toThrow();
        expect(() => assertSupported(tool.id, tool.capability, androidDevice)).not.toThrow();
        expect(() => assertSupported(tool.id, tool.capability, androidUnknown)).not.toThrow();
      });

      it("is still supported on Apple simulator + device", () => {
        expect(() => assertSupported(tool.id, tool.capability, iosSim)).not.toThrow();
        expect(() => assertSupported(tool.id, tool.capability, iosDevice)).not.toThrow();
      });
    });
  }
});

describe("profiler-stack-query leak_stacks on Android", () => {
  it("returns the iOS-only guidance message without querying the trace", async () => {
    const api: Partial<NativeProfilerSessionApi> = {
      platform: "android",
      traceFile: "/fake.pftrace",
      exportedFiles: { pftrace: "/fake.pftrace" },
      appProcess: "com.example.app",
    };

    const out = await profilerStackQueryTool.execute({ session: api } as never, {
      device_id: androidEmu.id,
      mode: "leak_stacks",
      top_n: 15,
    });

    expect(out).toContain("Memory leak detection is not yet supported on Android");
    expect(out).toContain("adb shell am dumpheap");
  });
});
