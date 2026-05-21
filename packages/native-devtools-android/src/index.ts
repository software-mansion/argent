import * as path from "node:path";
import * as fs from "node:fs";

// When bundled by esbuild, __dirname points into dist/.
// ARGENT_NATIVE_DEVTOOLS_ANDROID_DIR lets the launcher override the bin
// directory, matching the same pattern used by ARGENT_SIMULATOR_SERVER_DIR.
const BIN_DIR =
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_DIR ?? path.join(__dirname, "..", "bin");

/**
 * Path to the Perfetto `trace_processor_shell` binary. Lazy — throws only when
 * called, not at module load — so iOS-only environments that import this
 * package transitively (e.g. through the cross-platform `native-profiler-*`
 * tools) never trip the existence check.
 */
export function traceProcessorShellPath(): string {
  const p = path.join(BIN_DIR, "trace_processor_shell");
  if (!fs.existsSync(p)) {
    throw new Error(
      `trace_processor_shell binary not found: ${p}. Run ./scripts/download-native-binaries.sh to fetch it.`
    );
  }
  return p;
}

export function traceProcessorShellAvailable(): boolean {
  return fs.existsSync(path.join(BIN_DIR, "trace_processor_shell"));
}

export function traceProcessorShellDir(): string {
  return BIN_DIR;
}
