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
  description: `Stop iOS Instruments profiling and export the collected trace data to XML files for analysis.
Use when the profiling interaction is complete and you are ready to analyze results with ios-profiler-analyze. Sends SIGINT to xctrace, waits for packaging, then exports CPU, hang, and leak data.

Parameters: device_id — the simulator or device UDID used when starting (e.g. A1B2C3D4-E5F6-7890-ABCD-EF1234567890).
Example: { "device_id": "A1B2C3D4-E5F6-7890-ABCD-EF1234567890" }
Returns { traceFile, exportedFiles: { cpu, hangs, leaks }, exportDiagnostics }. Fails if no active profiling session exists — call ios-profiler-start first.`,
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
