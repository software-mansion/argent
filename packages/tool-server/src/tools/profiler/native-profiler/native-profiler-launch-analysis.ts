import { z } from "zod";
import type { Registry, ToolDefinition } from "@argent/registry";
import { BUNDLE_ID_MESSAGE, BUNDLE_ID_PATTERN } from "../../../utils/bundle-id";
import { measureLaunch } from "./launch-analysis/measure";
import { DEFAULT_PROFILE_SECONDS, profileLaunch } from "./launch-analysis/profile";

const launchAnalysisMode = {
  measure: {
    started: "Measuring iOS launch",
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
        "measure: time five launches with XCTest. profile: record one Instruments App Launch trace."
      ),
    bundle_id: z
      .string()
      .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
      .describe(
        "Bundle ID of the Release build already installed on the device. The tool does not build or install the app."
      ),
    device_id: z
      .string()
      .optional()
      .describe(
        "Connected iPhone UDID; required for a physical-device run. With allow_simulator, a booted simulator UDID also works."
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
        `${launchAnalysisMode[params.mode].started} of ${params.bundle_id}`,
      completedMsg: ({ params }) => launchAnalysisMode[params.mode].completed,
      failedMsg: ({ params, failureSignal }) =>
        `${launchAnalysisMode[params.mode].failed}: ${failureSignal.error_code}`,
    },
    description: `Profile or measure iOS app startup. Both modes open the app once, then time the launches that follow.
- measure: time five launches with Argent's XCTest runner to set a baseline or verify a fix. On an iPhone the runner must be signed. The metric includes the first frame and any extended launch tasks.
- profile: record one Instruments App Launch trace to find the CPU work before the first frame. Work after the first frame is not included. On a simulator there are no lifecycle phases and the launch time is a rough estimate.
Install a Release build of bundle_id before calling; the tool does not build or install the app.
Use when you need the iOS launch time or want to find what slows the app's startup.
Returns samplesCollected in measure mode. In profile mode, launchMs runs from the first lifecycle phase after Process Creation to the first frame (null on a simulator); follow profilerSession.next to load the CPU samples with profiler-load and query them with profiler-stack-query.
Fails if the app is not installed or no iPhone or allowed simulator is available.`,
    zodSchema,
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
