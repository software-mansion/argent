import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Registry } from "@argent/registry";
import { profileLaunch } from "../../src/tools/profiler/native-profiler/launch-analysis/profile";
import { measureLaunch } from "../../src/tools/profiler/native-profiler/launch-analysis/measure";
import type { NativeProfilerLaunchAnalysisParams } from "../../src/tools/profiler/native-profiler/native-profiler-launch-analysis";
import { runLogged, terminateLaunchedApp } from "../../src/utils/ios-launch-time/workflow";

// Pins what each mode's execute() passes to xcodebuild / xctrace and how it
// turns the exports into a result. Device and build steps are stubbed.

const state = vi.hoisted(() => ({
  runDir: "",
  simulator: true,
  stdout: new Map<string, string>(),
  exports: new Map<string, string | Error>(),
  recordError: null as Error | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(
      (
        _command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
      ) => {
        const key = args.includes("--toc") ? "toc" : args.includes("xcresulttool") ? "metrics" : "";
        callback(null, { stdout: state.stdout.get(key) ?? "", stderr: "" });
      }
    ),
  };
});

vi.mock("../../src/utils/ios-launch-time/workflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/ios-launch-time/workflow")>();
  return {
    ...actual,
    prepareLaunch: vi.fn(async () => ({
      runDir: state.runDir,
      deviceId: "UDID-1",
      deviceName: "Test device",
      simulator: state.simulator,
      simulatorDeviceSet: null,
      destination: state.simulator ? "platform=iOS Simulator,id=UDID-1" : "platform=iOS,id=UDID-1",
      bundleId: "com.example.app",
      executableName: "App",
      appPath: "/dd/App.app",
      scheme: "App",
      container: "/w/App.xcodeproj",
      teamId: null,
      warning: null,
    })),
    ensureLaunchDeviceReady: vi.fn(async () => undefined),
    terminateForWarmLaunch: vi.fn(async () => undefined),
    terminateLaunchedApp: vi.fn(async () => undefined),
    xcodeVersion: vi.fn(async () => "Xcode 27.0\nBuild version 27A1"),
    runLogged: vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === "xctrace" && args[1] === "record") {
        if (state.recordError) throw state.recordError;
        await mkdir(args[args.indexOf("--output") + 1]!, { recursive: true });
        return;
      }
      if (args[0] === "xctrace" && args[1] === "export") {
        const output = args[args.indexOf("--output") + 1]!;
        const content = state.exports.get(basename(output, ".xml"));
        if (content instanceof Error) throw content;
        await writeFile(output, content ?? "");
      }
    }),
  };
});

vi.mock("../../src/utils/ios-device/runner-artifact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-device/runner-artifact")>()),
  resolveRunnerProjectPath: () => "/runner/ArgentRunner.xcodeproj",
}));

const params = (
  overrides: Partial<NativeProfilerLaunchAnalysisParams> = {}
): NativeProfilerLaunchAnalysisParams => ({
  mode: "profile",
  workspace_path: "/w",
  configuration: "Release",
  allow_simulator: true,
  ...overrides,
});

const fixture = (name: string) =>
  readFileSync(join(__dirname, "..", "fixtures", "ios-launch-time", name), "utf8");

const TOC =
  '<table schema="life-cycle-period"/><table schema="dyld-activity-interval"/>' +
  '<table schema="time-profile" record-waiting-threads="1"/><table schema="os-signpost"/>';

const cpuRow = (id: number, ns: number, state: string, frame: string) =>
  `<row><sample-time id="${id}">${ns}</sample-time><thread id="${id + 1}" fmt="Main Thread"/>` +
  `<thread-state id="${id + 2}" fmt="${state}">${state}</thread-state><weight id="${id + 3}">1000000</weight>` +
  `<tagged-backtrace id="${id + 4}"><frame id="${id + 5}" name="${frame}"/></tagged-backtrace></row>`;

const cpu = (rows: string[]) =>
  `<?xml version="1.0"?><trace-query-result><node><schema name="time-profile"/>${rows.join("")}</node></trace-query-result>`;

const SIGNPOST =
  '<trace-query-result><node><row><event-time id="1">300000000</event-time><event-type id="2">End</event-type>' +
  '<process id="3" fmt="App (123)"/><subsystem id="4">com.apple.app_launch_measurement</subsystem>' +
  '<signpost-name id="5">ApplicationFirstFramePresentation</signpost-name></row></node></trace-query-result>';

const DYLD =
  '<trace-query-result><node><row><start-time id="1">100000000</start-time></row></node></trace-query-result>';

let sessionFiles: string[] = [];

beforeEach(async () => {
  state.runDir = await mkdtemp(join(tmpdir(), "argent-launch-modes-"));
  state.stdout.clear();
  state.exports.clear();
  state.recordError = null;
  vi.mocked(runLogged).mockClear();
  vi.mocked(terminateLaunchedApp).mockClear();
});

afterEach(async () => {
  await rm(state.runDir, { recursive: true, force: true });
  for (const file of sessionFiles) await rm(file, { force: true });
  sessionFiles = [];
});

type ProfileResult = {
  launchMs: number | null;
  simulatorLaunchEstimateMs?: number | null;
  firstFrameEndMs: number | null;
  exportErrors?: Record<string, string>;
  profilerSession: { cpuXml: string; cpuSamples: number };
};

async function profile(overrides: Partial<NativeProfilerLaunchAnalysisParams> = {}) {
  const result = (await profileLaunch(params(overrides))) as ProfileResult;
  sessionFiles.push(result.profilerSession.cpuXml);
  return result;
}

function recordArgs(): string[] {
  return vi.mocked(runLogged).mock.calls.find(([, args]) => args[1] === "record")![1];
}

describe('mode "profile" on a simulator', () => {
  beforeEach(() => {
    state.simulator = true;
    state.stdout.set("toc", TOC);
    state.exports.set("lifecycle", "<trace-query-result><node></node></trace-query-result>");
    state.exports.set("dyld", DYLD);
    state.exports.set("signpost", SIGNPOST);
    state.exports.set(
      "cpu",
      cpu([
        cpuRow(10, 150_000_000, "Running", "setUp()"),
        cpuRow(20, 200_000_000, "Blocked", "__ulock_wait2"),
        cpuRow(30, 250_000_000, "Running", "render()"),
        cpuRow(40, 400_000_000, "Running", "afterFirstFrame()"),
      ])
    );
  });

  it("records the system signpost and cuts the running CPU samples at the first frame", async () => {
    const result = await profile({ duration_seconds: 12 });
    expect(recordArgs()).toEqual(
      expect.arrayContaining(["--template", "App Launch", "--instrument", "os_signpost"])
    );
    expect(recordArgs()[recordArgs().indexOf("--time-limit") + 1]).toBe("12s");
    expect(result.launchMs).toBeNull();
    expect(result.firstFrameEndMs).toBe(300);
    expect(result.simulatorLaunchEstimateMs).toBe(200);
    // Instruments never fills the lifecycle table on a simulator: not an export error.
    expect(result.exportErrors).toBeUndefined();
    expect(result.profilerSession.cpuSamples).toBe(2);
    const session = await readFile(result.profilerSession.cpuXml, "utf8");
    expect(session).toContain("render()");
    expect(session).not.toContain("afterFirstFrame()");
    expect(session).not.toContain("__ulock_wait2");
  });

  it("reports no lifecycle export error when the simulator trace has no lifecycle table", async () => {
    state.stdout.set("toc", TOC.replace('<table schema="life-cycle-period"/>', ""));
    const result = await profile();
    expect(result.exportErrors).toBeUndefined();
    expect(result.profilerSession.cpuSamples).toBe(2);
  });

  it("records for 8 seconds by default", async () => {
    await profile();
    expect(recordArgs()[recordArgs().indexOf("--time-limit") + 1]).toBe("8s");
  });

  it("keeps and counts the whole recording without the signpost", async () => {
    state.exports.set("signpost", "<trace-query-result><node></node></trace-query-result>");
    const result = await profile();
    expect(result.firstFrameEndMs).toBeNull();
    expect(result.profilerSession.cpuSamples).toBe(3);
  });

  it("stops the launched app when the recording fails", async () => {
    state.recordError = new Error("xctrace failed");
    await expect(profileLaunch(params())).rejects.toThrow("xctrace failed");
    expect(terminateLaunchedApp).toHaveBeenCalledTimes(1);
  });
});

describe('mode "profile" on an iPhone', () => {
  beforeEach(() => {
    state.simulator = false;
    state.stdout.set(
      "toc",
      TOC.replace('record-waiting-threads="1"', 'record-waiting-threads="0"')
    );
    state.exports.set("lifecycle", fixture("xcode-27.0-lifecycle.xml"));
    state.exports.set("dyld", fixture("xcode-27.0-dyld.xml"));
    state.exports.set(
      "cpu",
      cpu([
        cpuRow(10, 500_000_000, "Running", "main()"),
        cpuRow(20, 800_000_000, "Running", "late()"),
      ])
    );
  });

  it("does not record the signpost and cuts the CPU samples at the first-frame phase", async () => {
    const result = await profile();
    expect(recordArgs()).not.toContain("os_signpost");
    expect(result.launchMs).toBe(268.5);
    expect(result.profilerSession.cpuSamples).toBe(1);
  });

  it("gives the same launchMs when the dyld export fails", async () => {
    state.exports.set("dyld", new Error("xctrace export failed"));
    const result = await profile();
    expect(result.launchMs).toBe(268.5);
    expect(result.exportErrors).toHaveProperty("dyld");
  });

  it("fails without the lifecycle phases, which give the launch window", async () => {
    state.exports.set("lifecycle", new Error("xctrace export failed"));
    await expect(profileLaunch(params())).rejects.toThrow(/lifecycle phases/);
  });
});

describe('mode "measure"', () => {
  beforeEach(() => {
    state.simulator = true;
    state.stdout.set(
      "metrics",
      JSON.stringify([
        {
          testRuns: [
            {
              metrics: [
                { identifier: "com.apple.dt.XCTMetric_Clock.time.monotonic", measurements: [9] },
                {
                  identifier: "com.apple.dt.XCTMetric_ApplicationLaunch-AppLaunch.duration",
                  measurements: [0.2, 0.3, 0.25, 0.2, 0.3],
                },
              ],
            },
          ],
        },
      ])
    );
  });

  it("runs the launch test with the app's bundle ID and reads the launch duration metric", async () => {
    const result = (await measureLaunch(new Registry(), params({ mode: "measure" }))) as {
      averageMs: number;
      medianMs: number;
      samplesCollected: number;
      samplesExpected: number;
    };
    const [command, args, options] = vi.mocked(runLogged).mock.calls[0]!;
    expect(command).toBe("xcodebuild");
    expect(args).toEqual(
      expect.arrayContaining([
        "test",
        "-scheme",
        "ArgentRunner",
        "-only-testing:ArgentRunnerUITests/ArgentLaunchPerformanceTests/testLaunchDuration",
        "CODE_SIGNING_ALLOWED=NO",
      ])
    );
    expect(options.env?.TEST_RUNNER_ARGENT_LAUNCH_BUNDLE_ID).toBe("com.example.app");
    expect(result).toMatchObject({
      averageMs: 250,
      medianMs: 250,
      samplesCollected: 5,
      samplesExpected: 5,
    });
  });

  it("fails when XCTest recorded no launch duration", async () => {
    state.stdout.set("metrics", "[]");
    await expect(measureLaunch(new Registry(), params({ mode: "measure" }))).rejects.toThrow(
      /recorded no launch measurements/
    );
  });
});
