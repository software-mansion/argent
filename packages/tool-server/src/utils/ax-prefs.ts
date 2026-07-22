import * as fsAsync from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";
import { deviceSetForUdid, simctlArgsForUdid } from "./ios-device-sets";

const execFileAsync = promisify(execFile);

export async function ensureAutomationEnabled(udid: string): Promise<void> {
  await execFileAsync(
    "xcrun",
    await simctlArgsForUdid(udid, [
      "spawn",
      udid,
      "defaults",
      "write",
      "com.apple.Accessibility",
      "AutomationEnabled",
      "-bool",
      "true",
    ]),
    { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
  );
}

/**
 * Check whether `IgnoreAXServerEntitlements` is active on this sim.
 *
 * iOS 26.5+: SB's AX server rejects unentitled MIG clients with
 * kAXError -25215. The pref disables the check, but SB caches it at
 * init — writing it post-boot has no effect until the next restart.
 * The only effective path is the pre-boot plist write in boot-device.
 *
 * This read-only probe tells the caller whether the pre-boot write
 * happened so describe can surface a degraded-quality hint when it didn't.
 */
export async function isEntitlementBypassActive(udid: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      await simctlArgsForUdid(udid, [
        "spawn",
        udid,
        "defaults",
        "read",
        "com.apple.Accessibility",
        "IgnoreAXServerEntitlements",
      ]),
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
    );
    return stdout.trim() === "1";
  } catch {
    return false;
  }
}

/**
 * Host-side `com.apple.Accessibility` plist inside the sim's data container.
 * Writeable while Shutdown; in-sim cfprefsd overwrites it once Booted.
 * The device dir lives under the sim's OWNING device set — for an additional
 * set (e.g. Radon IDE's) the default `CoreSimulator/Devices` root would point
 * at a non-existent dir and the pre-boot write would land nowhere.
 */
async function accessibilityPlistPath(udid: string): Promise<string> {
  const deviceSet =
    (await deviceSetForUdid(udid)) ??
    path.join(os.homedir(), "Library/Developer/CoreSimulator/Devices");
  return path.join(deviceSet, udid, "data/Library/Preferences/com.apple.Accessibility.plist");
}

/**
 * Write the four AX prefs to the sim's host plist BEFORE `simctl boot` so SB
 * caches them at AX-server init and never needs the disruptive kickstart
 * (which kills the foreground app and dismisses in-flight system alerts).
 *
 * All four are required on a freshly-erased sim:
 * - `IgnoreAXServerEntitlements` bypasses the iOS 26.5+ kAXErrorNotEntitled check.
 * - `AutomationEnabled` opts the simctl-spawned ax-service in as an AX client.
 * - `AccessibilityEnabled` + `ApplicationAccessibilityEnabled` gate the AT
 *   subsystem bootstrap. Without them SB never spawns `AccessibilityUIServer`
 *   and describe returns an empty ROOT even though the entitlement check passes
 *   (reproduced on a wiped iPhone 17e: AccessibilityUIServer active count = 0
 *   without these two; auto-spawns at boot with them).
 *
 * Caller must ensure the sim is Shutdown — in-sim cfprefsd would otherwise
 * overwrite this file on flush.
 */
export async function setAccessibilityPrefsPreBoot(udid: string): Promise<void> {
  const plistPath = await accessibilityPlistPath(udid);
  await fsAsync.mkdir(path.dirname(plistPath), { recursive: true });
  const exists = await fsAsync
    .access(plistPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await execFileAsync("plutil", ["-create", "binary1", plistPath]);
  }
  for (const key of [
    "AutomationEnabled",
    "IgnoreAXServerEntitlements",
    "AccessibilityEnabled",
    "ApplicationAccessibilityEnabled",
  ]) {
    await execFileAsync("plutil", ["-replace", key, "-bool", "true", plistPath]);
  }
}
