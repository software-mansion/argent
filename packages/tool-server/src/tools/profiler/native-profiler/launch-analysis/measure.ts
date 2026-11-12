import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isLiveServiceState, type Registry, type ToolContext } from "@argent/registry";
import { IOS_DEVICE_RUNNER_NAMESPACE } from "../../../../blueprints/ios-device-runner";
import {
  ensureLaunchDeviceReady,
  freeProfileLimitMessage,
  launchBuildCacheDir,
  launchBuildPlatform,
  prepareLaunch,
  runLogged,
  withLaunchBuildLock,
  xcodeVersion,
} from "../../../../utils/ios-launch-time/workflow";
import { launchSampleStats } from "../../../../utils/ios-launch-time/results";
import { resolveRunnerProjectPath } from "../../../../utils/ios-device/runner-artifact";
import { resolveRunnerSigningConfig } from "../../../../utils/ios-device/runner-signing";
import type { NativeProfilerLaunchAnalysisParams } from "../native-profiler-launch-analysis";

const execFileAsync = promisify(execFile);

// Launches XCTest measures per run. Must match options.iterationCount in
// ArgentLaunchPerformanceTests.swift.
const LAUNCH_ITERATIONS = 5;

const RUNNER_ACTIVE = (deviceId: string) =>
  `Argent's device runner is active on ${deviceId}. Run stop-simulator-server for this device ` +
  "before native-profiler-launch-analysis, then retry.";

type MetricResult = Array<{
  testRuns?: Array<{
    metrics?: Array<{ identifier?: string; measurements?: number[] }>;
  }>;
}>;

/** mode "measure": five launches measured by XCTApplicationLaunchMetric in Argent's UI test runner. */
export async function measureLaunch(
  registry: Registry,
  params: NativeProfilerLaunchAnalysisParams,
  ctx?: ToolContext
) {
  if (params.device_id) {
    const active = registry
      .getSnapshot()
      .services.get(`${IOS_DEVICE_RUNNER_NAMESPACE}:${params.device_id}`);
    if (active && isLiveServiceState(active.state)) {
      throw new Error(RUNNER_ACTIVE(params.device_id));
    }
  }
  const context = await prepareLaunch(
    {
      workspacePath: params.workspace_path,
      deviceId: params.device_id,
      scheme: params.scheme,
      xcodeContainer: params.xcode_container,
      allowSimulator: params.allow_simulator,
      configuration: params.configuration,
    },
    (message) => ctx?.emitProgress?.({ type: "device-action", message }),
    ctx?.signal
  );
  const runner = registry
    .getSnapshot()
    .services.get(`${IOS_DEVICE_RUNNER_NAMESPACE}:${context.deviceId}`);
  if (!context.simulator && runner && isLiveServiceState(runner.state)) {
    throw new Error(RUNNER_ACTIVE(context.deviceId));
  }
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
        launchBuildPlatform(context.simulator),
        runnerBundleId,
        testBundleId,
        "Release",
        await xcodeVersion(),
      ].join("\n")
    )
    .digest("hex")
    .slice(0, 16);
  const runnerDerivedData = launchBuildCacheDir("runner", runnerBuildKey);
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
    "-derivedDataPath",
    runnerDerivedData,
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
    // The build and the five launches hold the runner's DerivedData.
    await withLaunchBuildLock(runnerDerivedData, () =>
      runLogged("xcodebuild", args, {
        cwd: params.workspace_path,
        logPath: runnerLog,
        signal: ctx?.signal,
        env: {
          ...process.env,
          TEST_RUNNER_ARGENT_LAUNCH_BUNDLE_ID: context.bundleId,
        },
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The message keeps only the cap line; the installed bundle IDs follow it in the log.
    const log = await fsp.readFile(runnerLog, "utf8").catch(() => message);
    const friendly = freeProfileLimitMessage(log, {
      subject: "Argent's UI-test runner",
      logPath: runnerLog,
      ownBundleIdPrefix: runnerBundleId,
    });
    if (friendly) throw new Error(friendly, { cause: error });
    throw error;
  }
  const { stdout } = await execFileAsync(
    "xcrun",
    ["xcresulttool", "get", "test-results", "metrics", "--path", resultPath],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, signal: ctx?.signal }
  );
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
    throw new Error(
      context.simulator
        ? "XCTest passed but recorded no launch measurements (XCTApplicationLaunchMetric returned no value). " +
            'Rerun the measurement; mode "profile" is an alternative. ' +
            `Result: ${resultPath}. Log: ${runnerLog}`
        : "XCTest passed but recorded no launch measurements. XCTest discards the whole result when " +
            "the first measured launch loses its metric (XCTApplicationLaunchMetric returned no value). " +
            "This is a known device-side issue, seen on iOS 18 iPhones. A rerun usually returns samples; " +
            'mode "profile" is an alternative. ' +
            `Result: ${resultPath}. Log: ${runnerLog}`
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
