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
    description: `Profile or measure iOS app startup. Use measure for launch timings and profile to investigate slow launches.
Build and install a Release build before calling; this tool does not build or install the app. Rebuild and reinstall after code changes. Pass the installed app's bundle_id and the USB-connected iPhone's device_id. Use allow_simulator only when timings from the host machine are acceptable. Both modes open the app before collecting data, then measure subsequent process launches.
- measure: collect five XCTest launch measurements to establish a baseline or verify a fix. The metric includes the first frame and any extended launch tasks. Returns average, median and individual times in milliseconds, sample counts, result paths and warnings.
- profile: record one Instruments App Launch trace to investigate phases and CPU work before the first frame. Returns launch timing, phases, trace paths and a CPU session. On a simulator, phases are unavailable and launch timing is a rough estimate. Follow profilerSession.next to load the session with profiler-load and inspect it with profiler-stack-query.`,
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
