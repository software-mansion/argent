import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeviceInfo } from "@argent/registry";

vi.mock("../../src/utils/adb", () => ({
  adbShell: vi.fn(async () => ""),
}));

// Keep the real package (TraceProcessorUnavailableError etc. stay intact for
// other importers in the graph) but spy on the warm-engine teardown so we can
// assert the session dispose path wires it up.
vi.mock("@argent/native-devtools-android", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@argent/native-devtools-android")>();
  return {
    ...actual,
    disposeWarmEngine: vi.fn().mockResolvedValue(undefined),
  };
});

import { disposeWarmEngine } from "@argent/native-devtools-android";
import {
  nativeProfilerSessionBlueprint,
  type NativeProfilerSessionApi,
} from "../../src/blueprints/native-profiler-session";

const mockedDisposeWarmEngine = vi.mocked(disposeWarmEngine);

async function buildSession(platform: "android" | "ios"): Promise<{
  api: NativeProfilerSessionApi;
  dispose: () => Promise<void>;
}> {
  const device = {
    id: platform === "android" ? "emulator-5554" : "00008110-0001",
    platform,
    kind: platform === "android" ? "emulator" : "simulator",
  } as unknown as DeviceInfo;
  const instance = await nativeProfilerSessionBlueprint.factory({}, device, { device });
  return { api: instance.api, dispose: instance.dispose };
}

describe("nativeProfilerSessionBlueprint warm-engine teardown on dispose", () => {
  beforeEach(() => {
    mockedDisposeWarmEngine.mockReset();
    mockedDisposeWarmEngine.mockResolvedValue(undefined);
  });

  it("releases the warm engine for a finished (stopped) Android session", async () => {
    const { api, dispose } = await buildSession("android");
    // analyze/drill-down leave the session idle: recording stopped, but the
    // host trace stays set and its warm engine is still resident.
    api.profilingActive = false;
    api.traceFile = "/tmp/native-profiler-20260608.pftrace";

    await dispose();

    expect(mockedDisposeWarmEngine).toHaveBeenCalledTimes(1);
    expect(mockedDisposeWarmEngine).toHaveBeenCalledWith("/tmp/native-profiler-20260608.pftrace");
  });

  it("releases the warm engine even while a recording is still active", async () => {
    const { api, dispose } = await buildSession("android");
    api.profilingActive = true;
    api.capturePid = 12345;
    api.androidOnDeviceTracePath = "/data/misc/perfetto-traces/argent-x.pftrace";
    api.traceFile = "/tmp/native-profiler-active.pftrace";

    await dispose();

    expect(mockedDisposeWarmEngine).toHaveBeenCalledWith("/tmp/native-profiler-active.pftrace");
  });

  it("does nothing when no trace was ever warmed", async () => {
    const { api, dispose } = await buildSession("android");
    api.profilingActive = false;
    api.traceFile = null;

    await dispose();

    expect(mockedDisposeWarmEngine).not.toHaveBeenCalled();
  });

  it("never touches the warm-engine cache for iOS sessions", async () => {
    const { api, dispose } = await buildSession("ios");
    // iOS holds a traceFile too, but uses parsed XML — no wasm engine to free.
    api.profilingActive = false;
    api.traceFile = "/tmp/recording.trace";

    await dispose();

    expect(mockedDisposeWarmEngine).not.toHaveBeenCalled();
  });
});
