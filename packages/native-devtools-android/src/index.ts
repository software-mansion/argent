import * as path from "node:path";
import * as fs from "node:fs";

// When bundled by esbuild, __dirname points into dist/.
// ARGENT_NATIVE_DEVTOOLS_ANDROID_DIR lets the launcher override the bin
// directory, matching the same pattern used by ARGENT_SIMULATOR_SERVER_DIR.
const BIN_DIR =
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_DIR ?? path.join(__dirname, "..", "bin");

// Queries live next to bin/ at the package root in dev mode, and next to
// dist/ in the packaged argent bundle (copied there by argent's build script).
const QUERIES_DIR =
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_QUERIES_DIR ??
  path.join(__dirname, "..", "queries");

// TraceConfig (textproto) template — same dev/bundled resolution as queries.
const TRACE_CONFIG_PATH =
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_TRACECFG ??
  path.join(__dirname, "..", "argent.tracecfg.pbtxt");

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

/**
 * Directory containing the PerfettoSQL query files (`*.sql`) used by
 * `runTpQuery`. Source-of-truth lives here in the native-devtools-android
 * package; argent's bundler copies them next to the bundled tool-server at
 * publish time so the same `path.join(__dirname, "..", "queries")` resolution
 * works in both dev and published modes.
 */
export function traceProcessorQueriesDir(): string {
  return QUERIES_DIR;
}

/**
 * Path to the bundled Perfetto TraceConfig template (`argent.tracecfg.pbtxt`).
 * Callers read this and substitute `TARGET_*_PLACEHOLDER` tokens before
 * passing the config to `perfetto`.
 */
export function traceConfigPath(): string {
  return TRACE_CONFIG_PATH;
}
