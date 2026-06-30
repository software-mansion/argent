import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDevice } from "./device-info";

const execFileAsync = promisify(execFile);

/**
 * Shut down a device that Argent Lens booted itself (see
 * `VariantProposalStore.takeOwnedDevices`). Best-effort: every failure is
 * swallowed — a device that's already gone, or a CLI that isn't on PATH, must
 * not break session teardown.
 *
 * iOS → `simctl shutdown`; Android emulator → `adb -s <serial> emu kill`.
 * Chromium / Vega are never owned by `/preview/boot` (the preview only streams
 * iOS / Android), so they're left untouched.
 */
export async function shutdownOwnedDevice(id: string): Promise<void> {
  let platform: string;
  try {
    platform = resolveDevice(id).platform;
  } catch {
    return;
  }
  if (platform === "ios") {
    await execFileAsync("xcrun", ["simctl", "shutdown", id]).catch(() => {});
  } else if (platform === "android") {
    await execFileAsync("adb", ["-s", id, "emu", "kill"]).catch(() => {});
  }
}

/** Shut down every owned device, in parallel, swallowing individual failures. */
export async function shutdownOwnedDevices(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => shutdownOwnedDevice(id)));
}
