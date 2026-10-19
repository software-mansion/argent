import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  isLiveServiceState,
  type FileInputSpec,
  type Registry,
  type ToolDefinition,
} from "@argent/registry";
import { IOS_DEVICE_RUNNER_NAMESPACE } from "../../blueprints/ios-device-runner";
import {
  ensureLaunchDeviceReady,
  freeProfileLimitMessage,
  launchBuildCacheDir,
  prepareLaunch,
  runLogged,
  xcodeVersion,
} from "../../utils/ios-launch-time/workflow";
import { launchSampleStats } from "../../utils/ios-launch-time/results";
import { resolveRunnerProjectPath } from "../../utils/ios-device/runner-artifact";
import { resolveRunnerSigningConfig } from "../../utils/ios-device/runner-signing";

const execFileAsync = promisify(execFile);

// Launches XCTest measures per run. Must match options.iterationCount in
// ArgentLaunchPerformanceTests.swift.
const LAUNCH_ITERATIONS = 5;

const schema = z.object({
  workspace_path: z.string().describe("Absolute path to the iOS app project root."),
  device_id: z
    .string()
    .optional()
    .describe("Connected iPhone UDID; required for a physical-device run."),
  scheme: z
    .string()
    .optional()
    .describe("App scheme; required when Xcode cannot select one unambiguously."),
  xcode_container: z
    .string()
    .optional()
    .describe("Workspace or project path, relative to workspace_path."),
  configuration: z
    .string()
    .min(1)
    .default("Release")
    .describe(
      "Xcode build configuration for the app. Set only when the project's Release configuration has another name, such as Production."
    ),
  allow_simulator: z
    .boolean()
    .default(false)
    .describe("Explicitly allow a booted simulator when no iPhone is selected."),
});

const fileInputs: FileInputSpec[] = [
  { target: "workspace_path", path: "${workspace_path}", kind: "directory" },
];

type MetricResult = Array<{
  testRuns?: Array<{
    metrics?: Array<{ identifier?: string; measurements?: number[] }>;
  }>;
}>;

export function createIosLaunchTimeMeasureTool(
  registry: Registry
): ToolDefinition<z.infer<typeof schema>, unknown> {
  return {
    id: "ios-launch-time-measure",
    longRunning: true,
    searchHint: "iOS iPhone app launch time XCTest warm benchmark first frame",
    capability: { apple: { device: true, simulator: true } },
    interaction: {
      startedMsg: ({ params }) =>
        `Building and measuring iOS launch in ${params.configuration ?? "Release"}`,
      completedMsg: () => "Measured iOS launch",
      failedMsg: ({ failureSignal }) => `Failed to measure iOS launch: ${failureSignal.error_code}`,
    },
    description:
      "Run five launches of an iOS app on a connected iPhone and measure them with XCTApplicationLaunchMetric. Use when the user asks how long the app takes to launch, e.g. to set a baseline before an optimization or to verify a fix. Builds the app and Argent's XCUITest runner in Release and runs the app once first, so the launches are usually warm; iOS can still evict the app from memory. The default metric ends at the first frame, or later if the app registers extended launch tasks. Set `allow_simulator` only when Mac-hardware timings are acceptable. Does not edit the app project. On iOS 18 iPhones XCTest can drop some of the five measurements; the result then has fewer samples and a warning, and a run that loses the first one fails with no samples, so rerun. Returns { averageMs, medianMs, samplesMs, samplesCollected, samplesExpected, device, bundleId, resultPath, metricsPath, logPath, warning }; results and build logs go to <workspace>/.argent/traces/<datetime>. Fails if no iPhone is connected by USB cable, the scheme cannot be resolved, the build fails, or Argent's device runner is active on the iPhone.",
    zodSchema: schema,
    fileInputs,
    services: () => ({}),
    async execute(_services, params, ctx) {
      if (params.device_id) {
        const active = registry
          .getSnapshot()
          .services.get(`${IOS_DEVICE_RUNNER_NAMESPACE}:${params.device_id}`);
        if (active && isLiveServiceState(active.state)) {
          throw new Error(
            `Argent's device runner is active on ${params.device_id}. Run stop-simulator-server for this device before ios-launch-time-measure, then retry.`
          );
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
        throw new Error(
          `Argent's device runner is active on ${context.deviceId}. Run stop-simulator-server for this device before ios-launch-time-measure, then retry.`
        );
      }
      const project = resolveRunnerProjectPath();
      await ensureLaunchDeviceReady(
        context,
        (message) => ctx?.emitProgress?.({ type: "device-action", message }),
        ctx?.signal
      );
      const runnerSigning = context.simulator ? null : await resolveRunnerSigningConfig();
      const runnerBundleId = runnerSigning?.appBundleId ?? "com.argent.runner.tsimulator";
      const testBundleId = runnerSigning?.testBundleId ?? `${runnerBundleId}.uitests`;
      const runnerBuildKey = createHash("sha256")
        .update(
          [context.destination, runnerBundleId, testBundleId, "Release", await xcodeVersion()].join(
            "\n"
          )
        )
        .digest("hex")
        .slice(0, 16);
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
        launchBuildCacheDir("runner", runnerBuildKey),
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
        await runLogged("xcodebuild", args, {
          cwd: params.workspace_path,
          logPath: runnerLog,
          signal: ctx?.signal,
          env: {
            ...process.env,
            TEST_RUNNER_ARGENT_LAUNCH_BUNDLE_ID: context.bundleId,
          },
        });
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
                "Rerun the measurement; ios-launch-time-profile is an alternative. " +
                `Result: ${resultPath}. Log: ${runnerLog}`
            : "XCTest passed but recorded no launch measurements. XCTest discards the whole result when " +
                "the first measured launch loses its metric (XCTApplicationLaunchMetric returned no value). " +
                "This is a known device-side issue, seen on iOS 18 iPhones. A rerun usually returns samples; " +
                "ios-launch-time-profile is an alternative. " +
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
    },
  };
}
