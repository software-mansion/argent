import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveDevice } from "./device-info";
import { resolveAndroidBinary } from "./android-binary";

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
    // Resolve adb like every other android path (SDK fallback off-PATH — on
    // Windows adb usually isn't on PATH at all); bare "adb" as a last resort.
    const adb = (await resolveAndroidBinary("adb")) ?? "adb";
    await execFileAsync(adb, ["-s", id, "emu", "kill"]).catch(() => {});
  }
}

/** Shut down every owned device, in parallel, swallowing individual failures. */
export async function shutdownOwnedDevices(ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => shutdownOwnedDevice(id)));
}

export interface ShutdownResult {
  ok: boolean;
  /** Present when ok=false — a human-readable reason to surface in the UI. */
  error?: string;
}

/**
 * Shut down a running device by id, surfacing the outcome — unlike the
 * best-effort {@link shutdownOwnedDevice}, which swallows every error for
 * session teardown. Backs the preview window's right-click "Shut down" action,
 * so the UI can report why a shutdown failed.
 *
 * iOS simulator → `simctl shutdown`; Android emulator → `adb -s <serial> emu
 * kill`. A physical Android device can't be shut down remotely, and
 * Chromium / Vega have no equivalent — those are rejected with a reason.
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
      await execFileAsync("xcrun", ["simctl", "shutdown", id]);
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
