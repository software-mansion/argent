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
  launchBuildCacheDir,
  prepareLaunch,
  runLogged,
} from "../../utils/ios-launch-time/workflow";
import { resolveRunnerProjectPath } from "../../utils/ios-device/runner-artifact";
import { resolveRunnerSigningConfig } from "../../utils/ios-device/runner-signing";

const execFileAsync = promisify(execFile);

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
      "Build an iOS app and Argent's XCUITest runner in Release, run the app once, then measure five launches on a connected iPhone using XCTApplicationLaunchMetric. The prelaunch usually makes these warm launches, but iOS can still evict the app from memory. Results and build logs go to <workspace>/.argent/traces/<datetime>. The default metric ends at the first frame, or later if the app registers extended launch tasks. A simulator is used only with allow_simulator=true and its timings are not representative of an iPhone. Does not edit the app project.",
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
        .update([context.destination, runnerBundleId, testBundleId, "Release"].join("\n"))
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
        if (message.includes("maximum number of installed apps using a free developer profile")) {
          throw new Error(
            "The iPhone's free developer profile has no slot for Argent's UI-test runner. " +
              "Remove an app you choose or use a paid team. Argent did not remove another app. " +
              `Log: ${runnerLog}`,
            { cause: error }
          );
        }
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
      if (!measurements?.length) {
        throw new Error(
          `XCTest passed but xcresult had no app launch duration metric. See ${resultPath}.`
        );
      }
      return {
        metric: "XCTApplicationLaunchMetric",
        device: { id: context.deviceId, name: context.deviceName, simulator: context.simulator },
        bundleId: context.bundleId,
        averageMs: Math.round(
          (measurements.reduce((sum, value) => sum + value, 0) / measurements.length) * 1000
        ),
        samplesMs: measurements.map((value) => Math.round(value * 1000)),
        resultPath,
        metricsPath,
        logPath: runnerLog,
        warning: context.warning,
      };
    },
  };
}
