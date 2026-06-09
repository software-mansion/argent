import { promises as fs } from "fs";
import * as path from "path";
import type { NativeProfilerRecordingMode } from "../../blueprints/native-profiler-session";

/**
 * Sidecar metadata written next to a native-profiler trace's exported XML.
 *
 * Native profiler session state lives in-memory on whichever tool-server
 * process ran `native-profiler-start`. If a *different* process later handles
 * `profiler-load load_native` (multiple detached servers, or a restart), it has
 * no idea the trace was a host all-processes capture that must be filtered to a
 * specific PID. Persisting that here lets any process reconstruct an app-scoped
 * analysis from disk alone.
 */
export interface NativeProfilerMetadata {
  mode: NativeProfilerRecordingMode | null;
  processFilterPid: string | null;
  appProcess: string | null;
}

/** `<dir>/native-profiler-<ts>.trace` → `<dir>/native-profiler-<ts>_meta.json`. */
export function metadataPathForTrace(traceFile: string): string {
  const dir = path.dirname(traceFile);
  const baseName = path.basename(traceFile, ".trace");
  return path.join(dir, `${baseName}_meta.json`);
}

/** `<debugDir>/native-profiler-<sid>_meta.json`. */
export function metadataPathForSession(debugDir: string, sessionId: string): string {
  return path.join(debugDir, `native-profiler-${sessionId}_meta.json`);
}

export async function writeNativeProfilerMetadata(
  traceFile: string,
  meta: NativeProfilerMetadata
): Promise<void> {
  try {
    await fs.writeFile(metadataPathForTrace(traceFile), JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // Non-fatal: the sidecar only powers cross-process disk reloads; the live
    // session still has the data in memory.
  }
}

export async function readNativeProfilerMetadata(
  metaPath: string
): Promise<NativeProfilerMetadata | null> {
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<NativeProfilerMetadata>;
    return {
      mode: parsed.mode ?? null,
      processFilterPid: parsed.processFilterPid ?? null,
      appProcess: parsed.appProcess ?? null,
    };
  } catch {
    return null;
  }
}
