import * as path from "node:path";
import * as fs from "node:fs";

export * from "./errors.js";
export * from "./wasm-trace-processor.js";
export { PERFETTO_VERSION } from "./bundled-meta.js";

// `__dirname/..` is the package root in both modes: this package in dev, the
// published argent package once bundle-tools.cjs has copied bin/ and assets/
// there. bin/ is gitignored and holds only the helper APK.
//
// ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR overrides bin/, like ARGENT_SIMULATOR_SERVER_DIR.
function binDir(): string {
  return process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_BIN_DIR ?? path.join(__dirname, "..", "bin");
}

/**
 * PerfettoSQL query files (`*.sql`) read by `runTpQuery`. Source of truth is
 * this package's `assets/queries/`; argent's bundler copies it into the
 * published package, so the same `__dirname/..` resolution works in both modes.
 */
export function traceProcessorQueriesDir(): string {
  return (
    process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_QUERIES_DIR ??
    path.join(__dirname, "..", "assets", "queries")
  );
}

/**
 * Bundled Perfetto TraceConfig template. Callers substitute its
 * `TARGET_*_PLACEHOLDER` tokens before passing the config to `perfetto`.
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
