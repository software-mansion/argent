import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal, Registry } from "@argent/registry";
import {
  createNativeProfilerLaunchAnalysisTool,
  type NativeProfilerLaunchAnalysisParams,
} from "../../src/tools/profiler/native-profiler/native-profiler-launch-analysis";
import { measureLaunch } from "../../src/tools/profiler/native-profiler/launch-analysis/measure";
import { profileLaunch } from "../../src/tools/profiler/native-profiler/launch-analysis/profile";

vi.mock("../../src/tools/profiler/native-profiler/launch-analysis/measure", () => ({
  measureLaunch: vi.fn(async () => ({ metric: "XCTApplicationLaunchMetric" })),
}));
vi.mock(
  "../../src/tools/profiler/native-profiler/launch-analysis/profile",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../src/tools/profiler/native-profiler/launch-analysis/profile")
    >()),
    profileLaunch: vi.fn(async () => ({ launchMs: 1 })),
  })
);

const ID = "native-profiler-launch-analysis";

function rig() {
  const registry = new Registry();
  const tool = createNativeProfilerLaunchAnalysisTool(registry);
  registry.registerTool(tool);
  return { registry, tool };
}

beforeEach(() => {
  vi.mocked(measureLaunch).mockClear();
  vi.mocked(profileLaunch).mockClear();
});

const BUNDLE_ID = "com.example.app";

describe("native-profiler-launch-analysis", () => {
  it("runs the XCTest measurement in measure mode", async () => {
    const { registry } = rig();
    const result = await registry.invokeTool(ID, { mode: "measure", bundle_id: BUNDLE_ID });
    expect(result).toEqual({ metric: "XCTApplicationLaunchMetric" });
    expect(measureLaunch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(measureLaunch).mock.calls[0][0]).toBe(registry);
    expect(vi.mocked(measureLaunch).mock.calls[0][1]).toEqual({
      mode: "measure",
      bundle_id: BUNDLE_ID,
      allow_simulator: false,
    });
    expect(profileLaunch).not.toHaveBeenCalled();
  });

  it("records an App Launch trace in profile mode", async () => {
    const { registry } = rig();
    const result = await registry.invokeTool(ID, {
      mode: "profile",
      bundle_id: BUNDLE_ID,
      device_id: "PHONE-1",
      duration_seconds: 12,
    });
    expect(result).toEqual({ launchMs: 1 });
    expect(vi.mocked(profileLaunch).mock.calls[0][0]).toEqual({
      mode: "profile",
      bundle_id: BUNDLE_ID,
      device_id: "PHONE-1",
      allow_simulator: false,
      duration_seconds: 12,
    });
    expect(measureLaunch).not.toHaveBeenCalled();
  });

  it("requires a mode", async () => {
    const { registry } = rig();
    await expect(registry.invokeTool(ID, { bundle_id: BUNDLE_ID })).rejects.toThrow(/mode/);
    expect(measureLaunch).not.toHaveBeenCalled();
    expect(profileLaunch).not.toHaveBeenCalled();
  });

  it("requires the bundle ID of the installed app", async () => {
    const { registry } = rig();
    for (const mode of ["measure", "profile"]) {
      await expect(registry.invokeTool(ID, { mode })).rejects.toThrow(
        "`bundle_id` is required (string) and was not provided"
      );
      for (const bundle_id of ["", "--help"]) {
        await expect(registry.invokeTool(ID, { mode, bundle_id })).rejects.toThrow(/bundle_id/);
      }
    }
    expect(measureLaunch).not.toHaveBeenCalled();
    expect(profileLaunch).not.toHaveBeenCalled();
  });

  it("ignores an unknown key and runs with the defined parameters", async () => {
    const { registry } = rig();
    const result = await registry.invokeTool(ID, {
      mode: "measure",
      bundle_id: BUNDLE_ID,
      workspace_path: "/app",
    });
    expect(result).toEqual({ metric: "XCTApplicationLaunchMetric" });
    expect(vi.mocked(measureLaunch).mock.calls[0][1]).toEqual({
      mode: "measure",
      bundle_id: BUNDLE_ID,
      allow_simulator: false,
    });
  });

  it("rejects duration_seconds in measure mode", async () => {
    const { registry } = rig();
    await expect(
      registry.invokeTool(ID, { mode: "measure", bundle_id: BUNDLE_ID, duration_seconds: 10 })
    ).rejects.toThrow(/duration_seconds applies only to mode "profile"/);
    expect(measureLaunch).not.toHaveBeenCalled();
  });

  it("validates duration_seconds in profile mode and leaves it unset by default", () => {
    const { tool } = rig();
    const schema = tool.zodSchema!;
    const input = { mode: "profile", bundle_id: BUNDLE_ID };
    expect(schema.safeParse({ ...input, duration_seconds: 4 }).success).toBe(false);
    expect(schema.safeParse({ ...input, duration_seconds: 61 }).success).toBe(false);
    const parsed = schema.parse(input) as { duration_seconds?: number };
    expect(parsed.duration_seconds).toBeUndefined();
  });

  it("names the mode and the app in its progress messages", () => {
    const { tool } = rig();
    const started = tool.interaction!.startedMsg!;
    const parse = (input: object) =>
      tool.zodSchema!.parse(input) as NativeProfilerLaunchAnalysisParams;
    expect(started({ params: parse({ mode: "measure", bundle_id: BUNDLE_ID }) })).toBe(
      "Measuring iOS launch of com.example.app"
    );
    expect(started({ params: parse({ mode: "profile", bundle_id: BUNDLE_ID }) })).toBe(
      "Recording iOS App Launch of com.example.app"
    );
  });
});

describe("native-profiler-launch-analysis failures", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

  beforeEach(() => {
    // The host check runs before any device or app lookup, so the case runs on any host.
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
  });

  async function expectUnsupportedHost(mode: "measure" | "profile", failedMsg: string) {
    const { registry } = rig();
    const failed = vi.fn();
    registry.events.on("toolFailed", failed);
    const error = await registry
      .invokeTool(ID, { mode, bundle_id: BUNDLE_ID })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `[Tool:${ID}] iOS launch measurement requires macOS and Xcode.`
    );
    const signal = {
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_UNSUPPORTED_HOST,
      failure_stage: "launch_analysis_host_platform",
      failure_area: "tool_server",
      error_kind: "unsupported",
    };
    expect(getFailureSignal(error)).toEqual(signal);
    expect(getFailureSignal(failed.mock.calls[0]![2])).toEqual(signal);
    expect(failed.mock.calls[0]![4]).toBe(failedMsg);
  }

  it("reports a host other than macOS in measure mode", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/tools/profiler/native-profiler/launch-analysis/measure")
    >("../../src/tools/profiler/native-profiler/launch-analysis/measure");
    vi.mocked(measureLaunch).mockImplementationOnce(actual.measureLaunch);
    await expectUnsupportedHost(
      "measure",
      "Failed to measure iOS launch: LAUNCH_ANALYSIS_UNSUPPORTED_HOST"
    );
  });

  it("reports a host other than macOS in profile mode", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/tools/profiler/native-profiler/launch-analysis/profile")
    >("../../src/tools/profiler/native-profiler/launch-analysis/profile");
    vi.mocked(profileLaunch).mockImplementationOnce(actual.profileLaunch);
    await expectUnsupportedHost(
      "profile",
      "Failed to record iOS App Launch: LAUNCH_ANALYSIS_UNSUPPORTED_HOST"
    );
  });
});
