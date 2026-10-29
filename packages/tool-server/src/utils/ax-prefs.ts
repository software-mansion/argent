import * as fsAsync from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SIMCTL_KILL_SIGNAL, SIMCTL_SPAWN_TIMEOUT_MS } from "./simctl-config";
import { deviceSetForUdid, simctlArgsForUdid } from "./ios-device-sets";

const execFileAsync = promisify(execFile);

async function accessibilityDefaults(
  udid: string,
  verb: "write" | "delete",
  key: string,
  ...value: string[]
): Promise<void> {
  await execFileAsync(
    "xcrun",
    /**
     * On an external device this is only reached from ax-service contexts,
     * so that grant covers the spawn.
     */
    await simctlArgsForUdid(
      udid,
      ["spawn", udid, "defaults", verb, "com.apple.Accessibility", key, ...value],
      { granted: "ax-service" }
    ),
    { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
  );
}

export async function ensureAutomationEnabled(udid: string): Promise<void> {
  await accessibilityDefaults(udid, "write", "AutomationEnabled", "-bool", "true");
}

function isMissingDefault(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" && /not found/.test(stderr);
}

/**
 * `AutomationEnabled` persists on the sim's disk and leaves Full Keyboard Access
 * unable to move focus, even across reboots. Local sims trade it away: the
 * ax-service connects without it, though UIKit then reports a text field's
 * placeholder only as its value, with no label. Removes it from sims an older
 * argent wrote it to as well. A missing key or domain is the wanted state, so
 * that failure is ignored.
 */
export async function clearAutomationEnabled(udid: string): Promise<void> {
  await accessibilityDefaults(udid, "delete", "AutomationEnabled").catch((err) => {
    if (!isMissingDefault(err)) throw err;
  });
}

export async function clearAutomationEnabledOrWarn(udid: string): Promise<void> {
  await clearAutomationEnabled(udid).catch((err) => {
    process.stderr.write(
      `[ax-prefs ${udid.slice(0, 8)}] could not clear AutomationEnabled, Full Keyboard Access may stay broken: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  });
}

/**
 * SB caches `IgnoreAXServerEntitlements` at AX-server init, so only the
 * pre-boot plist write in boot-device takes effect; a post-boot write applies
 * from the next restart. False here means that write didn't happen, and
 * describe surfaces a degraded-quality hint.
 */
export async function isEntitlementBypassActive(udid: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "xcrun",
      /** Same reasoning as {@linkcode accessibilityDefaults}. */
      await simctlArgsForUdid(
        udid,
        [
          "spawn",
          udid,
          "defaults",
          "read",
          "com.apple.Accessibility",
          "IgnoreAXServerEntitlements",
        ],
        { granted: "ax-service" }
      ),
      { timeout: SIMCTL_SPAWN_TIMEOUT_MS, killSignal: SIMCTL_KILL_SIGNAL }
    );
    return stdout.trim() === "1";
  } catch {
    return false;
  }
}

/**
 * Host-side plist in the sim's data container: writeable while Shutdown,
 * overwritten by in-sim cfprefsd once Booted.
 * The device dir lives under the sim's OWNING device set — for an additional
 * set (e.g. Radon IDE's) the default `CoreSimulator/Devices` root would point
 * at a non-existent dir and the write would land nowhere.
 */
async function accessibilityPlistPath(udid: string): Promise<string> {
  const deviceSet =
    (await deviceSetForUdid(udid)) ??
    path.join(os.homedir(), "Library/Developer/CoreSimulator/Devices");
  return path.join(deviceSet, udid, "data/Library/Preferences/com.apple.Accessibility.plist");
}

/**
 * Write the three AX prefs BEFORE `simctl boot` so SB caches them at AX-server
 * init. All three are required on a freshly-erased sim:
 * - `IgnoreAXServerEntitlements` bypasses the iOS 26.5+ entitlement check.
 * - `AccessibilityEnabled` + `ApplicationAccessibilityEnabled` gate the AT
 *   subsystem bootstrap; without them SB never spawns `AccessibilityUIServer`
 *   and describe returns an empty ROOT even though the entitlement check passes.
 *
 * Apple TV sims also get `AutomationEnabled`, which opts the simctl-spawned
 * tvOS ax-service in as an AX client.
 *
 * Caller must ensure the sim is Shutdown — in-sim cfprefsd would otherwise
 * overwrite this file on flush.
 */
export async function setAccessibilityPrefsPreBoot(
  udid: string,
  { isTvOs }: { isTvOs: boolean }
): Promise<void> {
  const plistPath = await accessibilityPlistPath(udid);
  await fsAsync.mkdir(path.dirname(plistPath), { recursive: true });
  const exists = await fsAsync
    .access(plistPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await execFileAsync("plutil", ["-create", "binary1", plistPath]);
  }
  const keys = [
    "IgnoreAXServerEntitlements",
    "AccessibilityEnabled",
    "ApplicationAccessibilityEnabled",
  ];
  if (isTvOs) keys.unshift("AutomationEnabled");
  for (const key of keys) {
    await execFileAsync("plutil", ["-replace", key, "-bool", "true", plistPath]);
  }
}
