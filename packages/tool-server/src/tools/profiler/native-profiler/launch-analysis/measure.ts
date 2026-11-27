import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  FAILURE_CODES,
  FailureError,
  subprocessFailureMetadata,
  wrapFailure,
  type ToolContext,
} from "@argent/registry";
import {
  commandFailureKind,
  ensureLaunchDeviceReady,
  freeProfileLimitMessage,
  prepareLaunch,
  runLogged,
  runnerBuildCacheDir,
  withRunnerBuildLock,
  xcodeVersion,
} from "../../../../utils/ios-launch-time/workflow";
import { launchSampleStats } from "../../../../utils/ios-launch-time/results";
import { reserveLaunchAnalysis } from "../../../../utils/ios-device/runner-reservation";
import {
  resolveRunnerProjectPath,
  runnerBuildLocationArgs,
} from "../../../../utils/ios-device/runner-artifact";
import {
  resolveRunnerSigningConfig,
  resolveSigningHint,
} from "../../../../utils/ios-device/runner-signing";
import type { NativeProfilerLaunchAnalysisParams } from "../native-profiler-launch-analysis";

const execFileAsync = promisify(execFile);

// Launches XCTest measures per run. Must match options.iterationCount in
// ArgentLaunchPerformanceTests.swift.
const LAUNCH_ITERATIONS = 5;

type MetricResult = Array<{
  testRuns?: Array<{
    metrics?: Array<{ identifier?: string; measurements?: number[] }>;
  }>;
}>;

/** mode "measure": five launches measured by XCTApplicationLaunchMetric in Argent's UI test runner. */
export async function measureLaunch(params: NativeProfilerLaunchAnalysisParams, ctx?: ToolContext) {
  let release: (() => void) | undefined;
  try {
    const context = await prepareLaunch(
      {
        bundleId: params.bundle_id,
        deviceId: params.device_id,
        allowSimulator: params.allow_simulator,
        checkDevice: ({ id }) => {
          release = reserveLaunchAnalysis(id, "measure");
        },
      },
      (message) => ctx?.emitProgress?.({ type: "device-action", message }),
      ctx?.signal
    );
    return await measurePreparedLaunch(context, ctx);
  } finally {
    release?.();
  }
}

async function measurePreparedLaunch(
  context: Awaited<ReturnType<typeof prepareLaunch>>,
  ctx?: ToolContext
) {
  const project = resolveRunnerProjectPath();
  await ensureLaunchDeviceReady(
    context,
    (message) => ctx?.emitProgress?.({ type: "device-action", message }),
    ctx?.signal
  );
  const runnerSigning = context.simulator
    ? null
    : await resolveRunnerSigningConfig(context.deviceId);
  const runnerBundleId = runnerSigning?.appBundleId ?? "com.argent.runner.tsimulator";
  const testBundleId = runnerSigning?.testBundleId ?? `${runnerBundleId}.uitests`;
  const runnerBuildKey = createHash("sha256")
    .update(
      [
        // Builds for two simulators, or two iPhones, are the same build.
        context.simulator ? "iOS Simulator" : "iOS",
        runnerBundleId,
        testBundleId,
        "Release",
        await xcodeVersion(),
      ].join("\n")
    )
    .digest("hex")
    .slice(0, 16);
  const runnerDerivedData = runnerBuildCacheDir(runnerBuildKey);
  const resultPath = path.join(context.runDir, "launch.xcresult");
  const runnerLog = path.join(context.runDir, "xctest.log");
  const args = [
    "test",
    "-project",
    project,
    "-scheme",
    "ArgentRunner",
    "-configuration",
    "Release",
    "-destination",
    context.destination,
    ...runnerBuildLocationArgs(runnerDerivedData),
    "-resultBundlePath",
    resultPath,
    "-parallel-testing-enabled",
    "NO",
    "-collect-test-diagnostics",
    "never",
    "-only-testing:ArgentRunnerUITests/ArgentLaunchPerformanceTests/testLaunchDuration",
    `ARGENT_RUNNER_APP_BUNDLE_ID=${runnerBundleId}`,
    `ARGENT_RUNNER_TEST_BUNDLE_ID=${testBundleId}`,
    "ENABLE_CODE_COVERAGE=NO",
    "ENABLE_DEBUG_DYLIB=NO",
    ...(runnerSigning
      ? [
          "-allowProvisioningUpdates",
          "-allowProvisioningDeviceRegistration",
          `DEVELOPMENT_TEAM=${runnerSigning.teamId}`,
          "CODE_SIGN_STYLE=Automatic",
        ]
      : ["CODE_SIGNING_ALLOWED=NO"]),
  ];
  try {
    // The build and the launches hold the runner's DerivedData.
    await withRunnerBuildLock(
      runnerDerivedData,
      () =>
        runLogged("xcodebuild", args, {
          cwd: context.runDir,
          logPath: runnerLog,
          signal: ctx?.signal,
          env: {
            ...process.env,
            TEST_RUNNER_ARGENT_LAUNCH_BUNDLE_ID: context.bundleId,
          },
        }),
      ctx?.signal
    );
  } catch (error) {
    ctx?.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    // The message keeps only the cap line; the installed bundle IDs follow it in the log.
    const log = await fsp.readFile(runnerLog, "utf8").catch(() => message);
    const friendly = freeProfileLimitMessage(log, {
      logPath: runnerLog,
      ownBundleIdPrefix: runnerBundleId,
    });
    const failure = {
      failure_stage: "launch_analysis_runner_test",
      failure_area: "tool_server",
      error_kind: commandFailureKind(error),
      ...subprocessFailureMetadata(error, "xcodebuild"),
    } as const;
    if (friendly) {
      throw new FailureError(
        friendly,
        { error_code: FAILURE_CODES.LAUNCH_ANALYSIS_FREE_PROFILE_LIMIT, ...failure },
        { cause: error as Error }
      );
    }
    throw wrapFailure(error, {
      // The simulator runner is unsigned.
      error_code:
        !context.simulator && resolveSigningHint(log) !== null
          ? FAILURE_CODES.LAUNCH_ANALYSIS_SIGNING_FAILED
          : FAILURE_CODES.LAUNCH_ANALYSIS_RUNNER_TEST_FAILED,
      ...failure,
    });
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "xcrun",
      ["xcresulttool", "get", "test-results", "metrics", "--path", resultPath],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, signal: ctx?.signal }
    ));
  } catch (error) {
    ctx?.signal?.throwIfAborted();
    throw wrapFailure(error, {
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_NO_SAMPLES,
      failure_stage: "launch_analysis_read_results",
      failure_area: "tool_server",
      error_kind: commandFailureKind(error),
      ...subprocessFailureMetadata(error, "xcresulttool"),
    });
  }
  const metricsPath = path.join(context.runDir, "metrics.json");
  await fsp.writeFile(metricsPath, stdout);
  const results = JSON.parse(stdout) as MetricResult;
  const measurements = results
    .flatMap((test) => test.testRuns ?? [])
    .flatMap((run) => run.metrics ?? [])
    .find(
      (metric) =>
        metric.identifier === "com.apple.dt.XCTMetric_ApplicationLaunch-AppLaunch.duration"
    )?.measurements;
  const stats = launchSampleStats(measurements ?? [], {
    expected: LAUNCH_ITERATIONS,
    simulator: context.simulator,
  });
  if (!stats) {
    throw new FailureError(
      context.simulator
        ? "XCTest passed but recorded no launch measurements (XCTApplicationLaunchMetric returned no value). " +
            'Rerun the measurement; mode "profile" is an alternative. ' +
            `Result: ${resultPath}. Log: ${runnerLog}`
        : "XCTest passed but recorded no launch measurements. XCTest discards the whole result when " +
            "the first measured launch loses its metric (XCTApplicationLaunchMetric returned no value). " +
            "This is a known device-side issue, seen on iOS 18 iPhones. A rerun usually returns samples; " +
            'mode "profile" is an alternative. ' +
            `Result: ${resultPath}. Log: ${runnerLog}`,
      {
        error_code: FAILURE_CODES.LAUNCH_ANALYSIS_NO_SAMPLES,
        failure_stage: "launch_analysis_read_results",
        failure_area: "tool_server",
        error_kind: "not_found",
      }
    );
  }
  const warnings = [context.warning, stats.warning].filter(Boolean);
  return {
    metric: "XCTApplicationLaunchMetric",
    device: { id: context.deviceId, name: context.deviceName, simulator: context.simulator },
    bundleId: context.bundleId,
    averageMs: stats.averageMs,
    medianMs: stats.medianMs,
    samplesMs: stats.samplesMs,
    samplesCollected: stats.samplesCollected,
    samplesExpected: LAUNCH_ITERATIONS,
    resultPath,
    metricsPath,
    logPath: runnerLog,
    warning: warnings.length > 0 ? warnings.join(" ") : null,
  };
}
