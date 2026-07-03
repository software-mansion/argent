import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceInfo } from "@argent/registry";
import { adbShell } from "./adb";

const execFileAsync = promisify(execFile);

/**
 * Pin the device status bar to fixed values for the duration of a flow run so
 * its clock / battery / signal never drive a screenshot diff. iOS uses
 * `simctl status_bar override`; Android uses SystemUI demo mode. Best-effort:
 * any failure is swallowed (returns false) so a flow never aborts because the
 * status bar could not be normalized.
 */

const DEMO_BROADCAST = "am broadcast -a com.android.systemui.demo";

export async function pinStatusBar(device: DeviceInfo): Promise<boolean> {
  try {
    if (device.platform === "ios") {
      await execFileAsync("xcrun", [
        "simctl",
        "status_bar",
        device.id,
        "override",
        "--time",
        "9:41",
        "--batteryState",
        "charged",
        "--batteryLevel",
        "100",
        "--wifiBars",
        "3",
        "--cellularBars",
        "4",
      ]);
      return true;
    }
    if (device.platform === "android") {
      await adbShell(device.id, "settings put global sysui_demo_allowed 1");
      await adbShell(device.id, `${DEMO_BROADCAST} -e command enter`);
      await adbShell(device.id, `${DEMO_BROADCAST} -e command clock -e hhmm 0941`);
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
    return false; // chromium / vega: no status bar to normalize
  } catch {
    // A command may have failed after the override was already partially
    // applied (e.g. Android demo mode entered but a later broadcast failed).
    // The caller sees `false` and never restores, so undo here; both cleanup
    // commands are harmless no-ops when nothing was applied.
    await restoreStatusBar(device);
    return false;
  }
}

export async function restoreStatusBar(device: DeviceInfo): Promise<void> {
  try {
    if (device.platform === "ios") {
      await execFileAsync("xcrun", ["simctl", "status_bar", device.id, "clear"]);
    } else if (device.platform === "android") {
      await adbShell(device.id, `${DEMO_BROADCAST} -e command exit`);
    }
  } catch {
    // best-effort restore
  }
}
