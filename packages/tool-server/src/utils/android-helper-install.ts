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
    // API 23 has no `cmd`, and API 24-25 reject `--show-versioncode`.
    // `dumpsys package` reports the versionCode on every supported level.
    try {
      out = await adbShell(serial, `dumpsys package ${packageName}`, { timeoutMs: 5_000 });
    } catch {
      return { installed: false, versionCode: null };
    }
    const block = out.split(`Package [${packageName}]`)[1];
    if (block === undefined) return { installed: false, versionCode: null };
    const versionCode = block.match(/versionCode=(\d+)/);
    return { installed: true, versionCode: versionCode ? parseInt(versionCode[1]!, 10) : null };
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
 * An older helper is upgraded in place: `-r` keeps the package, and the APK is
 * always signed with the same key, so nothing is uninstalled or prompted. A
 * newer helper is left alone, so an older tool-server sharing the device keeps
 * using the helper a newer one installed instead of the two swapping it on
 * every start. That only holds while the bundled APK really carries the
 * manifest's versionCode; download-native-binaries.sh refuses one that does
 * not, since a lower one would be reinstalled on every call.
 *
 * The probe runs on every call rather than being memoized per serial: a wipe or
 * a snapshot restore drops the package while the same serial stays connected,
 * and a memo would keep skipping the install for the life of the process. One
 * `cmd package list packages` per service instantiation is cheap enough to pay.
 *
 * `force` installs without probing, and with `-d` so the install may go
 * backwards in versionCode. The probe cannot tell a working helper from a
 * foreign build carrying the same or a higher versionCode, so a repair has to
 * ignore its verdict. It runs only when the device says the instrumentation is
 * missing, which a newer helper of the same package never does, so it does not
 * downgrade a working newer helper.
 */
export async function ensureAndroidDevtoolsInstalled(
  serial: string,
  options: { force?: boolean } = {}
): Promise<void> {
  const manifest = helperManifest();

  if (!options.force) {
    const probe = await probeInstalledVersion(serial, manifest.packageName);
    // A null versionCode means the device listed the package without one.
    // Treat it as current: installing on every instantiation would replace a
    // working helper each time, and a broken one is caught by the forced
    // reinstall once `am instrument` refuses it.
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
