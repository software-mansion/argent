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
import { requireArtifacts, type ArtifactHandle } from "../../../artifacts";

const zodSchema = z.object({
  device_id: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
});

// A session can never exist for physical iOS (native-profiler-start rejects it,
// same apple.device:false reasoning) — reject here too for a clean, consistent
// error rather than the confusing "no active session" a physical UDID would
// otherwise always hit.
const capability = {
  apple: { simulator: true, device: false },
  android: { emulator: true, device: true, unknown: true },
} as const;

/**
 * Wire shape: `reportFile` leaves as an artifact handle (not a host path) so
 * the client can materialize the full markdown report locally and the inline
 * report's "Read the reportFile" instruction works wherever the tool-server
 * runs — the exact pattern react-profiler-analyze already uses.
 */
type NativeProfilerAnalyzeToolResult = Omit<NativeProfilerAnalyzeResult, "reportFile"> & {
  reportFile: ArtifactHandle | null;
};

export const nativeProfilerAnalyzeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  NativeProfilerAnalyzeToolResult
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
  async execute(services, params, ctx) {
    const api = services.session as NativeProfilerSessionApi;
    const device = resolveDevice(params.device_id);
    assertSupported("native-profiler-analyze", capability, device);

    let result: NativeProfilerAnalyzeResult;
    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      result = await analyzeNativeProfilerIos(api);
    } else {
      await ensureDeps(["adb"]);
      result = await analyzeNativeProfilerAndroid(api);
    }

    return {
      ...result,
      reportFile: result.reportFile
        ? await requireArtifacts(ctx).register(result.reportFile)
        : null,
    };
  },
};
