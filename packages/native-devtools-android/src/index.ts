import * as path from "node:path";
import * as fs from "node:fs";
import { detectHostPlatform, traceProcessorCachePath } from "./platform";
import { TraceProcessorUnavailableError } from "./errors";
import { BUNDLED_TRACE_PROCESSOR_PLATFORM, PERFETTO_VERSION } from "./bundled-meta";

// Re-export the platform / error / download / bundled-meta surface so consumers
// (tool-server's profiler pipeline, the installer's download routine) import it
// all from the package root.
export * from "./platform";
export * from "./errors";
export * from "./download";
export { BUNDLED_TRACE_PROCESSOR_PLATFORM, PERFETTO_VERSION } from "./bundled-meta";

// esbuild puts __dirname in dist/, so `__dirname/..` is the package root in both
// modes (the source package in dev, the published argent package when bundled).
// Two sibling dirs hold this package's runtime data: bin/ (gitignored native
// binaries — trace_processor_shell + helper APK) and assets/ (committed data —
// queries/, argent.tracecfg.pbtxt, manifest.json).
//
// These are computed lazily (inside functions) rather than at module load so
// this module can be imported into an ESM bundle (the installer's download-deps
// path) where top-level `__dirname` would be undefined. The trace-processor /
// APK / queries accessors below are only ever *called* from the CJS tool-server
// bundle, where `__dirname` is defined.
//
// ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR overrides bin/, like ARGENT_SIMULATOR_SERVER_DIR.
function defaultBinDir(): string {
  return path.join(__dirname, "..", "bin");
}
function binDir(): string {
  return process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR ?? defaultBinDir();
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the Perfetto `trace_processor_shell` binary for this host. Lazy —
 * throws only when called, not at module load — so iOS-only environments that
 * import this package transitively never trip the check.
 *
 * Resolution order (the platform guard at step 5 is the cross-platform fix: the
 * resolver must NOT return the bundled file on mere existence, because the
 * tarball ships a single platform's binary):
 *
 *   1. ARGENT_TRACE_PROCESSOR_PATH         — explicit override; throw env_path_invalid if bad
 *   2. ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR/trace_processor_shell — dev/back-compat
 *   3. detectHostPlatform()                — throws unsupported_platform on win32/other
 *   4. ~/.argent cache hit for <version>/<platform>
 *   5. bundled bin/ — ONLY when the bundled platform matches this host
 *   6. else → TraceProcessorUnavailableError("missing")
 */
export function traceProcessorShellPath(): string {
  // 1. Explicit path override.
  const envPath = process.env.ARGENT_TRACE_PROCESSOR_PATH;
  if (envPath) {
    if (isExecutableFile(envPath)) return envPath;
    throw new TraceProcessorUnavailableError("env_path_invalid", { path: envPath });
  }

  // 2. Dev / back-compat bin-dir override.
  const binDirOverride = process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR;
  if (binDirOverride) {
    const p = path.join(binDirOverride, "trace_processor_shell");
    if (fs.existsSync(p)) return p;
  }

  // 3. Host platform (throws unsupported_platform on win32/other).
  const platform = detectHostPlatform();

  // 4. Version-keyed ~/.argent cache.
  const cached = traceProcessorCachePath(PERFETTO_VERSION, platform);
  if (fs.existsSync(cached)) return cached;

  // 5. Bundled binary — only if its platform matches this host (the fix).
  if (BUNDLED_TRACE_PROCESSOR_PLATFORM === platform) {
    const bundled = path.join(defaultBinDir(), "trace_processor_shell");
    if (fs.existsSync(bundled)) return bundled;
  }

  // 6. Not available — actionable error pointing at `init --download-dependencies`.
  throw new TraceProcessorUnavailableError("missing", { platform, version: PERFETTO_VERSION });
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
  return (
    process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_QUERIES_DIR ??
    path.join(__dirname, "..", "assets", "queries")
  );
}

/**
 * Path to the bundled Perfetto TraceConfig template (`argent.tracecfg.pbtxt`).
 * Callers read this and substitute `TARGET_*_PLACEHOLDER` tokens before
 * passing the config to `perfetto`.
 */
export function traceConfigPath(): string {
  return (
    process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_TRACECFG ??
    path.join(__dirname, "..", "assets", "argent.tracecfg.pbtxt")
  );
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
  const apk = path.join(binDir(), `argent-android-devtools-${manifest.versionName}.apk`);
  if (!fs.existsSync(apk)) {
    throw new Error(
      `Bundled Android devtools helper APK not found at ${apk}. ` +
        `Run \`bash packages/native-devtools-android/scripts/build.sh\` to build it.`
    );
  }
  return apk;
}
