import { runAdb, adbShell } from "./adb";
import { bundledHelperApkPath, helperManifest } from "@argent/native-devtools-android";

/** Manifest-driven install of the argent-android-devtools helper APK. */

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

/**
 * Install the helper APK unless the device already has at least the bundled
 * versionCode.
 *
 * The probe runs on every call rather than being memoized per serial: a wipe or
 * a snapshot restore drops the package while the same serial stays connected,
 * and a memo would keep skipping the install for the life of the process. One
 * `cmd package list packages` per service instantiation is cheap enough to pay.
 *
 * `force` installs without probing, and with `-d` so the install may go
 * backwards in versionCode. The probe cannot tell a working helper from a
 * foreign build carrying the same versionCode (the manifest pins it at 1), so a
 * repair has to ignore its verdict.
 */
export async function ensureAndroidDevtoolsInstalled(
  serial: string,
  options: { force?: boolean } = {}
): Promise<void> {
  const manifest = helperManifest();

  if (!options.force) {
    const probe = await probeInstalledVersion(serial, manifest.packageName);
    // A null versionCode means the `pm list packages` fallback answered (API
    // levels without `cmd package`), which reports presence only. Treat a
    // present package as current there: installing on every instantiation
    // would replace a working helper each time, and a stale one is caught by
    // the forced reinstall once `am instrument` refuses it. Only API 23 — the
    // helper's minSdk — lacks `cmd package`, so the one device class that
    // never upgrades a stale-but-present helper is also the oldest supported.
    if (
      probe.installed &&
      (probe.versionCode === null || probe.versionCode >= manifest.versionCode)
    ) {
      return;
    }
  }

  const apkPath = bundledHelperApkPath();
  const flags = options.force ? [...manifest.installFlags, "-d"] : manifest.installFlags;
  const args = ["-s", serial, "install", ...flags, apkPath];

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
}

/**
 * No-op: there is no install cache any more. Every call probes the device, so
 * nothing survives between calls for a reset to clear.
 *
 * @public so knip keeps it: the only caller lives in the `argent-private`
 * submodule, which knip lists under `ignoreWorkspaces` and CI never checks out.
 * `research/android-describe-busy-ui/drivers/test-fallback.js` requires this
 * module from `dist/` and calls it. Drop the export once that driver does.
 */
export function __resetAndroidDevtoolsInstallCache(): void {}
