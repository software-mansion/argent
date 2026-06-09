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
  longRunning: true,
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

    // The host all-processes fallback (used when the simulator Instruments tap
    // is broken) is CPU-only: Leaks/Allocations cannot target "All Processes",
    // so hangs/leaks are *expected* to be absent and must not be reported as
    // failures. CPU is the sole data source in that mode.
    const isHostFallback = api.recordingMode === "host-all-processes";

    // Pre-flight every set path: if the file is missing/unreadable the parsers
    // silently produce [], which would otherwise render as "All clear".
    const [cpuMissing, hangsMissing, leaksMissing] = await Promise.all([
      checkExportFileMissing(api.exportedFiles.cpu ?? null),
      checkExportFileMissing(api.exportedFiles.hangs ?? null),
      checkExportFileMissing(api.exportedFiles.leaks ?? null),
    ]);

    const { bottlenecks, cpuSamples, uiHangs, cpuHotspots, memoryLeaks } =
      await runIosProfilerPipeline(api.exportedFiles, api.processFilterPid ?? null);

    api.parsedData = { cpuSamples, uiHangs, cpuHotspots, memoryLeaks };

    const exportErrors: Record<string, string> = {};
    const cpuOk = !!api.exportedFiles.cpu && !cpuMissing;
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
    // In host-fallback mode, hangs/leaks are intentionally not captured — skip
    // the "export failed" warnings that would otherwise be noise.
    if (!isHostFallback) {
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
    }

    const modeNote = isHostFallback
      ? `Captured via host all-processes fallback (the simulator Instruments tap could not package a ` +
        `\`--device\` trace). CPU-only and scoped to ${api.appProcess ?? "the app"} (pid: ${api.processFilterPid}) — hangs and leaks are unavailable in this mode.`
      : undefined;

    // Decide whether the analysis is inconclusive: no data source could be
    // read at all, or (host mode) the CPU file read but nothing matched the
    // app PID. Either way, zero findings is meaningless and must not render as
    // "All clear".
    let inconclusive: { reason: string } | undefined;
    if (isHostFallback) {
      if (!cpuOk) {
        inconclusive = {
          reason:
            "The host all-processes Time Profiler trace produced no readable CPU export, so there was " +
            "nothing to analyze for the app.",
        };
      } else if (cpuSamples.length === 0) {
        inconclusive = {
          reason:
            `The host all-processes trace exported CPU data, but no samples matched ${api.appProcess ?? "the app"} ` +
            `(pid: ${api.processFilterPid}). The app may have been idle during the recording, or it was not the ` +
            `running process. Interact with the app while recording, then stop.`,
        };
      }
    } else {
      const hangsOk = !!api.exportedFiles.hangs && !hangsMissing;
      const leaksOk = !!api.exportedFiles.leaks && !leaksMissing;
      if (!cpuOk && !hangsOk && !leaksOk) {
        inconclusive = {
          reason:
            "None of the CPU, hangs, or leaks exports could be read, so there was no trace data to analyze. " +
            "The recording likely failed to package (see native-profiler-stop exportDiagnostics).",
        };
      }
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
      inconclusive,
      mode: api.recordingMode ?? undefined,
      modeNote,
    });
  },
};
