import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  IOS_PROFILER_SESSION_NAMESPACE,
  type IosProfilerSessionApi,
} from "../../../blueprints/ios-profiler-session";
import { exportIosTraceData } from "../../../utils/ios-profiler/export";
import type { ExportDiagnostics } from "../../../utils/ios-profiler/export";

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

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
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

    if (!api.profilingActive || !api.xctracePid || !api.traceFile) {
      throw new Error("No active iOS profiling session found. Call ios-profiler-start first.");
    }

    if (api.recordingTimeout) {
      clearTimeout(api.recordingTimeout);
      api.recordingTimeout = null;
    }

    const pidToKill = api.xctracePid;
    try {
      process.kill(pidToKill, "SIGINT");
    } catch {
      // already dead
    }

    let exited = await waitForExit(pidToKill, STOP_GRACE_MS);
    let warning: string | undefined;
    if (!exited) {
      try {
        process.kill(pidToKill, "SIGTERM");
      } catch {
        // already dead
      }
      exited = await waitForExit(pidToKill, STOP_TERM_MS);
    }
    if (!exited) {
      try {
        process.kill(pidToKill, "SIGKILL");
      } catch {
        // already dead
      }
      await waitForExit(pidToKill, STOP_KILL_MS);
      warning =
        "xctrace did not respond to SIGINT/SIGTERM; SIGKILL was used. " +
        "Trace bundle may be incomplete.";
      process.stderr.write(`[ios-profiler] ${warning}\n`);
    }

    api.profilingActive = false;
    api.xctracePid = null;

    const { files: exportedFiles, diagnostics } = exportIosTraceData(api.traceFile);
    api.exportedFiles = exportedFiles;

    const result: StopResult = {
      traceFile: api.traceFile,
      exportedFiles,
      exportDiagnostics: diagnostics,
    };
    if (warning) result.warning = warning;
    return result;
  },
};
