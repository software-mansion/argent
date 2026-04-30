import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  IOS_PROFILER_SESSION_NAMESPACE,
  type IosProfilerSessionApi,
} from "../../../blueprints/ios-profiler-session";
import { exportIosTraceData } from "../../../utils/ios-profiler/export";
import type { ExportDiagnostics } from "../../../utils/ios-profiler/export";
import { shutdownChild } from "../../../utils/ios-profiler/lifecycle";

const STOP_GRACE_MS = 30_000;
const STOP_TERM_MS = 5_000;
const STOP_KILL_MS = 5_000;

const zodSchema = z.object({
  device_id: z.string().describe("iOS Simulator or device UDID"),
});

interface StopResult {
  traceFile: string;
  exportedFiles: Record<string, string | null>;
  exportDiagnostics: ExportDiagnostics;
  warning?: string;
}

export const iosInstrumentsStopTool: ToolDefinition<z.infer<typeof zodSchema>, StopResult> = {
  id: "ios-profiler-stop",
  description: `Stop iOS Instruments profiling and export trace data to XML files.
Sends SIGINT to the running xctrace process, waits for it to finish packaging the trace,
then exports CPU, hangs, and leaks data. Call ios-profiler-start first.
Use when the user has finished the interaction to profile and you need to export the trace.
Returns { traceFile, exportedFiles, exportDiagnostics } with paths to the exported XML data.
Fails if no active ios-profiler-start session exists for the given device_id.`,
  zodSchema,
  services: (params) => ({
    session: `${IOS_PROFILER_SESSION_NAMESPACE}:${params.device_id}`,
  }),
  async execute(services) {
    const api = services.session as IosProfilerSessionApi;

    // P3: recover a recording that hit the in-process 10-min cap. The trace
    // file is still on disk; export it instead of returning "no active session".
    if (api.recordingTimedOut && api.traceFile) {
      const traceFile = api.traceFile;
      api.recordingTimedOut = false;
      const { files: exportedFiles, diagnostics } = exportIosTraceData(traceFile);
      api.exportedFiles = exportedFiles;
      return {
        traceFile,
        exportedFiles,
        exportDiagnostics: diagnostics,
        warning:
          "Recording timed out at 10 min cap; exported the partial trace. " +
          "Call ios-profiler-start again for a fresh recording.",
      };
    }

    if (!api.profilingActive || !api.xctraceProcess || !api.traceFile) {
      throw new Error("No active iOS profiling session found. Call ios-profiler-start first.");
    }

    if (api.recordingTimeout) {
      clearTimeout(api.recordingTimeout);
      api.recordingTimeout = null;
    }

    const result = await shutdownChild(api.xctraceProcess, {
      graceMs: STOP_GRACE_MS,
      termMs: STOP_TERM_MS,
      killMs: STOP_KILL_MS,
    });

    let warning: string | undefined;
    if (!result.clean) {
      warning =
        `xctrace did not respond to SIGINT${result.signalUsed === "SIGKILL" ? "/SIGTERM" : ""}; ` +
        `${result.signalUsed} was used. Trace bundle may be incomplete.`;
      process.stderr.write(`[ios-profiler] ${warning}\n`);
    }

    api.profilingActive = false;
    api.xctracePid = null;
    api.xctraceProcess = null;

    const { files: exportedFiles, diagnostics } = exportIosTraceData(api.traceFile);
    api.exportedFiles = exportedFiles;

    const stopResult: StopResult = {
      traceFile: api.traceFile,
      exportedFiles,
      exportDiagnostics: diagnostics,
    };
    if (warning) stopResult.warning = warning;
    return stopResult;
  },
};
