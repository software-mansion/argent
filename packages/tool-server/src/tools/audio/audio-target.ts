import { FAILURE_CODES, FailureError, type DeviceInfo, type Registry } from "@argent/registry";
import { iosAudioSessionBlueprint } from "../../blueprints/ios-audio-session";
import { assertSupported } from "../../utils/capability";
import { ensureDeps } from "../../utils/check-deps";
import { resolveDevice } from "../../utils/device-info";
import { findIosSimulator, simulatorRuntimeKind } from "../../utils/ios-devices";
import { stripRemotePrefix } from "../../utils/device-info";
import { simctlListDevices } from "../../utils/sim-remote";
import { iosRemoteAudioSessionBlueprint } from "../../blueprints/ios-remote-audio-session";
import type { RemoteAudioSession } from "../../utils/ios-audio-remote";
import type { AudioSession } from "../../utils/ios-audio";

/** Local simulators and Argent Cloud ones (`remote:`), whose hook a feeder in the simulator drives. */
export const audioCapability = {
  apple: { simulator: true },
  appleRemote: { simulator: true },
} as const;

function wrongPlatform(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.AUDIO_WRONG_PLATFORM,
    failure_stage: "audio_platform_check",
    failure_area: "tool_server",
    error_kind: "unsupported",
  });
}

function notBooted(message: string, kind: "not_found" | "validation"): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.AUDIO_SIMULATOR_NOT_BOOTED,
    failure_stage: "audio_boot_check",
    failure_area: "tool_server",
    error_kind: kind,
  });
}

/**
 * The device an audio tool may drive, checked before any service resolves: a platform without the hook fails
 * here instead of starting services for a device the tool cannot use. So does a simulator that is not booted: the
 * native-devtools service counts each failed env setup and stops retrying after a few, which would outlast
 * the boot.
 */
export async function resolveAudioDevice(toolId: string, udid: string): Promise<DeviceInfo> {
  const device = resolveDevice(udid);
  assertSupported(toolId, audioCapability, device);
  const simulator =
    device.platform === "ios-remote"
      ? await findRemoteSimulator(udid)
      : await findIosSimulator(udid);
  if (!simulator) {
    throw notBooted(
      `No iOS simulator with UDID ${udid} was found: call list-devices.`,
      "not_found"
    );
  }
  if (simulator.runtimeKind === "tv") {
    throw wrongPlatform(`Audio mocking does not support tvOS simulators (${udid}).`);
  }
  if (simulator.state !== "Booted") {
    throw notBooted(
      `Simulator '${simulator.name}' (${udid}) is not booted (state: ${simulator.state}): call boot-device first.`,
      "validation"
    );
  }
  return device;
}

/** An Argent Cloud simulator in the shape {@link resolveAudioDevice} checks, from the orchestrator's device list. */
async function findRemoteSimulator(
  udid: string
): Promise<{ name: string; state: string; runtimeKind?: "mobile" | "tv" } | null> {
  const id = stripRemotePrefix(udid);
  const { devices } = await simctlListDevices().catch(() => ({ devices: {} }));
  for (const [runtime, entries] of Object.entries(devices)) {
    const found = entries.find((d) => d.udid === id);
    if (found) return { ...found, runtimeKind: simulatorRuntimeKind(runtime) };
  }
  return null;
}

export function resolveRemoteAudioSession(
  registry: Registry,
  device: DeviceInfo
): Promise<RemoteAudioSession> {
  return registry.resolveService<RemoteAudioSession>(
    iosRemoteAudioSessionBlueprint.getURN(device.id)
  );
}

export function resolveAudioSession(registry: Registry, device: DeviceInfo): Promise<AudioSession> {
  return registry.resolveService<AudioSession>(iosAudioSessionBlueprint.getURN(device.id));
}
