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
import {
  stopNativeProfilerAndroid,
  type AndroidExportKey,
  type AndroidStopResult,
} from "./platforms/android";
import type { ExportDiagnostics, IosExportKey } from "../../../utils/ios-profiler/export";
import { requireArtifacts, type ArtifactHandle } from "../../../artifacts";
import type { ArtifactKind, ArtifactStore } from "@argent/registry";
import { metroDeviceIdParam } from "../../../utils/debugger/device-id-param";

const zodSchema = z.object({
  device_id: metroDeviceIdParam(
    "Target device id from `list-devices` (iOS UDID or Android serial)."
  ),
});

/**
 * Mirrors {@link IosStopResult}, but the file paths are artifact handles the
 * MCP client materializes locally instead of raw host paths.
 */
export interface IosStopArtifacts {
  /**
   * The Instruments `.trace` bundle: a directory, so a remote client downloads
   * it as a gzipped tar while a local one uses it in place.
   */
  traceFile: ArtifactHandle;
  exportedFiles: Record<IosExportKey, ArtifactHandle | null>;
  exportDiagnostics: ExportDiagnostics;
  warning?: string;
}

/**
 * Mirrors {@link AndroidStopResult}, with artifact handles in place of host
 * paths; unlike iOS there's no `exportDiagnostics` (the `.pftrace` is pulled
 * whole, not exported per-schema).
 */
interface AndroidStopArtifacts {
  traceFile: ArtifactHandle;
  exportedFiles: Record<AndroidExportKey, ArtifactHandle | null>;
  warning?: string;
}

type StopResult = IosStopArtifacts | AndroidStopArtifacts;

const capability = {
  apple: { simulator: true, device: true },
  android: { emulator: true, device: true, unknown: true },
} as const;

/**
 * Artifact kind for each exported file, total over every key both platforms
 * can produce. A new export key added to {@link IosExportKey} or
 * {@link AndroidExportKey} fails to compile here until it is classified —
 * nothing is ever silently defaulted.
 */
const EXPORTED_FILE_KINDS: Record<IosExportKey | AndroidExportKey, ArtifactKind> = {
  cpu: "native-profile-cpu",
  hangs: "native-profile-hangs",
  leaks: "native-profile-leaks",
  pftrace: "native-profile-trace",
};

/** Register each non-null exported file path as a downloadable artifact. */
async function exportedFilesToArtifacts<K extends IosExportKey | AndroidExportKey>(
  store: ArtifactStore,
  files: Record<K, string | null>
): Promise<Record<K, ArtifactHandle | null>> {
  const out = {} as Record<K, ArtifactHandle | null>;
  for (const key of Object.keys(files) as K[]) {
    const filePath = files[key];
    out[key] = filePath
      ? await store.register({ hostPath: filePath, kind: EXPORTED_FILE_KINDS[key] })
      : null;
  }
  return out;
}

/**
 * `archive: "tar.gz"` so registration works for a directory path (iOS `.trace`)
 * and for a path that can't be stat'd yet (e.g. a recovered session).
 */
function registerTrace(store: ArtifactStore, traceFile: string): Promise<ArtifactHandle> {
  return store.register({ hostPath: traceFile, kind: "native-profile-trace", archive: "tar.gz" });
}

export const nativeProfilerStopTool: ToolDefinition<z.infer<typeof zodSchema>, StopResult> = {
  id: "native-profiler-stop",
  interaction: {
    startedMsg: () => "Stopping native profiler",
    completedMsg: ({ result }) => `Saved native profile ${result.traceFile.filename}`,
    failedMsg: ({ failureSignal }) => `Failed to stop native profiler: ${failureSignal.error_code}`,
  },
  capability,
  // Packaging plus the export passes routinely exceed the 30s MCP fetch timeout.
  longRunning: true,
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
  async execute(services, params, ctx) {
    const api = services.session as NativeProfilerSessionApi;
    const device = resolveDevice(params.device_id);
    assertSupported("native-profiler-stop", capability, device);

    // Kept per branch rather than merged so the return type preserves the
    // iOS/Android distinction: iOS always carries exportDiagnostics, Android
    // never does. The artifact store is resolved only after a successful stop —
    // the "no active session" error path never needs it.
    if (api.platform === "ios") {
      await ensureDeps(["xcrun"]);
      const ios: IosStopResult = await stopNativeProfilerIos(api);
      const artifacts = requireArtifacts(ctx);
      const result: IosStopArtifacts = {
        traceFile: await registerTrace(artifacts, ios.traceFile),
        exportedFiles: await exportedFilesToArtifacts(artifacts, ios.exportedFiles),
        exportDiagnostics: ios.exportDiagnostics,
      };
      if (ios.warning) result.warning = ios.warning;
      return result;
    }

    await ensureDeps(["adb"]);
    const android: AndroidStopResult = await stopNativeProfilerAndroid(api);
    const artifacts = requireArtifacts(ctx);
    const result: AndroidStopArtifacts = {
      traceFile: await registerTrace(artifacts, android.traceFile),
      exportedFiles: await exportedFilesToArtifacts(artifacts, android.exportedFiles),
    };
    if (android.warning) result.warning = android.warning;
    return result;
  },
};
