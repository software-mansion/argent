import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
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
      .describe("`measure`: 5 XCTest timed launches. `profile`: 1 Instruments App Launch trace."),
    bundle_id: z
      .string()
      .regex(BUNDLE_ID_PATTERN, BUNDLE_ID_MESSAGE)
      .describe("Installed Release build bundle ID (not built or installed by this tool)."),
    device_id: z
      .string()
      .optional()
      .describe("iPhone UDID (or booted simulator UDID with `allow_simulator: true`)."),
    allow_simulator: z
      .boolean()
      .default(false)
      .describe("Allow booted simulator when no iPhone is selected."),
    duration_seconds: z
      .number()
      .int()
      .min(5)
      .max(60)
      .optional()
      .describe(`\`profile\` mode only: trace duration in s (default ${DEFAULT_PROFILE_SECONDS}).`),
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

export const nativeProfilerLaunchAnalysisTool: ToolDefinition<
  NativeProfilerLaunchAnalysisParams,
  unknown
> = {
  id: "native-profiler-launch-analysis",
  longRunning: true,
  searchHint:
    "iOS iPhone app launch time startup first frame XCTest benchmark Instruments xctrace trace",
  capability: { apple: { device: true, simulator: true } },
  interaction: {
    startedMsg: ({ params }) => `${launchAnalysisMode[params.mode].started} of ${params.bundle_id}`,
    completedMsg: ({ params }) => launchAnalysisMode[params.mode].completed,
    failedMsg: ({ params, failureSignal }) =>
      `${launchAnalysisMode[params.mode].failed}: ${failureSignal.error_code}`,
  },
  description: `Profile or measure iOS app startup on an already-installed Release build (warms once, then measures).
Use when benchmarking launch time (\`measure\`: 5 XCTest launches incl. extended tasks; signed runner on iPhone) or profiling pre-first-frame CPU work (\`profile\`: Instruments App Launch trace; follow \`profilerSession.next\` with \`profiler-load\` + \`profiler-stack-query\`).
Returns \`samplesCollected\` (\`measure\`) or \`launchMs\` + \`profilerSession\` (\`profile\`). Fails if the app is not installed or no iPhone / allowed simulator is available.`,
  zodSchema,
  services: () => ({}),
  async execute(_services, params, ctx) {
    switch (params.mode) {
      case "measure":
        return measureLaunch(params, ctx);
      case "profile":
        return profileLaunch(params, ctx);
      default: {
        const mode: never = params.mode;
        throw new Error(`Unknown mode: ${String(mode)}`);
      }
    }
  },
};
