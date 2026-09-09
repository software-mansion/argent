import { describe, expect, it, vi } from "vitest";
import {
  attributeDeviceForTelemetry,
  classifyDeviceForTelemetry,
} from "../src/utils/telemetry-platform";

// Cache-only readers: cold here, so every platform stays coarse and the kind can
// be pinned independently of the TV refinement.
vi.mock("../src/utils/ios-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/ios-devices")>();
  return { ...actual, getCachedSimulatorRuntimeKind: () => undefined };
});
vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return { ...actual, getCachedAndroidRuntimeKind: () => undefined };
});

const SIM_UDID = "11111111-1111-1111-1111-111111111111";
const PHYSICAL_UDID = "00008030-000A1B2C3D4E5F60";
const METRO_HANDLE = "8b9223b1392be193fa9058e0cef5cefb2bddeb68";

describe("attributeDeviceForTelemetry", () => {
  it.each([
    // Positive shapes `resolveDevice` already recognises.
    [SIM_UDID, { platform: "ios", device_kind: "simulator" }],
    [PHYSICAL_UDID, { platform: "ios", device_kind: "device" }],
    [`remote:${SIM_UDID}`, { platform: "ios-remote", device_kind: "simulator" }],
    ["emulator-5554", { platform: "android", device_kind: "emulator" }],
    ["chromium-cdp-9222", { platform: "chromium", device_kind: "app" }],
    ["amazon-1a2b3c", { platform: "vega", device_kind: "vvd" }],
    // Android hardware: USB serials with a digit and a letter, non-loopback ip:port.
    ["R5CT12345678", { platform: "android", device_kind: "device" }],
    ["HT82A0203045", { platform: "android", device_kind: "device" }],
    ["192.168.1.5:5555", { platform: "android", device_kind: "device" }],
    // Loopback ip:port is an emulator console slot (adb.ts consolePortFromAdbSerial).
    ["127.0.0.1:5555", { platform: "android", device_kind: "emulator" }],
    ["localhost:5555", { platform: "android", device_kind: "emulator" }],
    ["::1:5555", { platform: "android", device_kind: "emulator" }],
    // `ext:` ids attribute by their native id.
    [`ext:acme-3f2a9c:${PHYSICAL_UDID}`, { platform: "ios", device_kind: "device" }],
    ["ext:acme-3f2a9c:emulator-5554", { platform: "android", device_kind: "emulator" }],
    ["ext:acme-3f2a9c:R5CT12345678", { platform: "android", device_kind: "device" }],
  ])("%s → %o", (id, expected) => {
    expect(attributeDeviceForTelemetry(id)).toEqual(expected);
  });

  it.each([
    // `resolveDevice` sends every one of these to android/device; none is hardware.
    METRO_HANDLE, // 40-hex Metro logicalDeviceId, also a legacy iPhone UDID shape
    "oops",
    "booted",
    "Pixel_7",
    "abcdefgh",
    "1234567890",
    "[fe80::1]:5555",
    "pixel.local:5555",
    "adb-R5CT12345678-AbCdEf._adb-tls-connect._tcp.",
    "0123456789ABCDEF0123456789ABCDEF", // 32-hex, over the 20-char cap
  ])("%s carries the fallback platform but no kind", (id) => {
    expect(attributeDeviceForTelemetry(id)).toEqual({ platform: "android" });
  });

  it("classifyDeviceForTelemetry is the platform half of the same classifier", () => {
    for (const id of [SIM_UDID, PHYSICAL_UDID, "emulator-5554", "R5CT12345678", METRO_HANDLE]) {
      expect(classifyDeviceForTelemetry(id)).toBe(attributeDeviceForTelemetry(id).platform);
    }
  });
});
