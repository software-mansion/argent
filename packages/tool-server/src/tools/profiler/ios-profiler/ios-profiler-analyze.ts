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
  description: `Analyze exported iOS Instruments trace data and return an LLM-optimized markdown report.
Parses CPU time profile, UI hangs, and memory leaks from the exported XML files.
Returns a structured markdown report with severity indicators, tables, and actionable suggestions.
After presenting the report, ask the user whether to investigate further (drill-down with
profiler-stack-query for hang stacks, CPU context, leak details) or implement fixes and re-profile.
Call ios-profiler-stop first to export the trace data.`,
  zodSchema,
  services: (params) => ({
    session: `${IOS_PROFILER_SESSION_NAMESPACE}:${params.device_id}`,
  }),
  async execute(services) {
    const api = services.session as IosProfilerSessionApi;

    if (!api.exportedFiles) {
      throw new Error(
        "No exported trace data found. Call ios-profiler-stop first.",
      );
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
      exportErrors.hangs =
        "Hangs export failed — no potential-hangs table found in trace.";
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
