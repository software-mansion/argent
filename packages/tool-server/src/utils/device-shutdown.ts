import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDevice } from "./device-info";
import { resolveAndroidBinary } from "./android-binary";
import { simctlArgsForUdid } from "./ios-device-sets";

const execFileAsync = promisify(execFile);

/**
 * Shut down a device that Argent Lens booted itself (see
 * `VariantProposalStore.takeOwnedDevices`). Best-effort: a device that's
 * already gone, or a CLI that isn't on PATH, must not break session teardown.
 */
export async function shutdownOwnedDevice(id: string): Promise<void> {
  let platform: string;
  try {
    platform = resolveDevice(id).platform;
  } catch {
    return;
  }
  if (platform === "ios") {
    await execFileAsync("xcrun", await simctlArgsForUdid(id, ["shutdown", id])).catch(() => {});
  } else if (platform === "android") {
    // adb often isn't on PATH (notably on Windows); resolveAndroidBinary falls
    // back to the SDK roots.
    const adb = (await resolveAndroidBinary("adb")) ?? "adb";
    await execFileAsync(adb, ["-s", id, "emu", "kill"]).catch(() => {});
  }
}

export async function shutdownOwnedDevices(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => shutdownOwnedDevice(id)));
}

export interface ShutdownResult {
  ok: boolean;
  /** Present when ok=false — human-readable reason for the UI. */
  error?: string;
}

/**
 * Shut down a running device by id, surfacing the outcome — unlike the
 * best-effort {@link shutdownOwnedDevice}, which swallows every error for
 * session teardown. Backs the preview window's right-click "Shut down" action,
 * so the UI can report why a shutdown failed.
 */
export async function shutdownDevice(id: string): Promise<ShutdownResult> {
  let device: { platform: string; kind: string };
  try {
    device = resolveDevice(id);
  } catch {
    return { ok: false, error: `Unknown device "${id}".` };
  }
  try {
    if (device.platform === "ios") {
      await execFileAsync("xcrun", await simctlArgsForUdid(id, ["shutdown", id]));
      return { ok: true };
    }
    if (device.platform === "android" && device.kind === "emulator") {
      const adb = (await resolveAndroidBinary("adb")) ?? "adb";
      await execFileAsync(adb, ["-s", id, "emu", "kill"]);
      return { ok: true };
    }
    return {
      ok: false,
      error:
        device.platform === "android"
          ? "A physical Android device can't be shut down remotely."
          : `Shutting down ${device.platform} devices isn't supported.`,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
