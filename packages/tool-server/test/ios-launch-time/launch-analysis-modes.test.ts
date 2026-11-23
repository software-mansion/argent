import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  FAILURE_CODES,
  getFailureSignal,
  Registry,
  type DeviceInfo,
  type FailureSignal,
  type ToolContext,
} from "@argent/registry";
import { parseCpuXml } from "../../src/utils/ios-profiler/pipeline/xml-parser";
import { profileLaunch } from "../../src/tools/profiler/native-profiler/launch-analysis/profile";
import { measureLaunch } from "../../src/tools/profiler/native-profiler/launch-analysis/measure";
import {
  nativeProfilerLaunchAnalysisTool,
  type NativeProfilerLaunchAnalysisParams,
} from "../../src/tools/profiler/native-profiler/native-profiler-launch-analysis";
import {
  CommandExitError,
  CommandTimeoutError,
  prepareLaunch,
  runLogged,
  terminateLaunchedApp,
} from "../../src/utils/ios-launch-time/workflow";
import { reserveInteractionRunner } from "../../src/utils/ios-device/runner-reservation";
import { iosDeviceRunnerBlueprint } from "../../src/blueprints/ios-device-runner";

// Pins what each mode's execute() passes to xcodebuild / xctrace and how it
// turns the exports into a result. Device steps are stubbed.

const state = vi.hoisted(() => ({
  runDir: "",
  simulator: true,
  stdout: new Map<string, string>(),
  exports: new Map<string, string | Error>(),
  recordError: null as Error | null,
  // Written to the record log before recordError is thrown.
  recordLog: "",
  // When false, the recording leaves no .trace bundle.
  writeTrace: true,
  runnerError: null as Error | null,
  runnerLog: "",
  metricsError: null as Error | null,
  xcodeVersion: "Xcode 27.0\nBuild version 27A1",
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
        if (key === "metrics" && state.metricsError) return callback(state.metricsError);
        callback(null, { stdout: state.stdout.get(key) ?? "", stderr: "" });
      }
    ),
  };
});

vi.mock("../../src/utils/ios-launch-time/workflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/ios-launch-time/workflow")>();
  return {
    ...actual,
    prepareLaunch: vi.fn(
      async (request: {
        checkDevice?: (d: { id: string; simulator: boolean }) => void | Promise<void>;
      }) => {
        await request.checkDevice?.({ id: "UDID-1", simulator: state.simulator });
        return {
          runDir: state.runDir,
          deviceId: "UDID-1",
          deviceName: "Test device",
          simulator: state.simulator,
          simulatorDeviceSet: null,
          destination: state.simulator
            ? "platform=iOS Simulator,id=UDID-1"
            : "platform=iOS,id=UDID-1",
          bundleId: "com.example.app",
          appPath: "/sim/App.app",
          warning: null,
        };
      }
    ),
    ensureLaunchDeviceReady: vi.fn(async () => undefined),
    terminateForWarmLaunch: vi.fn(async () => undefined),
    terminateLaunchedApp: vi.fn(async () => undefined),
    xcodeVersion: vi.fn(async () => state.xcodeVersion),
    runLogged: vi.fn(async (_command: string, args: string[], options: { logPath: string }) => {
      if (args[0] === "xctrace" && args[1] === "record") {
        await writeFile(options.logPath, state.recordLog);
        if (state.recordError) throw state.recordError;
        if (state.writeTrace) await mkdir(args[args.indexOf("--output") + 1]!, { recursive: true });
        return;
      }
      if (args[0] === "test") {
        if (state.runnerError) {
          await writeFile(options.logPath, state.runnerLog);
          throw state.runnerError;
        }
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

vi.mock("../../src/utils/ios-device/runner-signing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-device/runner-signing")>()),
  resolveRunnerSigningConfig: vi.fn(async () => ({
    teamId: "TEAM123456",
    appBundleId: "com.argent.runner.tteam123456",
    testBundleId: "com.argent.runner.tteam123456.uitests",
  })),
}));

vi.mock("../../src/utils/ios-device/runner-artifact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-device/runner-artifact")>()),
  resolveRunnerProjectPath: () => "/runner/ArgentRunner.xcodeproj",
}));

const params = (
  overrides: Partial<NativeProfilerLaunchAnalysisParams> = {}
): NativeProfilerLaunchAnalysisParams => ({
  mode: "profile",
  bundle_id: "com.example.app",
  allow_simulator: true,
  ...overrides,
});

const fixture = (name: string) =>
  readFileSync(join(__dirname, "..", "fixtures", "ios-launch-time", name), "utf8");

const TOC =
  '<target><process type="launched" name="App" pid="123"/></target>' +
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
  state.recordLog = "";
  state.writeTrace = true;
  state.runnerError = null;
  state.runnerLog = "";
  state.metricsError = null;
  state.xcodeVersion = "Xcode 27.0\nBuild version 27A1";
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
  firstFrameEndMs: number;
  exportErrors?: Record<string, string>;
  profilerSession: { cpuXml: string; cpuSamples: number };
  warning: string | null;
};

async function profile(overrides: Partial<NativeProfilerLaunchAnalysisParams> = {}) {
  const result = (await profileLaunch(params(overrides))) as ProfileResult;
  sessionFiles.push(result.profilerSession.cpuXml);
  return result;
}

/** The rejection of `work` and its failure signal. */
async function failure(work: Promise<unknown>): Promise<{ error: Error; signal: FailureSignal }> {
  const error = (await work.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e
  )) as Error;
  return { error, signal: getFailureSignal(error)! };
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

  it("weighs samples at the interval xctrace used and warns when it is not 1 ms", async () => {
    const rows = Array.from(
      { length: 30 },
      (_, tick) =>
        `<row><sample-time id="${100 + tick}">${100_000_000 + tick * 5_000_000}</sample-time>` +
        (tick === 0
          ? '<thread id="2" fmt="Main Thread"/><thread-state id="3" fmt="Running">Running</thread-state>' +
            '<weight id="4">1000000</weight>'
          : '<thread ref="2"/><thread-state ref="3"/><weight ref="4"/>') +
        `<tagged-backtrace id="${200 + tick}"><frame id="${300 + tick}" name="setUp()"/></tagged-backtrace></row>`
    );
    state.exports.set("cpu", cpu(rows));
    const result = await profile();
    // 100–245 ms, all before the first frame at 300 ms.
    expect(result.profilerSession.cpuSamples).toBe(30);
    const session = await readFile(result.profilerSession.cpuXml, "utf8");
    expect(new Set(parseCpuXml(session).map((sample) => sample.weightNs))).toEqual(
      new Set([5_000_000])
    );
    expect(result.warning).toContain("xctrace sampled the CPU every 5 ms");
  });

  it("uses the configured sampling period from xctrace even for a sparse launch", async () => {
    state.recordLog =
      "* [Warning] Warning while binding 'time-sample' table: requested sampling period (1000000ns) differs from configured (5000000ns)";
    const result = await profile();
    const samples = parseCpuXml(await readFile(result.profilerSession.cpuXml, "utf8"));
    expect(samples.map((s) => s.weightNs)).toEqual([5_000_000, 5_000_000]);
    expect(result.warning).toContain("xctrace sampled the CPU every 5 ms");
  });

  it("reports no lifecycle export error when the simulator trace has no lifecycle table", async () => {
    state.stdout.set("toc", TOC.replace('<table schema="life-cycle-period"/>', ""));
    const result = await profile();
    expect(result.exportErrors).toBeUndefined();
    expect(result.profilerSession.cpuSamples).toBe(2);
  });

  it("takes the signpost of the process the trace launched", async () => {
    state.stdout.set("toc", TOC.replace('name="App"', 'name="Other App"'));
    const { signal } = await failure(profileLaunch(params()));
    expect(signal.error_code).toBe(FAILURE_CODES.LAUNCH_ANALYSIS_NO_FIRST_FRAME);
  });

  it("records for 8 seconds by default", async () => {
    await profile();
    expect(recordArgs()[recordArgs().indexOf("--time-limit") + 1]).toBe("8s");
  });

  it("fails without the first-frame signpost and writes no CPU session", async () => {
    state.exports.set("signpost", "<trace-query-result><node></node></trace-query-result>");
    const { error, signal } = await failure(profileLaunch(params({ duration_seconds: 12 })));
    expect(error.message).toContain(
      "The recording has no first frame of com.example.app. The app may have crashed, " +
        "or the launch took longer than duration_seconds (12 s)."
    );
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_NO_FIRST_FRAME,
      failure_stage: "launch_analysis_read_trace",
      failure_area: "tool_server",
      error_kind: "not_found",
    });
    // The full CPU export is removed only after the session is written.
    expect(existsSync(join(state.runDir, "cpu.xml"))).toBe(true);
  });

  it("fails as an export failure when the trace has no signpost table", async () => {
    state.stdout.set("toc", TOC.replace('<table schema="os-signpost"/>', ""));
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toContain("could not export the first-frame signpost");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_EXPORT_FAILED,
      failure_stage: "launch_analysis_export",
      failure_area: "tool_server",
      error_kind: "not_found",
      failure_command: "xctrace",
    });
  });

  it("reports a signpost export that crashed on every attempt as a crash", async () => {
    state.exports.set("signpost", new CommandExitError("xcrun exited with 139", 139, null));
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toContain("xctrace export of the first-frame signpost crashed 3 times");
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_EXPORT_FAILED,
      error_kind: "crash",
      failure_exit_code: 139,
    });
  });

  const NO_DYLD_NOTE =
    "No dyld activity for the app before the first frame, so simulatorLaunchEstimateMs is null. The CPU session is complete.";

  it("keeps the result without dyld activity, with no launch estimate", async () => {
    state.exports.set("dyld", "<trace-query-result><node></node></trace-query-result>");
    const result = await profile();
    expect(result.simulatorLaunchEstimateMs).toBeNull();
    expect(result.firstFrameEndMs).toBe(300);
    expect(result.profilerSession.cpuSamples).toBe(2);
    expect(result.warning).toContain(NO_DYLD_NOTE);
  });

  it("has no estimate note when the estimate is set", async () => {
    const result = await profile();
    expect(result.warning).not.toContain("simulatorLaunchEstimateMs");
  });

  it("starts the estimate at the launched app's dyld activity, not another process's", async () => {
    state.exports.set(
      "dyld",
      '<trace-query-result><node><row><start-time id="1">50000000</start-time><process id="2" fmt="Other (9)"/></row>' +
        '<row><start-time id="3">100000000</start-time><process id="4" fmt="App (123)"/></row></node></trace-query-result>'
    );
    expect((await profile()).simulatorLaunchEstimateMs).toBe(200);
  });

  it("notes the null estimate when no dyld row is the launched app's", async () => {
    state.exports.set(
      "dyld",
      '<trace-query-result><node><row><start-time id="1">50000000</start-time><process id="2" fmt="Other (9)"/></row></node></trace-query-result>'
    );
    const result = await profile();
    expect(result.simulatorLaunchEstimateMs).toBeNull();
    expect(result.profilerSession.cpuSamples).toBe(2);
    expect(result.warning).toContain(NO_DYLD_NOTE);
  });

  it("notes the null estimate when dyld starts after the first frame", async () => {
    state.exports.set("dyld", DYLD.replace("100000000", "350000000"));
    const result = await profile();
    expect(result.simulatorLaunchEstimateMs).toBeNull();
    expect(result.warning).toContain(NO_DYLD_NOTE);
  });

  it("notes the null estimate when the trace has no dyld table", async () => {
    state.stdout.set("toc", TOC.replace('<table schema="dyld-activity-interval"/>', ""));
    const result = await profile();
    expect(result.simulatorLaunchEstimateMs).toBeNull();
    expect(result.exportErrors).toHaveProperty("dyld");
    expect(result.profilerSession.cpuSamples).toBe(2);
    expect(result.warning).toContain(NO_DYLD_NOTE);
  });

  it("notes the null estimate when the dyld export fails", async () => {
    state.exports.set("dyld", new CommandExitError("xcrun exited with 1", 1, null));
    const result = await profile();
    expect(result.simulatorLaunchEstimateMs).toBeNull();
    expect(result.exportErrors).toHaveProperty("dyld");
    expect(result.profilerSession.cpuSamples).toBe(2);
    expect(result.warning).toContain(
      "The dyld export failed, so simulatorLaunchEstimateMs is null. The CPU session is complete."
    );
    expect(result.warning).not.toContain("No dyld activity");
  });

  it("gives one note for the null estimate when the dyld export crashed", async () => {
    state.exports.set("dyld", new CommandExitError("xcrun exited with 139", 139, null));
    const result = await profile();
    expect(result.simulatorLaunchEstimateMs).toBeNull();
    expect(result.profilerSession.cpuSamples).toBe(2);
    expect(result.warning).toContain(
      "xctrace export of dyld crashed with Xcode 27.0\nBuild version 27A1, so simulatorLaunchEstimateMs is null. The CPU session is complete."
    );
    expect(result.warning!.match(/simulatorLaunchEstimateMs is null/g)).toHaveLength(1);
    expect(result.warning).not.toContain("No dyld activity");
    expect(result.warning).not.toContain("that data is missing");
  });

  it("stops the launched app when the recording fails", async () => {
    state.recordError = new CommandExitError("xcrun exited with 1:\nxctrace failed", 1, null);
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toBe("xcrun exited with 1:\nxctrace failed");
    expect(terminateLaunchedApp).toHaveBeenCalledTimes(1);
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_RECORD_FAILED,
      failure_stage: "launch_analysis_record",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xctrace",
      failure_exit_code: 1,
    });
  });

  it("reports a stalled recording as a record timeout", async () => {
    state.recordError = new CommandTimeoutError("xcrun timed out after 180 s and was killed.");
    state.recordLog = "Starting recording with the App Launch template.";
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toContain('xctrace stalled at "Starting recording"');
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_RECORD_FAILED,
      failure_stage: "launch_analysis_record",
      failure_area: "tool_server",
      error_kind: "timeout",
      failure_command: "xctrace",
    });
  });

  it("reports a recording without a trace bundle", async () => {
    state.writeTrace = false;
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toContain("xctrace finished without a trace");
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_RECORD_FAILED,
      error_kind: "not_found",
      failure_command: "xctrace",
    });
  });

  it("leaves a cancelled recording unclassified", async () => {
    const controller = new AbortController();
    controller.abort();
    state.recordError = controller.signal.reason as Error;
    const error = await profileLaunch(params(), { signal: controller.signal } as ToolContext).catch(
      (e: unknown) => e
    );
    expect(error).toBe(controller.signal.reason);
    expect(getFailureSignal(error)).toBeNull();
    expect(terminateLaunchedApp).toHaveBeenCalledTimes(1);
  });

  it("stops before it launches the app with Xcode 26.4 on a simulator", async () => {
    state.xcodeVersion = "Xcode 26.4.1 Build version 17E202";
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toContain("known issue with Xcode 26.4.x");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_UNSUPPORTED_HOST,
      failure_stage: "launch_analysis_record_precheck",
      failure_area: "tool_server",
      error_kind: "unsupported",
    });
    expect(runLogged).not.toHaveBeenCalled();
  });

  it("fails as an export failure when the trace has no CPU table", async () => {
    state.stdout.set("toc", TOC.replace(/<table schema="time-profile"[^>]*\/>/, ""));
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toContain("could not export the CPU samples");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_EXPORT_FAILED,
      failure_stage: "launch_analysis_export",
      failure_area: "tool_server",
      error_kind: "not_found",
      failure_command: "xctrace",
    });
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

  it("fails when the lifecycle phases have no first frame", async () => {
    state.exports.set("lifecycle", "<trace-query-result><node></node></trace-query-result>");
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toContain("duration_seconds (8 s)");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_NO_FIRST_FRAME,
      failure_stage: "launch_analysis_read_trace",
      failure_area: "tool_server",
      error_kind: "not_found",
    });
    expect(existsSync(join(state.runDir, "cpu.xml"))).toBe(true);
  });

  it("gives the same launchMs when the dyld export fails", async () => {
    state.exports.set("dyld", new Error("xctrace export failed"));
    const result = await profile();
    expect(result.launchMs).toBe(268.5);
    expect(result.exportErrors).toHaveProperty("dyld");
  });

  it("fails without the lifecycle phases, which give the launch window", async () => {
    state.exports.set("lifecycle", new CommandExitError("xcrun exited with 2", 2, null));
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toMatch(/lifecycle phases/);
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_EXPORT_FAILED,
      failure_stage: "launch_analysis_export",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xctrace",
      failure_exit_code: 2,
    });
  });

  it("reports an export that crashed on every attempt as a crash", async () => {
    state.exports.set("lifecycle", new CommandExitError("xcrun exited with 139", 139, null));
    const { error, signal } = await failure(profileLaunch(params()));
    expect(error.message).toContain("crashed 3 times in a row");
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_EXPORT_FAILED,
      error_kind: "crash",
      failure_exit_code: 139,
    });
  });

  it("reports the code and the xctrace metadata through the registry", async () => {
    state.recordError = new CommandExitError("xcrun exited with 1:\nxctrace failed", 1, null);
    const registry = new Registry();
    registry.registerTool(nativeProfilerLaunchAnalysisTool);
    const failed = vi.fn();
    registry.events.on("toolFailed", failed);
    const { error, signal } = await failure(
      registry.invokeTool("native-profiler-launch-analysis", {
        mode: "profile",
        bundle_id: "com.example.app",
      })
    );
    expect(error.message).toBe(
      "[Tool:native-profiler-launch-analysis] xcrun exited with 1:\nxctrace failed"
    );
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_RECORD_FAILED,
      failure_stage: "launch_analysis_record",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xctrace",
      failure_exit_code: 1,
    });
    expect(getFailureSignal(failed.mock.calls[0]![2])).toEqual(signal);
    expect(failed.mock.calls[0]![4]).toBe(
      "Failed to record iOS App Launch: LAUNCH_ANALYSIS_RECORD_FAILED"
    );
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
    const result = (await measureLaunch(params({ mode: "measure" }))) as {
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
    expect(vi.mocked(prepareLaunch).mock.calls.at(-1)![0]).toMatchObject({
      bundleId: "com.example.app",
      deviceId: undefined,
      allowSimulator: true,
    });
    const derived = args[args.indexOf("-derivedDataPath") + 1]!;
    expect(args).toEqual(
      expect.arrayContaining([
        `SYMROOT=${join(derived, "Build", "Products")}`,
        `OBJROOT=${join(derived, "Build", "Intermediates.noindex")}`,
        `SHARED_PRECOMPS_DIR=${join(derived, "Build", "Intermediates.noindex", "PrecompiledHeaders")}`,
      ])
    );
    expect(options.env?.TEST_RUNNER_ARGENT_LAUNCH_BUNDLE_ID).toBe("com.example.app");
    expect(options.cwd).toBe(state.runDir);
    expect(result).toMatchObject({
      averageMs: 250,
      medianMs: 250,
      samplesCollected: 5,
      samplesExpected: 5,
    });
  });

  it("fails when XCTest recorded no launch duration", async () => {
    state.stdout.set("metrics", "[]");
    const { error, signal } = await failure(measureLaunch(params({ mode: "measure" })));
    expect(error.message).toMatch(/recorded no launch measurements/);
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_NO_SAMPLES,
      failure_stage: "launch_analysis_read_results",
      failure_area: "tool_server",
      error_kind: "not_found",
    });
  });

  it("reports an unreadable result bundle with the xcresulttool exit code", async () => {
    state.metricsError = Object.assign(new Error("Command failed: xcrun xcresulttool"), {
      code: 1,
    });
    const { signal } = await failure(measureLaunch(params({ mode: "measure" })));
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_NO_SAMPLES,
      failure_stage: "launch_analysis_read_results",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xcresulttool",
      failure_exit_code: 1,
    });
  });

  it("reports a failed launch test with the xcodebuild exit code", async () => {
    state.runnerError = new CommandExitError(
      "xcodebuild exited with 65:\nTesting failed",
      65,
      null
    );
    state.runnerLog = "Testing failed:\n\tApp crashed";
    const { error, signal } = await failure(measureLaunch(params({ mode: "measure" })));
    expect(error.message).toBe("xcodebuild exited with 65:\nTesting failed");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_RUNNER_TEST_FAILED,
      failure_stage: "launch_analysis_runner_test",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xcodebuild",
      failure_exit_code: 65,
    });
  });

  it("reports the runner's free-profile cap", async () => {
    state.runnerError = new CommandExitError("xcodebuild exited with 65", 65, null);
    state.runnerLog = "maximum number of installed apps using a free developer profile";
    const { error, signal } = await failure(measureLaunch(params({ mode: "measure" })));
    expect(error.message).toContain("no slot for Argent's UI-test runner");
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_FREE_PROFILE_LIMIT,
      failure_command: "xcodebuild",
      failure_exit_code: 65,
    });
  });

  it("reports a runner signing failure on an iPhone", async () => {
    state.simulator = false;
    state.runnerError = new CommandExitError("xcodebuild exited with 65", 65, null);
    state.runnerLog = "error: No profiles for 'com.argent.runner.tteam123456' were found";
    const { signal } = await failure(measureLaunch(params({ mode: "measure" })));
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_SIGNING_FAILED,
      failure_stage: "launch_analysis_runner_test",
      failure_command: "xcodebuild",
    });
  });

  it("leaves a cancelled launch test unclassified", async () => {
    const controller = new AbortController();
    controller.abort();
    state.runnerError = controller.signal.reason as Error;
    const error = await measureLaunch(params({ mode: "measure" }), {
      signal: controller.signal,
    } as ToolContext).catch((e: unknown) => e);
    expect(error).toBe(controller.signal.reason);
    expect(getFailureSignal(error)).toBeNull();
  });

  it("stops when Argent's device runner is active on the device", async () => {
    const release = reserveInteractionRunner("UDID-1");
    try {
      const { error, signal } = await failure(
        measureLaunch(params({ mode: "measure", device_id: "UDID-1" }))
      );
      expect(error.message).toContain("Argent's device runner is active on UDID-1");
      expect(signal.error_code).toBe(FAILURE_CODES.LAUNCH_ANALYSIS_DEVICE_UNAVAILABLE);
      expect(runLogged).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("holds the iPhone runner through XCTest and releases it after a failed measurement", async () => {
    state.simulator = false;
    const device: DeviceInfo = { id: "UDID-1", platform: "ios", kind: "device" };
    vi.mocked(runLogged).mockImplementationOnce(async () => {
      await expect(iosDeviceRunnerBlueprint.factory({}, device, { device })).rejects.toThrow(
        /measurement is in progress/
      );
      await expect(
        measureLaunch(params({ mode: "measure", device_id: device.id }))
      ).rejects.toThrow(/measurement is in progress/);
      const releaseOther = reserveInteractionRunner("another-phone");
      releaseOther();
      throw new Error("interrupted XCTest");
    });
    await expect(measureLaunch(params({ mode: "measure", device_id: device.id }))).rejects.toThrow(
      /interrupted XCTest/
    );
    await expect(
      measureLaunch(params({ mode: "measure", device_id: device.id }))
    ).resolves.toMatchObject({ samplesCollected: 5 });
  });
});
