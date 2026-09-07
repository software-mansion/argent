import type { DeviceInfo, Platform as DevicePlatform } from "@argent/registry";
import type { Platform as TelemetryPlatform, TelemetryDeviceKind } from "@argent/telemetry";
import { resolveDevice } from "./device-info";
import { externalNativeId } from "./external-devices";
import { getCachedSimulatorRuntimeKind } from "./ios-devices";
import { consolePortFromAdbSerial, getCachedAndroidRuntimeKind } from "./adb";

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
function refineTvPlatform(
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

/** What `tool:*` events report about the device a call targets. */
export interface DeviceAttribution {
  platform: TelemetryPlatform;
  /** Absent when the id has no positively recognised shape — see `telemetryDeviceKind`. */
  device_kind?: TelemetryDeviceKind;
}

/**
 * Android `kind: "device"` is `resolveDevice`'s bucket for ANY id that is neither
 * iOS-shaped nor `emulator-`: a typo'd udid, a simulator name, a 40-hex Metro
 * logicalDeviceId, a legacy 40-hex iPhone UDID. Reporting those as hardware
 * would poison the one metric `device_kind` exists for, so `device` is emitted
 * only when the native id looks like adb hardware:
 * - a USB serial: 6–20 alphanumerics with at least one digit AND one letter
 *   (`R5CR30ABCDE`, `HT82A0203045`; pure-letter or pure-digit strings are far more
 *   often mistakes such as `booted` than serials), or
 * - a non-loopback IPv4 `host:port` (shape-only: octets and port are not bounded).
 * A loopback `host:port` is an emulator console slot per `consolePortFromAdbSerial`
 * and reports `emulator` — a phone reached through an `adb connect 127.0.0.1:<port>`
 * tunnel is the one false positive. Known false negatives (no kind): IPv6 or
 * hostname serials, serials with `_`/`-` or longer than 20 chars, adb-over-Wi-Fi
 * mDNS names. A non-loopback `ip:port` may also be a virtual device on another
 * host (Genymotion, Waydroid, a Docker-hosted emulator) — best effort.
 */
const ANDROID_USB_SERIAL = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9]{6,20}$/;
const ANDROID_TCP_SERIAL = /^(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/;

function telemetryDeviceKind(
  device: DeviceInfo,
  nativeId: string
): TelemetryDeviceKind | undefined {
  if (device.kind === "unknown") return undefined;
  // Every other kind is already a positive shape match in `resolveDevice`:
  // simulator (UUID / `remote:`), device on iOS (`isIosPhysicalUdid`), emulator
  // (`emulator-`), vvd (`amazon-`), app (`chromium-cdp-`).
  if (device.platform !== "android" || device.kind !== "device") return device.kind;
  if (consolePortFromAdbSerial(nativeId) !== null) return "emulator";
  if (ANDROID_USB_SERIAL.test(nativeId) || ANDROID_TCP_SERIAL.test(nativeId)) return "device";
  return undefined;
}

/**
 * Telemetry platform and device kind for a raw device id. The single classifier
 * behind every event that attributes a device, so `tool:*`, `debugger:tool_outcome`
 * and `lens:*` cannot drift apart. An `ext:` id is attributed by its native id.
 */
export function attributeDeviceForTelemetry(deviceId: string): DeviceAttribution {
  const device = resolveDevice(deviceId);
  const platform = refineTvPlatform(device.platform, deviceId);
  const device_kind = telemetryDeviceKind(device, externalNativeId(deviceId));
  return device_kind ? { platform, device_kind } : { platform };
}

/**
 * Telemetry platform for a raw device id, for events that classify the device
 * themselves (Lens funnel, debugger outcomes) so a TV target is attributed the
 * same way the `tool:*` path in http.ts attributes it.
 */
export function classifyDeviceForTelemetry(deviceId: string): TelemetryPlatform {
  return attributeDeviceForTelemetry(deviceId).platform;
}
