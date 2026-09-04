import { describe, it, expect } from "vitest";
import { nativeIdPlatform } from "@argent/device-providers";
import {
  classifyDevice,
  isAndroidEmulatorSerial,
  isIosPhysicalDevice,
  resolveDevice,
} from "../src/utils/device-info";

describe("classifyDevice", () => {
  it("classifies iOS simulator UUIDs as ios", () => {
    expect(classifyDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe("ios");
    expect(classifyDevice("01234567-89ab-cdef-0123-456789abcdef")).toBe("ios");
  });

  it("treats non-UUID ids as android", () => {
    expect(classifyDevice("emulator-5554")).toBe("android");
    expect(classifyDevice("HT82A0203045")).toBe("android");
  });

  it("classifies amazon-prefixed serials as vega", () => {
    expect(classifyDevice("amazon-4a27df03c9777152")).toBe("vega");
  });

  /**
   * `argent providers check` cannot reach this classifier, so it asks
   * `nativeIdPlatform` in the contract package instead. The two have to give
   * one answer or the check would pass a descriptor the tool-server drops. This
   * holds it to that for every id a provider may declare, which is every id
   * without one of the prefixes above.
   */
  it.each([
    "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
    "01234567-89ab-cdef-0123-456789abcdef",
    "00008110-000978540290401E",
    "emulator-5554",
    "HT82A0203045",
    "192.168.1.5:5555",
  ])("agrees with the contract's nativeIdPlatform on %s", (nativeId) => {
    expect(classifyDevice(nativeId)).toBe(nativeIdPlatform(nativeId));
  });
});

describe("resolveDevice", () => {
  it("returns ios+simulator for a UUID", () => {
    const d = resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
    expect(d.platform).toBe("ios");
    expect(d.kind).toBe("simulator");
    expect(d.id).toBe("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
  });

  it("returns android+emulator for an emulator serial", () => {
    const d = resolveDevice("emulator-5554");
    expect(d.platform).toBe("android");
    expect(d.kind).toBe("emulator");
  });

  it("returns android+device for a physical phone's USB serial", () => {
    const d = resolveDevice("HT82A0203045");
    expect(d.platform).toBe("android");
    expect(d.kind).toBe("device");
  });

  it("returns android+device for a wireless-adb ip:port serial", () => {
    const d = resolveDevice("192.168.1.5:5555");
    expect(d.platform).toBe("android");
    expect(d.kind).toBe("device");
  });

  it("returns vega+vvd for an amazon- serial (v1 supports the Virtual Device only)", () => {
    const d = resolveDevice("amazon-4a27df03c9777152");
    expect(d.platform).toBe("vega");
    expect(d.kind).toBe("vvd");
  });
});

describe("isIosPhysicalDevice", () => {
  it("is true for a physical iPhone UDID", () => {
    expect(isIosPhysicalDevice(resolveDevice("00008110-000978540290401E"))).toBe(true);
  });

  it("is false for an iOS simulator", () => {
    expect(isIosPhysicalDevice(resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"))).toBe(false);
  });

  it("is false for physical Android hardware (kind 'device' too, the bare-kind hazard)", () => {
    const android = resolveDevice("HT82A0203045");
    expect(android.kind).toBe("device");
    expect(isIosPhysicalDevice(android)).toBe(false);
  });
});

describe("isAndroidEmulatorSerial", () => {
  it("is true only for emulator-* serials", () => {
    expect(isAndroidEmulatorSerial("emulator-5554")).toBe(true);
    expect(isAndroidEmulatorSerial("HT82A0203045")).toBe(false);
    expect(isAndroidEmulatorSerial("192.168.1.5:5555")).toBe(false);
  });
});
