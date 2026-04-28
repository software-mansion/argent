import { describe, it, expect } from "vitest";
import { classifyDevice, resolveDevice } from "../src/utils/device-info";

describe("classifyDevice", () => {
  it("classifies iOS simulator UUIDs as ios", () => {
    expect(classifyDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")).toBe("ios");
    expect(classifyDevice("01234567-89ab-cdef-0123-456789abcdef")).toBe("ios");
  });

  it("treats non-UUID ids as android", () => {
    expect(classifyDevice("emulator-5554")).toBe("android");
    expect(classifyDevice("HT82A0203045")).toBe("android");
  });
});

describe("resolveDevice", () => {
  it("returns ios+simulator for a UUID", () => {
    const d = resolveDevice("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
    expect(d.platform).toBe("ios");
    expect(d.kind).toBe("simulator");
    expect(d.id).toBe("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
  });

  it("returns android+emulator for an adb serial", () => {
    const d = resolveDevice("emulator-5554");
    expect(d.platform).toBe("android");
    expect(d.kind).toBe("emulator");
  });
});
