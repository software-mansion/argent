import * as path from "node:path";
import * as fs from "node:fs";

// Mirror of @argent/native-devtools-ios's index.ts. ARGENT_NATIVE_DEVTOOLS_ANDROID_DIR
// lets a launcher override the dist directory (e.g. when ts-node runs from src/).
const DIST_DIR =
  process.env.ARGENT_NATIVE_DEVTOOLS_ANDROID_DIR ?? path.join(__dirname, "..", "dist");

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
  const manifestPath = path.join(__dirname, "..", "manifest.json");
  cachedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as HelperManifest;
  return cachedManifest;
}

export function bundledHelperApkPath(): string {
  const manifest = helperManifest();
  const apk = path.join(DIST_DIR, `argent-android-devtools-${manifest.versionName}.apk`);
  if (!fs.existsSync(apk)) {
    throw new Error(
      `Bundled Android devtools helper APK not found at ${apk}. ` +
        `Run \`bash packages/native-devtools-android/scripts/build.sh\` to build it.`
    );
  }
  return apk;
}
