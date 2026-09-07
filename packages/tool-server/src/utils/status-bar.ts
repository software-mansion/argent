import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceInfo } from "@argent/registry";
import { adbShell } from "./adb";
import { isIosPhysicalDevice } from "./device-info";
import { simctlArgsForUdid } from "./ios-device-sets";

const execFileAsync = promisify(execFile);

/** Pins the status bar to fixed values so its clock / battery / signal never drive a screenshot diff. */

const DEMO_BROADCAST = "am broadcast -a com.android.systemui.demo";

/**
 * Returns whether the caller must schedule a run-end {@link restoreStatusBar}:
 * true when the override applied, and also when a partial override could not be
 * undone here, so the teardown restore gets another chance.
 */
export async function pinStatusBar(device: DeviceInfo): Promise<boolean> {
  // `simctl status_bar` speaks the simulator namespace only; it cannot address
  // a hardware UDID, so the bar stays live; its diff noise is already absorbed
  // by the settle's top-band mask (`statusBarMaskFraction` in flow-pixels).
  if (isIosPhysicalDevice(device)) return false;
  try {
    if (device.platform === "ios") {
      await execFileAsync(
        "xcrun",
        await simctlArgsForUdid(device.id, [
          "status_bar",
          device.id,
          "override",
          "--time",
          "9:37",
          "--batteryState",
          "charged",
          "--batteryLevel",
          "100",
          "--wifiBars",
          "3",
          "--cellularBars",
          "4",
        ])
      );
      return true;
    }
    if (device.platform === "android") {
      await adbShell(device.id, "settings put global sysui_demo_allowed 1");
      await adbShell(device.id, `${DEMO_BROADCAST} -e command enter`);
      await adbShell(device.id, `${DEMO_BROADCAST} -e command clock -e hhmm 0937`);
      await adbShell(
        device.id,
        `${DEMO_BROADCAST} -e command battery -e level 100 -e plugged false`
      );
      await adbShell(
        device.id,
        `${DEMO_BROADCAST} -e command network -e wifi show -e level 4 -e mobile show -e level 4`
      );
      return true;
    }
    return false;
  } catch {
    // The override may already be partially applied, and the caller never
    // restores after a `false`, so undo here; the cleanup is a no-op when
    // nothing was applied.
    const restored = await restoreStatusBar(device);
    // iOS's single override command leaves nothing behind on failure. Android
    // may be stuck mid-demo-mode: when even the undo failed, report `true` so
    // the caller's run-end restore retries.
    return device.platform === "android" && !restored;
  }
}

/** Clears any override. Never throws; false means it may still be applied. */
export async function restoreStatusBar(device: DeviceInfo): Promise<boolean> {
  try {
    if (device.platform === "ios") {
      await execFileAsync(
        "xcrun",
        await simctlArgsForUdid(device.id, ["status_bar", device.id, "clear"])
      );
    } else if (device.platform === "android") {
      try {
        await adbShell(device.id, `${DEMO_BROADCAST} -e command exit`);
      } finally {
        // Attempted even when the exit broadcast fails, so demo mode isn't
        // left permitted on the device.
        await adbShell(device.id, "settings put global sysui_demo_allowed 0");
      }
    }
    return true;
  } catch {
    return false;
  }
}
