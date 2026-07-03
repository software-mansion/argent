import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import type { ArtifactOutputMap } from "@argent/artifacts";
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
import { requireArtifacts, type ArtifactHandle } from "../../../artifacts";
import type { ArtifactRegistrar } from "@argent/registry";

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

const artifacts = {
  trace: {
    kind: "native-profile-trace",
  },
  pftrace: {
    kind: "native-profile-trace",
  },
  cpu: {
    kind: "native-profile-cpu",
  },
  hangs: {
    kind: "native-profile-hangs",
  },
  leaks: {
    kind: "native-profile-leaks",
  },
} satisfies ArtifactOutputMap;

type ArtifactOutputName = Extract<keyof typeof artifacts, string>;

const EXPORTED_FILE_OUTPUT_BY_KEY: Record<string, ArtifactOutputName> = {
  cpu: "cpu",
  hangs: "hangs",
  leaks: "leaks",
  pftrace: "pftrace",
};

/** Register each non-null exported file path as a downloadable artifact. */
async function exportedFilesToArtifacts(
  artifacts: ArtifactRegistrar<ArtifactOutputName>,
  files: Record<string, string | null>
): Promise<Record<string, ArtifactHandle | null>> {
  const out: Record<string, ArtifactHandle | null> = {};
  for (const [key, filePath] of Object.entries(files)) {
    out[key] = filePath
      ? await artifacts.register(EXPORTED_FILE_OUTPUT_BY_KEY[key] ?? "trace", {
          hostPath: filePath,
        })
      : null;
  }
  return out;
}

/**
 * Register the trace bundle for download. Marked `archive: "tar.gz"` so it
 * works even when the path is a directory (iOS `.trace`), and even if it can't
 * be stat'd at registration (e.g. a recovered session).
 */
function registerTrace(
  artifacts: ArtifactRegistrar<ArtifactOutputName>,
  traceFile: string
): Promise<ArtifactHandle> {
  return artifacts.register("trace", { hostPath: traceFile, archive: "tar.gz" });
}

export const nativeProfilerStopTool: ToolDefinition<
  z.infer<typeof zodSchema>,
  StopResult,
  typeof artifacts
> = {
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
  artifacts,
  services: (params) => ({
    session: nativeProfilerSessionRef(resolveDevice(params.device_id)),
  }),
  async execute(services, params, ctx) {
    const api = services.session as NativeProfilerSessionApi;
    const device = resolveDevice(params.device_id);
    assertSupported("native-profiler-stop", capability, device);

    // Wrap each platform's raw host paths as downloadable artifacts. Kept per
    // branch (rather than one merged object) so the return type preserves the
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
