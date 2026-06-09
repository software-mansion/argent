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

/**
 * iOS stop result with files exposed as downloadable artifacts. Mirrors
 * {@link IosStopResult}, but `traceFile`/`exportedFiles` are artifact handles
 * the MCP client materializes locally instead of raw host paths.
 */
export interface IosStopArtifacts {
  /**
   * The Instruments `.trace` bundle as an artifact handle. It's a directory, so
   * it's delivered as a gzipped tar when a remote client downloads it; local
   * clients use the bundle in place.
   */
  traceFile: ArtifactHandle;
  exportedFiles: Record<string, ArtifactHandle | null>;
  exportDiagnostics: ExportDiagnostics;
  warning?: string;
}

/**
 * Android stop result with files exposed as downloadable artifacts. Mirrors
 * {@link AndroidStopResult}; unlike iOS there's no `exportDiagnostics` (the
 * `.pftrace` is pulled whole, not exported per-schema).
 */
interface AndroidStopArtifacts {
  /** The pulled `.pftrace` file as a downloadable artifact handle. */
  traceFile: ArtifactHandle;
  exportedFiles: Record<string, ArtifactHandle | null>;
  warning?: string;
}

type StopResult = IosStopArtifacts | AndroidStopArtifacts;

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

    // Wrap each platform's raw host paths as downloadable artifacts. Kept per
    // branch (rather than one merged object) so the return type preserves the
    // iOS/Android distinction: iOS always carries exportDiagnostics, Android
    // never does.
    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      const ios: IosStopResult = await stopNativeProfilerIos(api);
      const result: IosStopArtifacts = {
        traceFile: await registerTrace(ios.traceFile),
        exportedFiles: await exportedFilesToArtifacts(ios.exportedFiles),
        exportDiagnostics: ios.exportDiagnostics,
      };
      if (ios.warning) result.warning = ios.warning;
      return result;
    }

    await ensureDeps(["adb"]);
    const android: AndroidStopResult = await stopNativeProfilerAndroid(api);
    const result: AndroidStopArtifacts = {
      traceFile: await registerTrace(android.traceFile),
      exportedFiles: await exportedFilesToArtifacts(android.exportedFiles),
    };
    if (android.warning) result.warning = android.warning;
    return result;
  },
};
