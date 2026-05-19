import { runAdb, adbShell } from "./adb";
import { bundledHelperApkPath, helperManifest } from "@argent/native-devtools-android";

/**
 * Manifest-driven install of the argent-android-devtools helper APK.
 *
 * Cached in-process so subsequent calls for the same serial skip the
 * `cmd package list packages --show-versioncode` probe. The cache key
 * includes `versionCode` so an upgrade build invalidates entries even if
 * the serial is reused across process restarts.
 */

const installedHelpers = new Map<string, true>();

function cacheKey(serial: string, versionCode: number): string {
  return `${serial}|${versionCode}`;
}

interface InstalledVersionProbe {
  installed: boolean;
  versionCode: number | null;
}

/**
 * Probe the installed version code via `cmd package list packages
 * --show-versioncode` — faster than `pm path` and returns the version in
 * the same round-trip, avoiding a second `dumpsys package` call.
 */
async function probeInstalledVersion(
  serial: string,
  packageName: string
): Promise<InstalledVersionProbe> {
  let out = "";
  try {
    out = await adbShell(
      serial,
      `cmd package list packages --show-versioncode ${packageName}`,
      { timeoutMs: 5_000 }
    );
  } catch {
    // `cmd package` only exists on API 24+. Fall back to `pm list packages`.
    try {
      out = await adbShell(serial, `pm list packages ${packageName}`, { timeoutMs: 5_000 });
    } catch {
      return { installed: false, versionCode: null };
    }
  }

  for (const line of out.split("\n")) {
    const match = line.trim().match(/^package:([^\s]+)(?:\s+versionCode:(\d+))?$/);
    if (!match) continue;
    if (match[1] !== packageName) continue;
    const versionCode = match[2] ? parseInt(match[2], 10) : null;
    return { installed: true, versionCode: Number.isFinite(versionCode!) ? versionCode! : null };
  }
  return { installed: false, versionCode: null };
}

/**
 * Ensure the helper APK is installed on the device with at least the
 * bundled versionCode. On `INSTALL_FAILED_UPDATE_INCOMPATIBLE` we
 * `pm uninstall` and retry once — that path fires when the local debug
 * keystore differs from whatever was last installed (e.g. the developer
 * rotated their keystore).
 */
export async function ensureAndroidDevtoolsInstalled(serial: string): Promise<void> {
  const manifest = helperManifest();
  const key = cacheKey(serial, manifest.versionCode);
  if (installedHelpers.has(key)) return;

  const probe = await probeInstalledVersion(serial, manifest.packageName);
  if (probe.installed && probe.versionCode !== null && probe.versionCode >= manifest.versionCode) {
    installedHelpers.set(key, true);
    return;
  }

  const apkPath = bundledHelperApkPath();
  const args = ["-s", serial, "install", ...manifest.installFlags, apkPath];

  try {
    await runAdb(args, { timeoutMs: 60_000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(message)) {
      // Signature mismatch — the device has a same-package APK signed by a
      // different key. Uninstall the old one and retry. This is the
      // keystore-rotation footgun the research folder calls out at §5.2.
      try {
        await runAdb(["-s", serial, "uninstall", manifest.packageName], { timeoutMs: 30_000 });
      } catch {
        // If uninstall itself fails we still want the original install
        // error to be the surfaced message — fall through.
      }
      await runAdb(args, { timeoutMs: 60_000 });
    } else {
      throw err;
    }
  }

  installedHelpers.set(key, true);
}

/** Test-only helper to reset the install cache between unit tests. */
export function __resetAndroidDevtoolsInstallCache(): void {
  installedHelpers.clear();
}
