import { FAILURE_CODES, FailureError, type DeviceInfo, type Registry } from "@argent/registry";
import { iosAudioSessionBlueprint } from "../../blueprints/ios-audio-session";
import { assertSupported } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";
import { findIosSimulator } from "../../utils/ios-devices";
import type { AudioSession } from "../../utils/ios-audio";

/**
 * `appleRemote` is declared only so a `remote:` id gets past the HTTP capability gate to the refusal in
 * {@link resolveAudioDevice}, which says why, instead of a bare "not supported".
 */
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
 * The device an audio tool may drive, checked before any service resolves: the hook and its control
 * directory live on this Mac, so a hosted simulator or a platform without the hook fails here instead of
 * starting services for a device the tool cannot use. So does a simulator that is not booted: the
 * native-devtools service counts each failed env setup and stops retrying after a few, which would outlast
 * the boot.
 */
export async function resolveAudioDevice(toolId: string, udid: string): Promise<DeviceInfo> {
  const device = resolveDevice(udid);
  if (device.platform === "ios-remote") {
    throw wrongPlatform(
      "Audio mocking needs a simulator on the same Mac as the tool-server; hosted (remote:) simulators are not supported."
    );
  }
  assertSupported(toolId, audioCapability, device);
  const simulator = await findIosSimulator(udid);
  if (!simulator) {
    throw notBooted(
      `No iOS simulator with UDID ${udid} was found. Call list-devices for the available simulators.`,
      "not_found"
    );
  }
  if (simulator.runtimeKind === "tv") {
    throw wrongPlatform(`Audio mocking does not support tvOS simulators (${udid}).`);
  }
  if (simulator.state !== "Booted") {
    throw notBooted(
      `Simulator '${simulator.name}' (${udid}) is not booted (state: ${simulator.state}). ` +
        `Boot it first with boot-device, then call ${toolId} again.`,
      "validation"
    );
  }
  return device;
}

export function resolveAudioSession(registry: Registry, device: DeviceInfo): Promise<AudioSession> {
  return registry.resolveService<AudioSession>(iosAudioSessionBlueprint.getURN(device.id));
}
