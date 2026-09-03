import { describe, it, expect } from "vitest";
import {
  classifyDevice,
  isAndroidEmulatorSerial,
  isWirelessAdbSerial,
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

// A caller uses this to refuse a change that would sever its own transport, so
// both directions have a cost: a miss strands the device behind a switch nobody
// can reach, and a false positive blocks a change that would have worked.
describe("isWirelessAdbSerial", () => {
  it.each([
    "192.168.1.42:5555",
    "10.0.0.7:37105",
    "[fd00::1]:5555",
    "adb-39121FDJG0026R-tGGCXo._adb-tls-connect._tcp",
    "adb-39121FDJG0026R-tGGCXo._adb._tcp",
    "adb-39121FDJG0026R-tGGCXo._adb-tls-pairing._tcp",
  ])("treats %s as reached over the network", (serial) => {
    expect(isWirelessAdbSerial(serial)).toBe(true);
  });

  it.each([
    "emulator-5554",
    "HT82A0203045",
    "39121FDJG0026R",
    "localhost:5555",
    "127.0.0.1:5555",
    "[::1]:5555",
  ])("treats %s as reached over something else", (serial) => {
    expect(isWirelessAdbSerial(serial)).toBe(false);
  });

  it("matches the loopback host case-insensitively", () => {
    // adb echoes the host as typed, so `LOCALHOST:5555` is a serial it can hold.
    expect(isWirelessAdbSerial("LocalHost:5555")).toBe(false);
  });

  it("requires the port to be the whole tail, digits and all", () => {
    // Anchored: without it, a hardware serial with a colon anywhere in it —
    // or a host:port glued to a longer string — would read as an address.
    expect(isWirelessAdbSerial("192.168.1.42:")).toBe(false);
    expect(isWirelessAdbSerial("192.168.1.42:55a5")).toBe(false);
    expect(isWirelessAdbSerial("192.168.1.42:5555 (offline)")).toBe(false);
  });

  it("keeps the whole host, not the shortest match, when the serial has several colons", () => {
    // A lazy or unanchored host capture would leave `[::1]` reading as `[`,
    // which is not in the loopback set — so the forwarded port would be refused.
    expect(isWirelessAdbSerial("[::1]:5555")).toBe(false);
    expect(isWirelessAdbSerial("[fd00::1]:5555")).toBe(true);
  });
});
