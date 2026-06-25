import * as path from "node:path";
import * as fs from "node:fs";

// Re-export the error + WASM-engine + bundled-meta surface so consumers
// (tool-server's profiler pipeline, the analyze banner) import it all from the
// package root.
export * from "./errors.js";
export * from "./wasm-trace-processor.js";
export { PERFETTO_VERSION } from "./bundled-meta.js";

// esbuild puts __dirname in dist/, so `__dirname/..` is the package root in both
// modes (the source package in dev, the published argent package when bundled).
// Two sibling dirs hold this package's runtime data: bin/ (gitignored — holds the
// helper APK only) and assets/ (committed data — queries/, trace-processor/,
// argent.tracecfg.pbtxt, manifest.json).
//
// These are computed lazily (inside functions) rather than at module load so
// this module can be imported into an ESM bundle where top-level `__dirname`
// would be undefined. The APK / queries / config accessors below are only ever
// *called* from the CJS tool-server bundle, where `__dirname` is defined.
//
// ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR overrides bin/, like ARGENT_SIMULATOR_SERVER_DIR.
function binDir(): string {
  return process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR ?? path.join(__dirname, "..", "bin");
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
