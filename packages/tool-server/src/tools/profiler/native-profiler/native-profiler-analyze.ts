import { promises as fs } from "fs";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { runIosProfilerPipeline } from "../../../utils/ios-profiler/pipeline/index";
import type { IosProfilerAnalyzeResult } from "../../../utils/ios-profiler/types";
import { renderIosProfilerReport } from "../../../utils/ios-profiler/render";

/**
 * Distinguish "export skipped" (path null) from "export landed but the file
 * is gone/unreadable" (path set, fs.access throws). The XML parsers use
 * try/catch returning [] so a missing file silently produces empty data —
 * we have to pre-flight here to surface a real warning to the user.
 */
async function checkExportFileMissing(filePath: string | null): Promise<string | null> {
  if (!filePath) return null;
  try {
    await fs.access(filePath);
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return `not found at \`${filePath}\``;
    if (code === "EACCES") return `unreadable (permission denied) at \`${filePath}\``;
    return `unreadable at \`${filePath}\` (${code ?? "unknown error"})`;
  }
}

const zodSchema = z.object({
  device_id: z.string().describe("Target device id from `list-devices`. Currently iOS-only."),
});

export const nativeProfilerAnalyzeTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  IosProfilerAnalyzeResult
> = {
  id: "native-profiler-analyze",
  requires: ["xcrun"],
  capability: { apple: { simulator: true, device: true } },
  description: `Analyze exported native trace data and return an LLM-optimized markdown report.
iOS: parses CPU time profile, UI hangs, and memory leaks from the exported XML files.
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
  async execute(services) {
    const api = services.session as NativeProfilerSessionApi;

    if (!api.exportedFiles) {
      throw new Error("No exported trace data found. Call native-profiler-stop first.");
    }

    // Pre-flight every set path: if the file is missing/unreadable the parsers
    // silently produce [], which would otherwise render as "All clear".
    const [cpuMissing, hangsMissing, leaksMissing] = await Promise.all([
      checkExportFileMissing(api.exportedFiles.cpu ?? null),
      checkExportFileMissing(api.exportedFiles.hangs ?? null),
      checkExportFileMissing(api.exportedFiles.leaks ?? null),
    ]);

    const { bottlenecks, cpuSamples, uiHangs, cpuHotspots, memoryLeaks } =
      await runIosProfilerPipeline(api.exportedFiles);

    api.parsedData = { cpuSamples, uiHangs, cpuHotspots, memoryLeaks };

    const exportErrors: Record<string, string> = {};
    if (!api.exportedFiles.cpu) {
      exportErrors.cpu =
        "CPU time-profile export failed — xctrace could not export CPU data from this trace. " +
        "The trace template may not include a Time Profiler instrument, or the schema name " +
        "did not match any known CPU profile schema (time-profile, cpu-profile, time-sample). " +
        "Check native-profiler-stop output for exportDiagnostics.";
    } else if (cpuMissing) {
      exportErrors.cpu =
        `CPU time-profile export ${cpuMissing} — the trace export claims it succeeded but the ` +
        `file is gone or unreadable, so no CPU data could be analyzed. Re-run native-profiler-stop.`;
    }
    if (!api.exportedFiles.hangs) {
      exportErrors.hangs = "Hangs export failed — no potential-hangs table found in trace.";
    } else if (hangsMissing) {
      exportErrors.hangs =
        `Hangs export ${hangsMissing} — the trace export claims it succeeded but the file is gone ` +
        `or unreadable, so no hang data could be analyzed. Re-run native-profiler-stop.`;
    }
    if (api.exportedFiles.leaks && leaksMissing) {
      exportErrors.leaks =
        `Leaks export ${leaksMissing} — the trace export claims it succeeded but the file is gone ` +
        `or unreadable, so no leak data could be analyzed. Re-run native-profiler-stop.`;
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
