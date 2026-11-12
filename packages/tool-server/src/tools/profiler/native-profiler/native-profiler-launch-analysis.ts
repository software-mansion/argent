import { z } from "zod";
import type { FileInputSpec, Registry, ToolDefinition } from "@argent/registry";
import { measureLaunch } from "./launch-analysis/measure";
import { DEFAULT_PROFILE_SECONDS, profileLaunch } from "./launch-analysis/profile";

const fileInputs: FileInputSpec[] = [
  { target: "workspace_path", path: "${workspace_path}", kind: "directory" },
];

const launchAnalysisMode = {
  measure: {
    started: "Building and measuring iOS launch",
    completed: "Measured iOS launch",
    failed: "Failed to measure iOS launch",
  },
  profile: {
    started: "Recording iOS App Launch",
    completed: "Recorded iOS App Launch",
    failed: "Failed to record iOS App Launch",
  },
} as const;

const zodSchema = z
  .object({
    mode: z
      .enum(["measure", "profile"])
      .describe(
        "measure: time five launches with XCTest. profile: record one Instruments App Launch trace. See Modes in the tool description."
      ),
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
    duration_seconds: z
      .number()
      .int()
      .min(5)
      .max(60)
      .optional()
      .describe(
        `profile mode only: App Launch trace recording length in seconds (default ${DEFAULT_PROFILE_SECONDS}). Rejected in measure mode.`
      ),
  })
  .superRefine((params, ctx) => {
    if (params.mode === "measure" && params.duration_seconds !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'duration_seconds applies only to mode "profile". Omit it for mode "measure", which runs a fixed five launches.',
        path: ["duration_seconds"],
      });
    }
  });

export type NativeProfilerLaunchAnalysisParams = z.infer<typeof zodSchema>;

export function createNativeProfilerLaunchAnalysisTool(
  registry: Registry
): ToolDefinition<NativeProfilerLaunchAnalysisParams, unknown> {
  return {
    id: "native-profiler-launch-analysis",
    longRunning: true,
    searchHint:
      "iOS iPhone app launch time startup first frame XCTest benchmark Instruments xctrace trace",
    capability: { apple: { device: true, simulator: true } },
    interaction: {
      startedMsg: ({ params }) =>
        `${launchAnalysisMode[params.mode].started} in ${params.configuration ?? "Release"}`,
      completedMsg: ({ params }) => launchAnalysisMode[params.mode].completed,
      failedMsg: ({ params, failureSignal }) =>
        `${launchAnalysisMode[params.mode].failed}: ${failureSignal.error_code}`,
    },
    description: `Measure or profile the launch of an iOS app up to its first frame. Use when the user asks how long the app takes to launch, or why the launch is slow.
Both modes build the app in \`configuration\` (default Release) and run it once first, so the measured launch is usually warm; iOS can still evict the app from memory. They do not edit the app project. Set \`allow_simulator\` only when timings from the host machine are acceptable.
Modes:
- measure: five launches measured with XCTApplicationLaunchMetric by Argent's UI test runner. Use to set a baseline before an optimization and to verify a fix. The metric ends at the first frame, or later if the app registers extended launch tasks. On iOS 18 iPhones XCTest can drop some of the five measurements; the result then has fewer samples and a warning, and a run that loses the first one fails with no samples, so rerun. Returns { metric, averageMs, medianMs, samplesMs, samplesCollected, samplesExpected, device, bundleId, resultPath, metricsPath, logPath, warning }.
- profile: one launch recorded with the Instruments App Launch template. Use to find which phases and functions run before the first frame, e.g. static initializers, dylib loading or didFinishLaunching work. \`duration_seconds\` applies to this mode only. On an iPhone, launchMs runs from the start of dyld to the end of the first frame (from the first lifecycle phase after Process Creation when the dyld export failed); phases keeps Process Creation, which under xctrace includes the recording's attach time, and warning says so. On a simulator there are no phases or launchMs, the first frame comes from a system signpost, and simulatorLaunchEstimateMs is a rough estimate. cpuSamples counts differ between runs because the sampling period varies from 1 to 5 ms. Returns { launchMs, simulatorLaunchEstimateMs (simulator only), device, bundleId, firstFrameEndMs, phases, tracePath, exports, profilerSession: { sessionId, cpuXml, cpuSamples, next }, exportErrors (when an optional lifecycle, dyld or signpost export failed), warning (null when there is nothing to note) }. profilerSession holds the CPU samples up to the first frame; follow its \`next\` to profiler-load and profiler-stack-query.
Results, traces and logs go to <workspace>/.argent/traces/<datetime>.
Fails if no iPhone is connected by USB cable, the scheme cannot be resolved or the build fails. measure also fails if Argent's device runner is active on the iPhone. profile also fails if xctrace cannot record the launch, or cannot export the trace table of contents, the CPU samples or, on an iPhone, the lifecycle phases; that error names the recorded tracePath, which opens in Instruments. Argent runs each xctrace export up to 3 times when xctrace crashes, as Xcode 26.4.1 xctrace does in most attempts; a crashed dyld or signpost export is named in warning. With Xcode 26.4.x on a simulator, profile fails before the build, because that Xcode stalls recording launches on simulators.`,
    zodSchema,
    fileInputs,
    services: () => ({}),
    async execute(_services, params, ctx) {
      switch (params.mode) {
        case "measure":
          return measureLaunch(registry, params, ctx);
        case "profile":
          return profileLaunch(params, ctx);
        default: {
          const mode: never = params.mode;
          throw new Error(`Unknown mode: ${String(mode)}`);
        }
      }
    },
  };
}
