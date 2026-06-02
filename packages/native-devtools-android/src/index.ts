import * as path from "node:path";
import * as fs from "node:fs";

// esbuild puts __dirname in dist/, so `__dirname/..` is the package root in both
// modes (the source package in dev, the published argent package when bundled).
// Two sibling dirs hold this package's runtime data: bin/ (gitignored native
// binaries — trace_processor_shell + helper APK) and assets/ (committed data —
// queries/, argent.tracecfg.pbtxt, manifest.json).
//
// ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR overrides bin/, like ARGENT_SIMULATOR_SERVER_DIR.
const BIN_DIR =
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR ?? path.join(__dirname, "..", "bin");

// PerfettoSQL query files, under assets/ in both dev and the packaged bundle.
const QUERIES_DIR =
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_QUERIES_DIR ??
  path.join(__dirname, "..", "assets", "queries");

// TraceConfig (textproto) template — same dev/bundled resolution as queries.
const TRACE_CONFIG_PATH =
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_TRACECFG ??
  path.join(__dirname, "..", "assets", "argent.tracecfg.pbtxt");

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
 * package's `assets/queries/`; argent's bundler copies them to
 * `argent/assets/queries/` at publish time so the same
 * `path.join(__dirname, "..", "assets", "queries")` resolution works in both
 * dev and published modes.
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

interface HelperManifest {
  packageName: string;
  instrumentationRunner: string;
  versionName: string;
  versionCode: number;
  installFlags: string[];
}

let cachedManifest: HelperManifest | null = null;

export function helperManifest(): HelperManifest {
  if (cachedManifest) return cachedManifest;
  const manifestPath = path.join(__dirname, "..", "assets", "manifest.json");
  cachedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as HelperManifest;
  return cachedManifest;
}

export function bundledHelperApkPath(): string {
  const manifest = helperManifest();
  const apk = path.join(BIN_DIR, `argent-android-devtools-${manifest.versionName}.apk`);
  if (!fs.existsSync(apk)) {
    throw new Error(
      `Bundled Android devtools helper APK not found at ${apk}. ` +
        `Run \`bash packages/native-devtools-android/scripts/build.sh\` to build it.`
    );
  }
  return apk;
}
