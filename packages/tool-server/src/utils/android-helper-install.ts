import type { FailureError, FailureSignal } from "@argent/registry";
import { runAdb, adbShell } from "./adb";
import { bundledHelperApkPath, helperManifest } from "@argent/native-devtools-android";

/**
 * Manifest-driven install of the argent-android-devtools helper APK, plus the
 * per-serial record of how the helper last refused to start. Both answer one
 * question — can this device serve a hierarchy? — so they share a reset.
 */

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
    if (
      probe.installed &&
      probe.versionCode !== null &&
      probe.versionCode >= manifest.versionCode
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

interface HelperFailureRecord {
  error: FailureError;
  signal: FailureSignal;
  at: number;
  /** Whether the shorter window applies. See {@link helperTimeoutCooldownMs}. */
  short: boolean;
}

const helperFailures = new Map<string, HelperFailureRecord>();

/**
 * How long a terminal helper-start verdict suppresses the next attempt.
 *
 * mcp-server fires `describe` after every action and the registry retries a
 * failed service on each resolve (#1010), so without a cooldown one device that
 * refuses the install turns every subsequent action into another install
 * attempt — minutes of adb per agent turn on a device nothing can fix remotely.
 */
let helperAttemptCooldownMs = 5 * 60_000;

/**
 * The window for an install that hit its own 60 s cap. Caching it matters more
 * than most — each retry costs that minute again — but a wedged device is also
 * the kind that comes back on its own, so it holds for a minute, not five.
 */
let helperTimeoutCooldownMs = 60_000;

/** @public test seam: the real windows would stall a suite for minutes. */
export function __setHelperAttemptCooldownForTesting(ms: number, timeoutMs: number = ms): void {
  helperAttemptCooldownMs = ms;
  helperTimeoutCooldownMs = timeoutMs;
}

/** Remember a terminal verdict so the cooldown can replay it. */
export function recordHelperFailure(
  serial: string,
  error: FailureError,
  signal: FailureSignal,
  options: { short?: boolean } = {}
): void {
  helperFailures.set(serial, { error, signal, at: Date.now(), short: options.short === true });
}

/** The terminal verdict still inside the cooldown window, with its age. */
export function recentHelperFailure(
  serial: string
): { error: FailureError; signal: FailureSignal; ageMs: number } | undefined {
  const record = helperFailures.get(serial);
  if (!record) return undefined;
  const ageMs = Date.now() - record.at;
  if (ageMs >= (record.short ? helperTimeoutCooldownMs : helperAttemptCooldownMs)) {
    helperFailures.delete(serial);
    return undefined;
  }
  return { error: record.error, signal: record.signal, ageMs };
}

/** Drop the verdict once the helper starts, so the next failure is reported fresh. */
export function clearHelperFailure(serial: string): void {
  helperFailures.delete(serial);
}

/**
 * Test-only helper to reset the install state between runs. The install itself
 * is no longer memoized, so what it clears is the cooldown — the one piece of
 * state that survives a fixed device.
 *
 * @public so knip keeps it: the only caller lives in the `argent-private`
 * submodule, which knip lists under `ignoreWorkspaces` and CI never checks out.
 * `research/android-describe-busy-ui/drivers/test-fallback.js` requires this
 * module from `dist/` and calls this twice - once to force the install-fallback
 * path, once to restore. Drop the tag when that driver becomes a vitest test.
 */
export function __resetAndroidDevtoolsInstallCache(): void {
  helperFailures.clear();
}
