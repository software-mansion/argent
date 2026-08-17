import { describe, it, expect } from "vitest";
import {
  classifyDevice,
  classifyDeviceShape,
  isAndroidEmulatorSerial,
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
});

describe("classifyDeviceShape", () => {
  it("reports every id shape it matches as recognised", () => {
    for (const id of [
      "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      "remote:01234567-89ab-cdef-0123-456789abcdef",
      "chromium-cdp-9222",
      "amazon-4a27df03c9777152",
    ]) {
      expect(classifyDeviceShape(id)).toMatchObject({ recognised: true });
    }
  });

  it("reports every android id as unrecognised, real serials included", () => {
    // The android arm holds an id to no shape, so it confirms nothing about a
    // real serial either.
    for (const serial of ["emulator-5554", "HT82A0203045", "192.168.1.5:5555"]) {
      expect(classifyDeviceShape(serial)).toEqual({ platform: "android", recognised: false });
    }
  });

  it("reports a device name as the android fallback, not a shape", () => {
    // The whole point of the flag: a name classifies as android like any
    // serial, and only this tells a caller the verdict was a fallback. Names
    // need no whitespace to be names: an AVD name from `emulator -list-avds`
    // has none.
    for (const name of ["iPhone 17 Pro", "iPhone16Pro", "Pixel_8_Pro_API_34"]) {
      expect(classifyDeviceShape(name)).toEqual({ platform: "android", recognised: false });
    }
  });

  it("reports an empty id as unrecognised", () => {
    expect(classifyDeviceShape("")).toEqual({ platform: "android", recognised: false });
  });

  it("reports a remote prefix on a non-udid as unrecognised", () => {
    expect(classifyDeviceShape("remote:iPhone 17 Pro")).toEqual({
      platform: "ios-remote",
      recognised: false,
    });
  });

  it("agrees with classifyDevice on the platform", () => {
    for (const id of ["AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", "emulator-5554", "iPhone 17 Pro"]) {
      expect(classifyDeviceShape(id).platform).toBe(classifyDevice(id));
    }
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

describe("isAndroidEmulatorSerial", () => {
  it("is true only for emulator-* serials", () => {
    expect(isAndroidEmulatorSerial("emulator-5554")).toBe(true);
    expect(isAndroidEmulatorSerial("HT82A0203045")).toBe(false);
    expect(isAndroidEmulatorSerial("192.168.1.5:5555")).toBe(false);
  });
});
