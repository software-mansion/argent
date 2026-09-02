import type { Platform as DevicePlatform } from "@argent/registry";
import type { Platform as TelemetryPlatform } from "@argent/telemetry";
import { classifyDevice } from "./device-info";
import { getCachedSimulatorRuntimeKind } from "./ios-devices";
import { getCachedAndroidRuntimeKind } from "./adb";

export type { TelemetryPlatform };

/**
 * Split a TV target out of its base mobile platform for reporting, cache-only —
 * never a fresh `simctl`/`adb` probe, since this runs per tool call. UDID/serial
 * shape alone can't tell a tvOS simulator from an iPhone one, or an Android TV
 * emulator from a phone, and the device platform stays coarse on purpose (a TV is
 * a `runtimeKind`; capability gating and dispatch are TV-agnostic). Calls made
 * before a describe/interaction path warms the runtime-kind cache report the base
 * platform.
 */
export function refineTvPlatform(
  basePlatform: DevicePlatform,
  deviceId: string
): TelemetryPlatform {
  if (basePlatform === "ios" && getCachedSimulatorRuntimeKind(deviceId) === "tv") {
    return "tvos";
  }
  if (basePlatform === "android" && getCachedAndroidRuntimeKind(deviceId) === "tv") {
    return "android-tv";
  }
  return basePlatform;
}

/**
 * Telemetry platform for a raw device id, for events that classify the device
 * themselves (Lens funnel, debugger outcomes) so a TV target is attributed the
 * same way the `tool:*` path in http.ts attributes it.
 */
export function classifyDeviceForTelemetry(deviceId: string): TelemetryPlatform {
  return refineTvPlatform(classifyDevice(deviceId), deviceId);
}
