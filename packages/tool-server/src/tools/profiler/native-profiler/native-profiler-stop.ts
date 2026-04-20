import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  NATIVE_PROFILER_SESSION_NAMESPACE,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { exportIosTraceData } from "../../../utils/ios-profiler/export";
import type { ExportDiagnostics } from "../../../utils/ios-profiler/export";

const zodSchema = z.object({
  device_id: z.string().describe("Target device id from `list-devices`. Currently iOS-only."),
});

export const nativeProfilerStopTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  {
    traceFile: string;
    exportedFiles: Record<string, string | null>;
    exportDiagnostics: ExportDiagnostics;
  }
> = {
  id: "native-profiler-stop",
  requires: ["xcrun"],
  description: `Stop native profiling and export trace data to XML files.
iOS: sends SIGINT to xctrace, waits for packaging, then exports CPU, hangs, and leaks data. Call native-profiler-start first.
Use when the user has finished the interaction to profile and you need to export the trace.
Returns { traceFile, exportedFiles, exportDiagnostics } with paths to the exported XML data.
Fails if no active native-profiler-start session exists for the given device_id.`,
  zodSchema,
  services: (params) => ({
    session: `${NATIVE_PROFILER_SESSION_NAMESPACE}:${params.device_id}`,
  }),
  async execute(services) {
    const api = services.session as NativeProfilerSessionApi;

    if (!api.profilingActive || !api.xctracePid || !api.traceFile) {
      throw new Error("No active native profiling session found. Call native-profiler-start first.");
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
