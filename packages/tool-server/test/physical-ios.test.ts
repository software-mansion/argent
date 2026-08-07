import { describe, it, expect } from "vitest";
import {
  classifyDevice,
  resolveDevice,
  isPhysicalIos,
  isPhysicalIosUdid,
} from "../src/utils/device-info";
import { parsePhysicalIosDevices } from "../src/utils/ios-devices";
import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { devicesToPreviewEntries } from "../src/preview";
import type { ListDevicesResult } from "../src/tools/devices/list-devices";

// A real iPhone's UDID: 8-hex ECID, one dash, 16 hex.
const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SIM_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

describe("physical iOS classification", () => {
  it("classifies a physical iPhone UDID as ios", () => {
    expect(classifyDevice(PHYSICAL_UDID)).toBe("ios");
  });

  it("resolves a physical iPhone UDID to ios + device", () => {
    const d = resolveDevice(PHYSICAL_UDID);
    expect(d.platform).toBe("ios");
    expect(d.kind).toBe("device");
    expect(d.id).toBe(PHYSICAL_UDID);
  });

  it("still resolves a simulator UUID to ios + simulator", () => {
    const d = resolveDevice(SIM_UDID);
    expect(d.platform).toBe("ios");
    expect(d.kind).toBe("simulator");
  });

  it("matches only the exact 8hex-16hex shape, in either case, whole-string", () => {
    // Everything routes off this one predicate — classification, `kind`,
    // `subcommandForDevice`, the capability gate and the opt-in. The existing
    // negatives (an Android serial, an ip:port, a simulator UUID) fail an
    // unanchored, loosely-quantised, uppercase-only pattern too, so they hold
    // none of its three load-bearing properties.
    //
    // Case: `IOS_UDID_SHAPE` right above it is deliberately case-insensitive;
    // devicectl prints hex uppercase but a user retyping a udid may not.
    expect(isPhysicalIosUdid("00008120-000e6d0c0abba01e")).toBe(true);
    expect(isPhysicalIosUdid("00008120-000E6d0C0aBBa01E")).toBe(true);

    // Anchors: a string that merely CONTAINS the shape is not one. Without them
    // a pasted line, or an argument with a udid inside it, classifies as an
    // iPhone and routes to the CoreDevice backend.
    for (const near of [
      `${PHYSICAL_UDID}\n`,
      `${PHYSICAL_UDID}F`,
      `x${PHYSICAL_UDID}`,
      ` ${PHYSICAL_UDID}`,
    ]) {
      expect(isPhysicalIosUdid(near), JSON.stringify(near)).toBe(false);
    }

    // Run lengths: exactly 8 then exactly 16. The pre-A12 40-hex form is
    // deliberately excluded (that hardware cannot reach the iOS 26 floor the
    // CoreDevice read needs), and a short hex pair is not a udid at all.
    for (const wrong of [
      "cafe-babe",
      "0000812-000E6D0C0ABBA01E",
      "000081200-000E6D0C0ABBA01E",
      "00008120-000E6D0C0ABBA01",
      "00008120-000E6D0C0ABBA01EF",
    ]) {
      expect(isPhysicalIosUdid(wrong), wrong).toBe(false);
    }
  });

  it("isPhysicalIosUdid distinguishes device from simulator shapes", () => {
    expect(isPhysicalIosUdid(PHYSICAL_UDID)).toBe(true);
    expect(isPhysicalIosUdid(SIM_UDID)).toBe(false);
  });

  it("isPhysicalIos is true only for ios+device", () => {
    expect(isPhysicalIos(resolveDevice(PHYSICAL_UDID))).toBe(true);
    expect(isPhysicalIos(resolveDevice(SIM_UDID))).toBe(false);
    expect(isPhysicalIos(resolveDevice("emulator-5554"))).toBe(false);
  });

  it("does not reclassify Android serials as physical iOS", () => {
    // No 8hex-16hex Android serials in the wild; guard against regressions.
    expect(classifyDevice("HT82A0203045")).toBe("android");
    expect(classifyDevice("192.168.1.5:5555")).toBe("android");
    expect(resolveDevice("HT82A0203045").kind).toBe("device");
  });
});

describe("parsePhysicalIosDevices (devicectl JSON)", () => {
  const sample = {
    result: {
      devices: [
        // Connected iPhone — kept.
        {
          hardwareProperties: { udid: PHYSICAL_UDID, platform: "iOS", productType: "iPhone15,4" },
          deviceProperties: { name: "iPhone 15" },
          connectionProperties: { transportType: "wired", tunnelState: "disconnected" },
        },
        // Paired but offline (no transportType, tunnelState unavailable) — dropped.
        {
          hardwareProperties: {
            udid: "00008030-00096526219B802E",
            platform: "iOS",
            productType: "iPhone12,8",
          },
          deviceProperties: { name: "Old iPhone" },
          connectionProperties: { tunnelState: "unavailable" },
        },
        // A connected Apple Watch — dropped (not iOS).
        {
          hardwareProperties: {
            udid: "11111111-2222222222222222",
            platform: "watchOS",
            productType: "Watch7,1",
          },
          deviceProperties: { name: "Watch" },
          connectionProperties: { transportType: "wired" },
        },
      ],
    },
  };

  it("keeps only connected iOS devices with the right fields", () => {
    const out = parsePhysicalIosDevices(sample);
    expect(out).toEqual([
      { udid: PHYSICAL_UDID, name: "iPhone 15", productType: "iPhone15,4", state: "connected" },
    ]);
  });

  it("returns [] for empty/missing input", () => {
    expect(parsePhysicalIosDevices({})).toEqual([]);
    expect(parsePhysicalIosDevices({ result: { devices: [] } })).toEqual([]);
  });
});

describe("lifecycle tools don't eagerly resolve native-devtools for local iOS", () => {
  // Regression guard: the registry resolves a tool's services() BEFORE execute(),
  // and the native-devtools service throws a simulator-only guard for physical
  // devices. So eagerly resolving it for a physical iPhone would break launch-app
  // (a supported tool) and mask restart-app's intended rejection message. Local
  // iOS (simulator and physical alike) resolves native-devtools lazily inside the
  // handler instead — only ios-remote declares it eagerly via services().
  const launchAppTool = createLaunchAppTool({} as never);
  const restartAppTool = createRestartAppTool({} as never);
  const params = (udid: string) => ({ udid, bundleId: "com.apple.Preferences" });

  it("launch-app: omitted for both physical device and simulator", () => {
    expect(launchAppTool.services(params(PHYSICAL_UDID)).nativeDevtools).toBeUndefined();
    expect(launchAppTool.services(params(SIM_UDID)).nativeDevtools).toBeUndefined();
  });

  it("restart-app: omitted for both physical device and simulator", () => {
    expect(restartAppTool.services(params(PHYSICAL_UDID)).nativeDevtools).toBeUndefined();
    expect(restartAppTool.services(params(SIM_UDID)).nativeDevtools).toBeUndefined();
  });
});

describe("preview target list excludes targets it can't stream", () => {
  // Regression guard: the preview / Lens UI streams frames over simulator-server,
  // which refuses physical iOS (kind === "device", driven over CoreDevice) and
  // never serves Chromium. Those must not leak into the selectable target list.
  const devices: ListDevicesResult["devices"] = [
    {
      platform: "ios",
      udid: SIM_UDID,
      name: "iPhone 16 Pro",
      state: "Booted",
      kind: "simulator",
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-5",
    },
    {
      platform: "ios",
      udid: PHYSICAL_UDID,
      name: "iPhone 15",
      state: "connected",
      kind: "device",
      productType: "iPhone15,4",
    },
    {
      platform: "android",
      serial: "emulator-5554",
      state: "device",
      isEmulator: true,
      kind: "emulator",
      model: "Pixel 7",
      avdName: "Pixel_7_API_33",
      sdkLevel: 34,
    },
    {
      platform: "chromium",
      id: "chromium-1",
      title: "App",
      port: 9222,
      url: "about:blank",
      browser: "Chrome/120",
      state: "Running",
    },
  ];

  it("includes the simulator and the Android emulator", () => {
    const entries = devicesToPreviewEntries(devices);
    expect(entries.map((e) => e.udid).sort()).toEqual([SIM_UDID, "emulator-5554"].sort());
  });

  it("excludes the physical iPhone and the Chromium app", () => {
    const entries = devicesToPreviewEntries(devices);
    expect(entries.some((e) => e.udid === PHYSICAL_UDID)).toBe(false);
    expect(entries.some((e) => e.platform !== "ios" && e.platform !== "android")).toBe(false);
  });

  it("keeps `runtime` a string for a simulator that reports one", () => {
    const [sim] = devicesToPreviewEntries(devices);
    expect(typeof sim!.runtime).toBe("string");
    expect(sim!.runtime.length).toBeGreaterThan(0);
  });
});
