import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceInfo } from "@argent/registry";
import { adbShell } from "./adb";
import { isIosPhysicalDevice } from "./device-info";
import { simctlArgsForUdid } from "./ios-device-sets";
import { isRemoteTvOsSimulator, simctlStatusBar } from "./sim-remote";

const execFileAsync = promisify(execFile);

/** Pins the status bar to fixed values so its clock / battery / signal never drive a screenshot diff. */

const DEMO_BROADCAST = "am broadcast -a com.android.systemui.demo";

/**
 * The overridden values, shared by the local and remote iOS arms. A remote
 * simulator shares its baselines with a local one of the same capture geometry,
 * so the two must pin the bar to the same pixels. A second literal here would
 * let them drift. A full-screen snapshot would still pass, since the differ
 * masks the status-bar band there, but a `cropOn` region that includes the bar
 * has no mask and would fail on the clock alone.
 */
const IOS_STATUS_BAR_OVERRIDE = [
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
];

/**
 * Bound on one remote `status_bar` call. A healthy call returns in 0.15-0.25s
 * on a cloud simulator, and the slowest remote round trip measured there, a
 * cold screen capture, took 1.5s. The CLI's 30s default instead let one
 * unresponsive tunnel hold a two-step run for 90s: the override, its undo and
 * the teardown restore each waited it out, and none of them may be skipped.
 * The tvOS probe ahead of each call shares the bound, or a dead tunnel would
 * stall there first.
 */
const REMOTE_STATUS_BAR_TIMEOUT_MS = 5_000;

/**
 * Whether a remote simulator is a tvOS one, which has no status bar: `simctl
 * status_bar` exits "Operation not supported" there. It shares the
 * `ios-remote` platform with a phone, so only the orchestrator's device list
 * can tell them apart.
 */
function isRemoteTvOs(device: DeviceInfo): Promise<boolean> {
  return isRemoteTvOsSimulator(device.id, { timeoutMs: REMOTE_STATUS_BAR_TIMEOUT_MS });
}

/**
 * Returns whether the caller must schedule a run-end {@link restoreStatusBar}:
 * true when the override applied, and also when a partial override could not be
 * undone here, so the teardown restore gets another chance.
 *
 * A run cancelled before this is reached pins nothing, so it owes no restore.
 */
export async function pinStatusBar(device: DeviceInfo, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  // `simctl status_bar` speaks the simulator namespace only; it cannot address
  // a hardware UDID, so the bar stays live; its diff noise is already absorbed
  // by the settle's top-band mask (`statusBarMaskFraction` in flow-pixels).
  if (isIosPhysicalDevice(device)) return false;
  try {
    if (device.platform === "ios") {
      await execFileAsync(
        "xcrun",
        await simctlArgsForUdid(device.id, ["status_bar", device.id, ...IOS_STATUS_BAR_OVERRIDE])
      );
      return true;
    }
    // A remote simulator runs the same simctl verb on the other machine, so it
    // needs the same pin — without it the clock ticks through a run and drives
    // any diff whose region overlaps the bar (a `cropOn` there is not masked).
    // A remote tvOS simulator is skipped: every call would fail, and the double
    // failure below would report the pin as held and retry it at teardown.
    if (device.platform === "ios-remote") {
      if (await isRemoteTvOs(device)) return false;
      await simctlStatusBar(device.id, IOS_STATUS_BAR_OVERRIDE, {
        timeoutMs: REMOTE_STATUS_BAR_TIMEOUT_MS,
      });
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
    // A local iOS override is one command that either applied or did not, so a
    // failure leaves nothing behind. The other two arms can: Android may be
    // stuck mid-demo-mode, and a remote override crosses a network, so the CLI
    // can fail on a response whose request the far host already applied — and
    // a cloud simulator is shared, so a stuck pin outlives this run. When even
    // the undo failed, report `true` so the caller's run-end restore retries.
    return (device.platform === "android" || device.platform === "ios-remote") && !restored;
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
    } else if (device.platform === "ios-remote") {
      // A remote tvOS simulator has no status bar, so nothing can be applied.
      if (!(await isRemoteTvOs(device))) {
        await simctlStatusBar(device.id, ["clear"], { timeoutMs: REMOTE_STATUS_BAR_TIMEOUT_MS });
      }
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
