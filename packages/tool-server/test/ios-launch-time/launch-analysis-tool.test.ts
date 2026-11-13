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

describe("native-profiler-launch-analysis", () => {
  it("runs the XCTest measurement in measure mode", async () => {
    const { registry } = rig();
    const result = await registry.invokeTool(ID, { mode: "measure", workspace_path: "/app" });
    expect(result).toEqual({ metric: "XCTApplicationLaunchMetric" });
    expect(measureLaunch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(measureLaunch).mock.calls[0][0]).toBe(registry);
    expect(vi.mocked(measureLaunch).mock.calls[0][1]).toMatchObject({
      mode: "measure",
      workspace_path: "/app",
      configuration: "Release",
      allow_simulator: false,
    });
    expect(profileLaunch).not.toHaveBeenCalled();
  });

  it("records an App Launch trace in profile mode", async () => {
    const { registry } = rig();
    const result = await registry.invokeTool(ID, {
      mode: "profile",
      workspace_path: "/app",
      duration_seconds: 12,
    });
    expect(result).toEqual({ launchMs: 1 });
    expect(vi.mocked(profileLaunch).mock.calls[0][0]).toMatchObject({
      mode: "profile",
      duration_seconds: 12,
    });
    expect(measureLaunch).not.toHaveBeenCalled();
  });

  it("requires a mode", async () => {
    const { registry } = rig();
    await expect(registry.invokeTool(ID, { workspace_path: "/app" })).rejects.toThrow(/mode/);
    expect(measureLaunch).not.toHaveBeenCalled();
    expect(profileLaunch).not.toHaveBeenCalled();
  });

  it("rejects duration_seconds in measure mode before any build", async () => {
    const { registry } = rig();
    await expect(
      registry.invokeTool(ID, { mode: "measure", workspace_path: "/app", duration_seconds: 10 })
    ).rejects.toThrow(/duration_seconds applies only to mode "profile"/);
    expect(measureLaunch).not.toHaveBeenCalled();
  });

  it("validates duration_seconds in profile mode and leaves it unset by default", () => {
    const { tool } = rig();
    const schema = tool.zodSchema!;
    expect(
      schema.safeParse({ mode: "profile", workspace_path: "/a", duration_seconds: 4 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ mode: "profile", workspace_path: "/a", duration_seconds: 61 }).success
    ).toBe(false);
    const parsed = schema.parse({ mode: "profile", workspace_path: "/a" }) as {
      duration_seconds?: number;
    };
    expect(parsed.duration_seconds).toBeUndefined();
  });

  it("defaults the app configuration to Release in both modes", () => {
    const { tool } = rig();
    for (const mode of ["measure", "profile"]) {
      const parsed = tool.zodSchema!.parse({ mode, workspace_path: "/x" }) as {
        configuration: string;
      };
      expect(parsed.configuration).toBe("Release");
    }
  });

  it("names the mode in its progress messages", () => {
    const { tool } = rig();
    const started = tool.interaction!.startedMsg!;
    const parse = (input: object) =>
      tool.zodSchema!.parse(input) as NativeProfilerLaunchAnalysisParams;
    expect(started({ params: parse({ mode: "measure", workspace_path: "/x" }) })).toBe(
      "Building and measuring iOS launch in Release"
    );
    expect(
      started({
        params: parse({
          mode: "profile",
          workspace_path: "/x",
          configuration: "Production",
        }),
      })
    ).toBe("Recording iOS App Launch in Production");
  });
});

describe("native-profiler-launch-analysis failures", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

  beforeEach(() => {
    // The workspace check runs after the macOS check, so the case runs on any host.
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
  });

  async function expectMissingWorkspace(mode: "measure" | "profile", failedMsg: string) {
    const { registry } = rig();
    const failed = vi.fn();
    registry.events.on("toolFailed", failed);
    const error = await registry
      .invokeTool(ID, { mode, workspace_path: "/nonexistent/app" })
      .catch((e: unknown) => e);
    expect((error as Error).message).toBe(
      `[Tool:${ID}] workspace_path is not a directory: /nonexistent/app`
    );
    const signal = {
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "launch_analysis_workspace_path",
      failure_area: "tool_server",
      error_kind: "not_found",
    };
    expect(getFailureSignal(error)).toEqual(signal);
    expect(getFailureSignal(failed.mock.calls[0]![2])).toEqual(signal);
    expect(failed.mock.calls[0]![4]).toBe(failedMsg);
  }

  it("reports a missing workspace in measure mode as invalid input", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/tools/profiler/native-profiler/launch-analysis/measure")
    >("../../src/tools/profiler/native-profiler/launch-analysis/measure");
    vi.mocked(measureLaunch).mockImplementationOnce(actual.measureLaunch);
    await expectMissingWorkspace("measure", "Failed to measure iOS launch: TOOL_INPUT_INVALID");
  });

  it("reports a missing workspace in profile mode as invalid input", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/tools/profiler/native-profiler/launch-analysis/profile")
    >("../../src/tools/profiler/native-profiler/launch-analysis/profile");
    vi.mocked(profileLaunch).mockImplementationOnce(actual.profileLaunch);
    await expectMissingWorkspace("profile", "Failed to record iOS App Launch: TOOL_INPUT_INVALID");
  });
});
