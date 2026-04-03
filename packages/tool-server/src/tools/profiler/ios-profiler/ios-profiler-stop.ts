import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  IOS_PROFILER_SESSION_NAMESPACE,
  type IosProfilerSessionApi,
} from "../../../blueprints/ios-profiler-session";
import { exportIosTraceData } from "../../../utils/ios-profiler/export";
import type { ExportDiagnostics } from "../../../utils/ios-profiler/export";

const zodSchema = z.object({
  device_id: z.string().describe("iOS Simulator or device UDID"),
});

export const iosInstrumentsStopTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    traceFile: string;
    exportedFiles: Record<string, string | null>;
    exportDiagnostics: ExportDiagnostics;
  }
> = {
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

    if (!api.profilingActive || !api.xctracePid || !api.traceFile) {
      throw new Error("No active iOS profiling session found. Call ios-profiler-start first.");
    }

    if (api.recordingTimeout) {
      clearTimeout(api.recordingTimeout);
      api.recordingTimeout = null;
    }

    const pidToKill = api.xctracePid;
    process.kill(pidToKill, "SIGINT");

    // Wait for xctrace process to finish packaging
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        try {
          process.kill(pidToKill, 0);
        } catch {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });

    api.profilingActive = false;
    api.xctracePid = null;

    const { files: exportedFiles, diagnostics } = exportIosTraceData(api.traceFile);
    api.exportedFiles = exportedFiles;

    return {
      traceFile: api.traceFile,
      exportedFiles,
      exportDiagnostics: diagnostics,
    };
  },
};
