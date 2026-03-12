import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  IOS_INSTRUMENTS_SESSION_NAMESPACE,
  type IosInstrumentsSessionApi,
} from "../../../blueprints/ios-instruments-session";
import { runIosInstrumentsPipeline } from "../../../utils/ios-instruments/pipeline/index";
import type { IosInstrumentsAnalyzeResult } from "../../../utils/ios-instruments/types";
import { renderIosInstrumentsReport } from "../../../utils/ios-instruments/render";

const zodSchema = z.object({
  device_id: z.string().describe("iOS Simulator or device UDID"),
});

export const iosInstrumentsAnalyzeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  IosInstrumentsAnalyzeResult
> = {
  id: "ios-instruments-analyze",
  description: `Analyze exported iOS Instruments trace data and return an LLM-optimized markdown report.
Parses CPU time profile, UI hangs, and memory leaks from the exported XML files.
Returns a structured markdown report with severity indicators, tables, and actionable suggestions.
Call ios-instruments-stop first to export the trace data.`,
  zodSchema,
  services: (params) => ({
    session: `${IOS_INSTRUMENTS_SESSION_NAMESPACE}:${params.device_id}`,
  }),
  async execute(services) {
    const api = services.session as IosInstrumentsSessionApi;

    if (!api.exportedFiles) {
      throw new Error(
        "No exported trace data found. Call ios-instruments-stop first.",
      );
    }

    const { bottlenecks } = await runIosInstrumentsPipeline(api.exportedFiles);

    const payload = {
      metadata: {
        traceFile: api.traceFile,
        platform: "iOS",
        timestamp: new Date().toISOString(),
      },
      bottlenecks,
    };

    return renderIosInstrumentsReport({
      payload,
      traceFile: api.traceFile,
    });
  },
};
