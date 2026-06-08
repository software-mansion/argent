import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { assertSupported } from "../../../utils/capability";
import { ensureDeps } from "../../../utils/check-deps";
import type { NativeProfilerAnalyzeResult } from "../../../utils/ios-profiler/types";
import { analyzeNativeProfilerIos } from "./platforms/ios";
import { analyzeNativeProfilerAndroid } from "./platforms/android";

const zodSchema = z.object({
  device_id: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
});

const capability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

export const nativeProfilerAnalyzeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  NativeProfilerAnalyzeResult
> = {
  id: "native-profiler-analyze",
  capability,
  description: `Analyze exported native trace data and return an LLM-optimized markdown report.
iOS: parses CPU time profile, UI hangs, and memory leaks from the exported XML files.
Android: queries the Perfetto .pftrace via the in-process Perfetto trace-processor engine for CPU hotspots, UI hangs with jank reason + main-thread state breakdown, GC annotation, and an RSS-growth weak signal.
Returns a structured markdown report with severity indicators, tables, and actionable suggestions.
After presenting the report, ask the user whether to investigate further (drill-down with
profiler-stack-query for hang stacks, CPU context, leak details) or implement fixes and re-profile.
Call native-profiler-stop first to export the trace data.
Use when you need to interpret a completed native profiling recording.
Fails if native-profiler-stop has not been called first to export trace data.`,
  zodSchema,
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params) {
    const api = services.session as NativeProfilerSessionApi;
    const device = resolveDevice(params.device_id);
    assertSupported("native-profiler-analyze", capability, device);

    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      return analyzeNativeProfilerIos(api);
    }
    await ensureDeps(["adb"]);
    return analyzeNativeProfilerAndroid(api);
  },
};
