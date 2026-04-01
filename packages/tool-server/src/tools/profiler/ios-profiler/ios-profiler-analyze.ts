import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  IOS_PROFILER_SESSION_NAMESPACE,
  type IosProfilerSessionApi,
} from "../../../blueprints/ios-profiler-session";
import { runIosProfilerPipeline } from "../../../utils/ios-profiler/pipeline/index";
import type { IosProfilerAnalyzeResult } from "../../../utils/ios-profiler/types";
import { renderIosProfilerReport } from "../../../utils/ios-profiler/render";

const zodSchema = z.object({
  device_id: z.string().describe("iOS Simulator or device UDID"),
});

export const iosInstrumentsAnalyzeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  IosProfilerAnalyzeResult
> = {
  id: "ios-profiler-analyze",
  description: `Analyze exported iOS Instruments trace data and return a structured markdown performance report.
Use when you have stopped profiling with ios-profiler-stop and want to understand CPU hotspots, UI hangs, and memory leaks in a concise, actionable form.

Parameters: device_id — the simulator or device UDID used for profiling (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890).
Example: { "device_id": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890" }
Returns { report, ... } — a markdown report with severity indicators, tables, and fix suggestions. Call ios-profiler-stop first to export trace data. For deeper investigation use profiler-stack-query. Fails if no trace data is available — call ios-profiler-stop first.`,
  zodSchema,
  services: (params) => ({
    session: `${IOS_PROFILER_SESSION_NAMESPACE}:${params.device_id}`,
  }),
  async execute(services) {
    const api = services.session as IosProfilerSessionApi;

    if (!api.exportedFiles) {
      throw new Error("No exported trace data found. Call ios-profiler-stop first.");
    }

    const { bottlenecks, cpuSamples, uiHangs, cpuHotspots, memoryLeaks } =
      await runIosProfilerPipeline(api.exportedFiles);

    api.parsedData = { cpuSamples, uiHangs, cpuHotspots, memoryLeaks };

    const exportErrors: Record<string, string> = {};
    if (!api.exportedFiles.cpu) {
      exportErrors.cpu =
        "CPU time-profile export failed — xctrace could not export CPU data from this trace. " +
        "The trace template may not include a Time Profiler instrument, or the schema name " +
        "did not match any known CPU profile schema (time-profile, cpu-profile, time-sample). " +
        "Check ios-profiler-stop output for exportDiagnostics.";
    }
    if (!api.exportedFiles.hangs) {
      exportErrors.hangs = "Hangs export failed — no potential-hangs table found in trace.";
    }

    const payload = {
      metadata: {
        traceFile: api.traceFile,
        platform: "iOS",
        timestamp: new Date().toISOString(),
      },
      bottlenecks,
    };

    return renderIosProfilerReport({
      payload,
      traceFile: api.traceFile,
      exportErrors,
    });
  },
};
