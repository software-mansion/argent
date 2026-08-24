import { runAdb, adbShell } from "./adb";
import { bundledHelperApkPath, helperManifest } from "@argent/native-devtools-android";

/** Manifest-driven install of the argent-android-devtools helper APK. */

const installedHelpers = new Map<string, true>();

function cacheKey(serial: string, versionCode: number): string {
  return `${serial}|${versionCode}`;
}

interface InstalledVersionProbe {
  installed: boolean;
  versionCode: number | null;
}

/**
 * `--show-versioncode` returns the version in the same round-trip; `pm path`
 * would need a follow-up `dumpsys package`.
 */
async function probeInstalledVersion(
  serial: string,
  packageName: string
): Promise<InstalledVersionProbe> {
  let out: string;
  try {
    out = await adbShell(serial, `cmd package list packages --show-versioncode ${packageName}`, {
      timeoutMs: 5_000,
    });
  } catch {
    // `cmd package` is missing on older API levels.
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

/** Install the helper APK unless the device already has at least the bundled versionCode. */
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
      // Same package installed under a different signing key (e.g. a rotated
      // local debug keystore); Android only allows the update after uninstall.
      try {
        await runAdb(["-s", serial, "uninstall", manifest.packageName], { timeoutMs: 30_000 });
      } catch {
        // Let the retried install report the failure.
      }
      await runAdb(args, { timeoutMs: 60_000 });
    } else {
      throw err;
    }
  }

  installedHelpers.set(key, true);
}

export function __resetAndroidDevtoolsInstallCache(): void {
  installedHelpers.clear();
}
