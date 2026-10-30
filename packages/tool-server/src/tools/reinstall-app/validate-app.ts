import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { InvalidToolInputError } from "../../utils/capability";
import { readApkPackageName, readZipEntry } from "../../utils/apk-package";

const execFileAsync = promisify(execFile);

// reinstall-app uninstalls before it installs, so every check here must pass
// before the uninstall: a bad appPath or a mismatched id would otherwise
// delete the installed app (or wipe nothing) and then fail.

async function requirePath(absolute: string, kind: "directory" | "file", what: string) {
  const info = await stat(absolute).catch(() => null);
  if (!info) {
    throw new InvalidToolInputError(`appPath ${absolute} does not exist. Nothing was uninstalled.`);
  }
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new InvalidToolInputError(`appPath ${absolute} is not ${what}. Nothing was uninstalled.`);
  }
}

function mismatch(bundleId: string, absolute: string, actual: string): InvalidToolInputError {
  return new InvalidToolInputError(
    `bundleId ${bundleId} does not match the app at ${absolute}, which is ${actual}. ` +
      `Pass bundleId ${actual}, or the path of the ${bundleId} build. Nothing was uninstalled.`
  );
}

/**
 * Check an iOS `.app` before uninstalling. `readBundleId: false` only checks the
 * bundle shape, for hosts without `plutil` (the remote-simulator path).
 */
export async function assertIosAppBundle(
  absolute: string,
  bundleId: string,
  { readBundleId = true }: { readBundleId?: boolean } = {}
): Promise<void> {
  await requirePath(absolute, "directory", "an .app bundle directory");
  const infoPlist = join(absolute, "Info.plist");
  if (!(await stat(infoPlist).catch(() => null))?.isFile()) {
    throw new InvalidToolInputError(
      `appPath ${absolute} has no Info.plist, so it is not an iOS .app bundle. Nothing was uninstalled.`
    );
  }
  if (!readBundleId) return;
  const actual = await execFileAsync("plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    infoPlist,
  ]).then(
    ({ stdout }) => stdout.trim(),
    () => ""
  );
  if (!actual) {
    throw new InvalidToolInputError(
      `${infoPlist} has no CFBundleIdentifier, so it is not an iOS .app bundle. Nothing was uninstalled.`
    );
  }
  // Exact match: `simctl uninstall` with a differently cased id exits 0 and removes nothing.
  if (actual !== bundleId) throw mismatch(bundleId, absolute, actual);
}

export async function assertApk(absolute: string, packageName: string): Promise<void> {
  await requirePath(absolute, "file", "an .apk file");
  let actual: string;
  try {
    actual = await readApkPackageName(absolute);
  } catch (err) {
    throw new InvalidToolInputError(
      `appPath ${absolute} is not a readable APK (${(err as Error).message}). Nothing was uninstalled.`
    );
  }
  if (actual !== packageName) throw mismatch(packageName, absolute, actual);
}

export async function assertVpkg(absolute: string): Promise<void> {
  await requirePath(absolute, "file", "a .vpkg file");
}

/** Check a HarmonyOS `.hap` before uninstalling: `app.bundleName` in its `module.json`. */
export async function assertHap(absolute: string, bundleName: string): Promise<void> {
  await requirePath(absolute, "file", "a .hap file");
  let actual: unknown;
  try {
    const moduleJson = JSON.parse((await readZipEntry(absolute, "module.json")).toString("utf8"));
    actual = moduleJson?.app?.bundleName;
  } catch (err) {
    throw new InvalidToolInputError(
      `appPath ${absolute} is not a readable HAP (${(err as Error).message}). Nothing was uninstalled.`
    );
  }
  if (typeof actual !== "string" || actual.length === 0) {
    throw new InvalidToolInputError(
      `appPath ${absolute} has no app.bundleName in module.json, so it is not a HarmonyOS .hap. Nothing was uninstalled.`
    );
  }
  if (actual !== bundleName) throw mismatch(bundleName, absolute, actual);
}
