import { FAILURE_CODES, FailureError, type DeviceInfo, type Registry } from "@argent/registry";
import { iosAudioSessionBlueprint } from "../../blueprints/ios-audio-session";
import { assertSupported } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";
import { isTvOsSimulator } from "../../utils/ios-devices";
import type { AudioSession } from "../../utils/ios-audio";

export const audioCapability = { apple: { simulator: true } } as const;

function wrongPlatform(message: string): FailureError {
  return new FailureError(message, {
    error_code: FAILURE_CODES.AUDIO_WRONG_PLATFORM,
    failure_stage: "audio_platform_check",
    failure_area: "tool_server",
    error_kind: "unsupported",
  });
}

/**
 * The device an audio tool may drive, checked before any service resolves: the hook and its control
 * directory live on this Mac, so a hosted simulator or a platform without the hook fails here instead of
 * starting services for a device the tool cannot use.
 */
export async function resolveAudioDevice(toolId: string, udid: string): Promise<DeviceInfo> {
  const device = resolveDevice(udid);
  if (device.platform === "ios-remote") {
    throw wrongPlatform(
      "Audio mocking needs a simulator on the same Mac as the tool-server; hosted (remote:) simulators are not supported."
    );
  }
  assertSupported(toolId, audioCapability, device);
  if (await isTvOsSimulator(udid)) {
    throw wrongPlatform(`Audio mocking does not support tvOS simulators (${udid}).`);
  }
  return device;
}

export function resolveAudioSession(registry: Registry, device: DeviceInfo): Promise<AudioSession> {
  return registry.resolveService<AudioSession>(iosAudioSessionBlueprint.getURN(device.id));
}
