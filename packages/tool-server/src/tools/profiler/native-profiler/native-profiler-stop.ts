import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { exportIosTraceData } from "../../../utils/ios-profiler/export";
import type { ExportDiagnostics } from "../../../utils/ios-profiler/export";
import { shutdownChild } from "../../../utils/ios-profiler/lifecycle";
import { getArtifactRegistry, type ArtifactHandle } from "../../../artifacts";

const STOP_GRACE_MS = 30_000;
const STOP_TERM_MS = 5_000;
const STOP_KILL_MS = 5_000;

// The raw `.trace` is an Instruments bundle (a directory), not a single file,
// so it isn't streamable through the artifact layer yet (archiving is a
// follow-up). The exported XML files are what's useful to inspect, and they
// ARE materialized to the client. This note explains the absence.
const TRACE_FILE_NOTE =
  "The raw .trace bundle remains on the profiling host (it's a directory; " +
  "archiving for download is a follow-up). The exported XML files below are " +
  "materialized locally.";

const zodSchema = z.object({
  device_id: z.string().describe("Target device id from `list-devices`. Currently iOS-only."),
});

interface StopResult {
  /** Exported XML data as artifact handles the MCP client materializes locally. */
  exportedFiles: Record<string, ArtifactHandle | null>;
  traceFileNote: string;
  exportDiagnostics: ExportDiagnostics;
  warning?: string;
}

/** Register each non-null exported file path as a downloadable artifact. */
async function exportedFilesToArtifacts(
  files: Record<string, string | null>
): Promise<Record<string, ArtifactHandle | null>> {
  const registry = getArtifactRegistry();
  const out: Record<string, ArtifactHandle | null> = {};
  for (const [key, filePath] of Object.entries(files)) {
    out[key] = filePath ? await registry.register(filePath) : null;
  }
  return out;
}

export const nativeProfilerStopTool: ToolDefinition<z.infer<typeof zodSchema>, StopResult> = {
  id: "native-profiler-stop",
  requires: ["xcrun"],
  capability: { apple: { simulator: true, device: true } },
  description: `Stop native profiling and export trace data to XML files.
iOS: sends SIGINT to xctrace, waits for packaging, then exports CPU, hangs, and leaks data. Call native-profiler-start first.
Use when the user has finished the interaction to profile and you need to export the trace.
Returns { exportedFiles, traceFileNote, exportDiagnostics }; exportedFiles are downloadable artifacts materialized to local paths.
Fails if no active native-profiler-start session exists for the given device_id.`,
  zodSchema,
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services) {
    const api = services.session as NativeProfilerSessionApi;

    // Recover a recording where xctrace is already gone but the trace bundle
    // is on disk: either the in-process 10-min cap fired, or xctrace exited
    // unexpectedly (attached app died, simulator daemon hiccup, etc).
    if ((api.recordingTimedOut || api.recordingExitedUnexpectedly) && api.traceFile) {
      const traceFile = api.traceFile;
      const wasTimeout = api.recordingTimedOut;
      const exitInfo = api.lastExitInfo;
      api.recordingTimedOut = false;
      api.recordingExitedUnexpectedly = false;
      api.lastExitInfo = null;

      const { files: exportedFiles, diagnostics } = exportIosTraceData(traceFile);
      api.exportedFiles = exportedFiles;

      const exportedArtifacts = await exportedFilesToArtifacts(exportedFiles);

      const warning = wasTimeout
        ? "Recording timed out at 10 min cap; exported the partial trace. " +
          "Call native-profiler-start again for a fresh recording."
        : `xctrace exited before stop was called (code=${exitInfo?.code ?? "?"}, ` +
          `signal=${exitInfo?.signal ?? "?"}); exported the partial trace. ` +
          "Common causes: attached app terminated, simulator daemon restart. " +
          "Call native-profiler-start again for a fresh recording.";
      process.stderr.write(`[native-profiler] ${warning}\n`);

      return {
        exportedFiles: exportedArtifacts,
        traceFileNote: TRACE_FILE_NOTE,
        exportDiagnostics: diagnostics,
        warning,
      };
    }

    if (!api.profilingActive || !api.xctraceProcess || !api.traceFile) {
      throw new Error(
        "No active native profiling session found. Call native-profiler-start first."
      );
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
      process.stderr.write(`[native-profiler] ${warning}\n`);
    }

    api.profilingActive = false;
    api.xctracePid = null;
    api.xctraceProcess = null;
    api.recordingExitedUnexpectedly = false;
    api.lastExitInfo = null;

    const { files: exportedFiles, diagnostics } = exportIosTraceData(api.traceFile);
    api.exportedFiles = exportedFiles;

    const stopResult: StopResult = {
      exportedFiles: await exportedFilesToArtifacts(exportedFiles),
      traceFileNote: TRACE_FILE_NOTE,
      exportDiagnostics: diagnostics,
    };
    if (warning) stopResult.warning = warning;
    return stopResult;
  },
};
