import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import {
  nativeProfilerSessionRef,
  type NativeProfilerSessionApi,
} from "../../../blueprints/native-profiler-session";
import { resolveDevice } from "../../../utils/device-info";
import { assertSupported } from "../../../utils/capability";
import { ensureDeps } from "../../../utils/check-deps";
import { stopNativeProfilerIos, type IosStopResult } from "./platforms/ios";
import { stopNativeProfilerAndroid, type AndroidStopResult } from "./platforms/android";
import type { ExportDiagnostics } from "../../../utils/ios-profiler/export";
import { getArtifactRegistry, type ArtifactHandle } from "../../../artifacts";

const zodSchema = z.object({
  device_id: z
    .string()
    .describe("Target device id from `list-devices` (iOS UDID or Android serial)."),
});

interface StopResult {
  /**
   * The raw trace bundle as an artifact handle. On iOS it's the Instruments
   * `.trace` directory (delivered as a gzipped tar when a remote client
   * downloads it; local clients use the bundle in place); on Android it's the
   * pulled `.pftrace` file.
   */
  traceFile: ArtifactHandle;
  /** Exported data as artifact handles the MCP client materializes locally. */
  exportedFiles: Record<string, ArtifactHandle | null>;
  /** Present for iOS; describes how each XML export was produced. */
  exportDiagnostics?: ExportDiagnostics;
  warning?: string;
}

const capability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

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

/**
 * Register the trace bundle for download. Marked `archive: "tar.gz"` so it
 * works even when the path is a directory (iOS `.trace`), and even if it can't
 * be stat'd at registration (e.g. a recovered session).
 */
function registerTrace(traceFile: string): Promise<ArtifactHandle> {
  return getArtifactRegistry().register(traceFile, { archive: "tar.gz" });
}

export const nativeProfilerStopTool: ToolDefinition<z.infer<typeof zodSchema>, StopResult> = {
  id: "native-profiler-stop",
  capability,
  description: `Stop native profiling and export trace data.
iOS: sends SIGINT to xctrace, waits for packaging, then exports CPU, hangs, and leaks XML.
Android: sends SIGTERM to the perfetto daemon, polls /proc/<pid>, then \`adb pull\`s the .pftrace.
Call native-profiler-start first.
Use when the user has finished the interaction to profile and you need to export the trace.
Returns { traceFile, exportedFiles, exportDiagnostics? }; traceFile is the raw trace bundle and exportedFiles the exports, all downloadable artifacts materialized to local paths.
Fails if no active native-profiler-start session exists for the given device_id.`,
  zodSchema,
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params) {
    const api = services.session as NativeProfilerSessionApi;
    const device = resolveDevice(params.device_id);
    assertSupported("native-profiler-stop", capability, device);

    let platformResult: IosStopResult | AndroidStopResult;
    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      platformResult = await stopNativeProfilerIos(api);
    } else {
      await ensureDeps(["adb"]);
      platformResult = await stopNativeProfilerAndroid(api);
    }

    const stopResult: StopResult = {
      traceFile: await registerTrace(platformResult.traceFile),
      exportedFiles: await exportedFilesToArtifacts(platformResult.exportedFiles),
    };
    if ("exportDiagnostics" in platformResult) {
      stopResult.exportDiagnostics = platformResult.exportDiagnostics;
    }
    if (platformResult.warning) stopResult.warning = platformResult.warning;
    return stopResult;
  },
};
