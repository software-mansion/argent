import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceInfo } from "@argent/registry";
import { adbShell } from "./adb";
import { simctlArgsForUdid } from "./ios-device-sets";

const execFileAsync = promisify(execFile);

/**
 * Pin the device status bar to fixed values for the duration of a flow run so
 * its clock / battery / signal never drive a screenshot diff. iOS uses
 * `simctl status_bar override`; Android uses SystemUI demo mode. Best-effort:
 * failures are swallowed so a flow never aborts because the status bar could
 * not be normalized.
 */

const DEMO_BROADCAST = "am broadcast -a com.android.systemui.demo";

/**
 * Returns whether the caller must schedule a run-end {@link restoreStatusBar}:
 * true when the override applied — and also when a failed pin's partial
 * override could not be undone here, so the teardown restore gets another
 * chance rather than leaving demo mode (frozen clock/battery) on the device.
 */
export async function pinStatusBar(device: DeviceInfo): Promise<boolean> {
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
    return false; // chromium / vega: no status bar to normalize
  } catch {
    // A command may have failed after the override was already partially
    // applied (e.g. Android demo mode entered but a later broadcast failed).
    // The caller sees `false` and never restores, so undo here; both cleanup
    // commands are harmless no-ops when nothing was applied.
    const restored = await restoreStatusBar(device);
    // iOS's single override command applies atomically, so a failed pin left
    // nothing behind. Android may be stuck mid-demo-mode: when even the undo
    // failed (transient adb), report `true` so the caller's run-end restore
    // still fires instead of leaving the frozen clock/battery applied.
    return device.platform === "android" && !restored;
  }
}

/**
 * Clear any status-bar override. Never throws; returns false when a command
 * failed and the override may still be applied.
 */
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
        // Also undo the pin's settings write — attempted even when the exit
        // broadcast fails, so demo mode isn't left permitted on the device.
        await adbShell(device.id, "settings put global sysui_demo_allowed 0");
      }
    }
    return true;
  } catch {
    return false; // best-effort restore
  }
}
