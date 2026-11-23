import { describe, it, expect } from "vitest";
import {
  listDevicesText,
  shortRuntime,
  STOPPED_SIMULATORS_HEADER,
} from "../src/list-devices-text.js";

const booted = {
  platform: "ios",
  udid: "88332DCB-6B9C-4C88-B1BB-D476D0B0D5E2",
  name: "iPhone 17",
  state: "Booted",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
  runtimeKind: "mobile",
};
const emulator = {
  platform: "android",
  serial: "emulator-5554",
  state: "device",
  isEmulator: true,
  kind: "emulator",
  model: "sdk_gphone64_arm64",
  avdName: "Medium_Phone_API_37.0",
  sdkLevel: 37,
  runtimeKind: "mobile",
};
const phone = {
  platform: "android",
  serial: "R5CT1234",
  state: "unauthorized",
  isEmulator: false,
  kind: "device",
  model: null,
  avdName: null,
  sdkLevel: null,
};
const stoppedTv = {
  platform: "ios",
  udid: "CDE88462-70C3-45EE-AFF4-026FFDEBA2BF",
  name: "Apple TV 4K (3rd generation)",
  state: "Shutdown",
  runtime: "com.apple.CoreSimulator.SimRuntime.tvOS-27-0",
  runtimeKind: "tv",
};
const stoppedDuo = {
  platform: "ios",
  udid: "B7A9BA8A-0CE7-453D-9011-9E241846427A",
  name: "iPhone Duo",
  state: "Shutdown",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-1",
  runtimeKind: "mobile",
  foldable: true,
};
const pairedIphone = {
  platform: "ios",
  kind: "device",
  udid: "00008120-00160D5C14C3A01E",
  name: "Test iPhone",
  state: "paired",
  runtime: "iOS 26.6.1 (physical device)",
  model: "iPhone 15",
  developerModeEnabled: true,
  pairingState: "paired",
  transportType: null,
  tunnelState: "unavailable",
};

describe("shortRuntime", () => {
  it("shortens CoreSimulator runtime ids", () => {
    expect(shortRuntime("com.apple.CoreSimulator.SimRuntime.iOS-27-0")).toBe("iOS 27.0");
    expect(shortRuntime("com.apple.CoreSimulator.SimRuntime.tvOS-26-4-1")).toBe("tvOS 26.4.1");
    expect(shortRuntime("com.apple.CoreSimulator.SimRuntime.xrOS-3-0")).toBe("xrOS 3.0");
  });

  it("leaves a string without the prefix alone", () => {
    expect(shortRuntime("iOS 26.6.1 (physical device)")).toBe("iOS 26.6.1 (physical device)");
  });

  it("only drops the prefix from an id of another shape", () => {
    expect(shortRuntime("com.apple.CoreSimulator.SimRuntime.odd_name")).toBe("odd_name");
    expect(shortRuntime("com.apple.CoreSimulator.SimRuntime.iOS-18-0-beta")).toBe("iOS-18-0-beta");
  });
});

describe("listDevicesText", () => {
  it("lists running devices as compact JSON without the redundant fields", () => {
    const text = listDevicesText({ devices: [booted, emulator], avds: [{ name: "Pixel" }] })!;
    expect(text).toBe(
      '{"devices":[\n' +
        '{"platform":"ios","udid":"88332DCB-6B9C-4C88-B1BB-D476D0B0D5E2","name":"iPhone 17","state":"Booted","runtime":"iOS 27.0"},\n' +
        '{"platform":"android","serial":"emulator-5554","state":"device","kind":"emulator","model":"sdk_gphone64_arm64","avdName":"Medium_Phone_API_37.0","sdkLevel":37}\n' +
        "],\n" +
        '"avds":[{"name":"Pixel"}]}'
    );
  });

  it("puts each simulator that is shut down on one line after the object", () => {
    const text = listDevicesText({ devices: [booted, stoppedDuo, stoppedTv], avds: [] })!;
    const lines = text.split("\n");
    const header = lines.indexOf(STOPPED_SIMULATORS_HEADER);
    expect(header).toBeGreaterThan(0);
    expect(lines.slice(header + 1)).toEqual([
      'ios B7A9BA8A-0CE7-453D-9011-9E241846427A "iPhone Duo" iOS 27.1 Shutdown foldable',
      'ios CDE88462-70C3-45EE-AFF4-026FFDEBA2BF "Apple TV 4K (3rd generation)" tvOS 27.0 Shutdown runtimeKind=tv',
    ]);
    // The object part is still valid JSON on its own.
    expect(JSON.parse(lines.slice(0, header).join("\n"))).toEqual({
      devices: [
        {
          platform: "ios",
          udid: booted.udid,
          name: "iPhone 17",
          state: "Booted",
          runtime: "iOS 27.0",
        },
      ],
      avds: [],
    });
  });

  it("puts a remote simulator that is shut down on one line, under the exact header", () => {
    const stoppedRemote = {
      platform: "ios-remote",
      udid: "remote:ABC",
      name: "Remote iPhone",
      state: "Shutdown",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
      runtimeKind: "mobile",
    };
    expect(listDevicesText({ devices: [stoppedRemote], avds: [] })).toBe(
      '{"devices":[],\n"avds":[]}\n' +
        "iOS simulators that are shut down, one per line (platform, udid, name, runtime, state, tags); start one with boot-device:\n" +
        'ios-remote remote:ABC "Remote iPhone" iOS 27.0 Shutdown'
    );
  });

  it("keeps a simulator in a transitional state in the JSON", () => {
    const booting = { ...stoppedDuo, state: "Booting", foldable: undefined };
    const shuttingDown = { ...stoppedTv, state: "Shutting Down" };
    const text = listDevicesText({ devices: [booting, shuttingDown], avds: [] })!;
    // `boot-device` cannot start either, so the header must not name them.
    expect(text).not.toContain(STOPPED_SIMULATORS_HEADER);
    const parsed = JSON.parse(text) as { devices: Array<Record<string, unknown>> };
    expect(parsed.devices.map((d) => d.state)).toEqual(["Booting", "Shutting Down"]);
    expect(parsed.devices[1]!.runtimeKind).toBe("tv");
  });

  it("carries fields it does not know in both forms", () => {
    const inUse = { ...booted, inUse: true, idleSeconds: 8 };
    const stopped = { ...stoppedDuo, spareField: "a b", count: 3 };
    const text = listDevicesText({ devices: [inUse, stopped], avds: [] })!;
    const lines = text.split("\n");
    const header = lines.indexOf(STOPPED_SIMULATORS_HEADER);
    const object = JSON.parse(lines.slice(0, header).join("\n")) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(object.devices[0]).toMatchObject({ inUse: true, idleSeconds: 8 });
    expect(lines[header + 1]).toBe(
      'ios B7A9BA8A-0CE7-453D-9011-9E241846427A "iPhone Duo" iOS 27.1 Shutdown foldable spareField="a b" count=3'
    );
  });

  it("keeps physical devices, unready phones and their states in full", () => {
    const text = listDevicesText({ devices: [pairedIphone, phone], avds: [] })!;
    const parsed = JSON.parse(text) as { devices: Array<Record<string, unknown>> };
    expect(parsed.devices[0]).toEqual({
      platform: "ios",
      kind: "device",
      udid: pairedIphone.udid,
      name: "Test iPhone",
      state: "paired",
      runtime: "iOS 26.6.1 (physical device)",
      model: "iPhone 15",
      developerModeEnabled: true,
      pairingState: "paired",
      tunnelState: "unavailable",
    });
    expect(parsed.devices[1]).toEqual({
      platform: "android",
      serial: "R5CT1234",
      state: "unauthorized",
      kind: "device",
    });
  });

  it("keeps a provider's simulator in full", () => {
    const external = {
      capabilities: ["simulator-server"],
      external: true,
      id: "ext:abc",
      kind: "simulator",
      name: "Shared iPhone",
      platform: "ios",
      provider: { id: "p", name: "Provider" },
      state: "Shutdown",
      udid: "ext:abc",
    };
    const text = listDevicesText({ devices: [external], avds: [] })!;
    expect(text).not.toContain(STOPPED_SIMULATORS_HEADER);
    expect(JSON.parse(text).devices[0]).toEqual(external);
  });

  it("quotes tag values with spaces and keeps the hint", () => {
    const inSet = {
      ...stoppedDuo,
      foldable: undefined,
      deviceSet: "/Users/me/Library/Application Support/Radon IDE/Devices",
    };
    const text = listDevicesText({ devices: [inSet], avds: [], hint: "Prefix adb." })!;
    expect(text).toContain('deviceSet="/Users/me/Library/Application Support/Radon IDE/Devices"');
    expect(text).toContain('"hint":"Prefix adb."');
  });

  it("returns an empty device list as []", () => {
    expect(listDevicesText({ devices: [], avds: [] })).toBe('{"devices":[],\n"avds":[]}');
  });

  it("returns undefined for a shape it does not know", () => {
    expect(listDevicesText(null)).toBeUndefined();
    expect(listDevicesText({ devices: "x" })).toBeUndefined();
    expect(listDevicesText({ devices: [1] })).toBeUndefined();
  });
});
