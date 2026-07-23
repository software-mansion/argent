import { describe, it, expect, vi } from "vitest";
import { ArtifactStore } from "@argent/registry";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

// Mock the platform impl modules so we never shell out to xctrace / adb. We
// only care that the dispatch picks the correct branch given an api.platform.
vi.mock("../../src/utils/check-deps", () => ({
  ensureDeps: vi.fn(async () => {}),
  ensureDep: vi.fn(async () => {}),
}));
vi.mock("../../src/tools/profiler/native-profiler/platforms/ios", () => ({
  startNativeProfilerIos: vi.fn(async () => ({
    status: "recording",
    pid: 1,
    traceFile: "/ios.trace",
  })),
  stopNativeProfilerIos: vi.fn(async () => ({
    traceFile: "/ios.trace",
    exportedFiles: {},
    exportDiagnostics: { tocSchemas: [], cpuSchemaUsed: null, errors: {} },
  })),
  analyzeNativeProfilerIos: vi.fn(async () => ({
    report: "ios",
    reportFile: null,
    bottlenecksTotal: 0,
    status: "ok",
    exportErrors: {},
  })),
  handleXctraceExit: vi.fn(),
}));
vi.mock("../../src/tools/profiler/native-profiler/platforms/android", () => ({
  startNativeProfilerAndroid: vi.fn(async () => ({
    status: "recording",
    pid: 2,
    traceFile: "/android.pftrace",
  })),
  stopNativeProfilerAndroid: vi.fn(async () => ({
    traceFile: "/android.pftrace",
    exportedFiles: {},
  })),
  analyzeNativeProfilerAndroid: vi.fn(async () => ({
    report: "android",
    reportFile: null,
    bottlenecksTotal: 0,
    status: "ok",
    exportErrors: {},
  })),
}));

import { nativeProfilerStartTool } from "../../src/tools/profiler/native-profiler/native-profiler-start";
import { nativeProfilerStopTool } from "../../src/tools/profiler/native-profiler/native-profiler-stop";
import { nativeProfilerAnalyzeTool } from "../../src/tools/profiler/native-profiler/native-profiler-analyze";
import { startNativeProfilerIos } from "../../src/tools/profiler/native-profiler/platforms/ios";
import { startNativeProfilerAndroid } from "../../src/tools/profiler/native-profiler/platforms/android";

async function buildSession(platform: "ios" | "android"): Promise<NativeProfilerSessionApi> {
  const device =
    platform === "ios"
      ? {
          id: "11111111-2222-3333-4444-555555555555",
          platform: "ios" as const,
          kind: "simulator" as const,
        }
      : { id: "emulator-5554", platform: "android" as const, kind: "emulator" as const };
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return instance.api;
}

describe("native-profiler-* dispatch by session platform", () => {
  it("routes iOS sessions through platforms/ios", async () => {
    const api = await buildSession("ios");
    const result = await nativeProfilerStartTool.execute({ session: api } as never, {
      device_id: "11111111-2222-3333-4444-555555555555",
    });
    expect(startNativeProfilerIos).toHaveBeenCalled();
    expect(startNativeProfilerAndroid).not.toHaveBeenCalled();
    expect(result.pid).toBe(1);
  });

  it("routes Android sessions through platforms/android", async () => {
    const api = await buildSession("android");
    const result = await nativeProfilerStartTool.execute({ session: api } as never, {
      device_id: "emulator-5554",
    });
    expect(startNativeProfilerAndroid).toHaveBeenCalled();
    expect(result.pid).toBe(2);
  });

  it("stop+analyze also route by session platform", async () => {
    const androidApi = await buildSession("android");
    const stop = await nativeProfilerStopTool.execute(
      { session: androidApi } as never,
      {
        device_id: "emulator-5554",
      },
      { artifacts: new ArtifactStore() }
    );
    // The stop tool wraps the platform's raw path into a downloadable artifact;
    // the filename still proves it routed through the Android (.pftrace) path.
    expect(stop.traceFile).toMatchObject({
      __argentArtifact: true,
      kind: "native-profile-trace",
      archive: "tar.gz",
      filename: "android.pftrace",
    });
    const analyze = await nativeProfilerAnalyzeTool.execute({ session: androidApi } as never, {
      device_id: "emulator-5554",
    });
    expect(analyze.report).toBe("android");
  });
});
