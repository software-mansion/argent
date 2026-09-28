import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { listIosPhysicalDevices } from "../src/utils/ios-device/devicectl";

const fake = vi.hoisted(() => ({
  payload: null as unknown,
  argv: [] as string[],
}));

// devicectl promisifies execFile at module load, so the mock must replace the
// callback-style function itself (same idiom as ios-device-devicectl-hints).
// devicectl writes JSON to the --json-output tmp file named in argv, never to
// stdout, so the success path scripts the payload by writing that file.
vi.mock("node:child_process", async () => {
  const { writeFileSync } = await import("node:fs");
  return {
    execFile: (_file: unknown, args: unknown, _options: unknown, callback: unknown) => {
      const argv = args as string[];
      fake.argv = argv;
      writeFileSync(argv[argv.indexOf("--json-output") + 1], JSON.stringify(fake.payload));
      (callback as (error: null, result: { stdout: string; stderr: string }) => void)(null, {
        stdout: "",
        stderr: "",
      });
    },
  };
});

// listIosPhysicalDevices returns [] off-macOS before spawning anything; pin
// darwin so the fixture path runs on any host.
const originalPlatform = process.platform;
beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

// Row shapes mirror live-verified `devicectl list devices` payloads: a real
// phone reports hardwareProperties.reality "physical"; a simulator, when
// CoreDevice lists one, reports "simulated" with otherwise-passing platform
// and productType (and a simulator-style UUID); older toolchains omit the
// field entirely.
const PHYSICAL_ROW = {
  hardwareProperties: {
    udid: "00008110-000978540290401E",
    platform: "iOS",
    productType: "iPhone14,5",
    marketingName: "iPhone 13",
    reality: "physical",
  },
  deviceProperties: {
    name: "Test iPhone",
    osVersionNumber: "26.0",
    developerModeStatus: "enabled",
  },
  connectionProperties: {
    pairingState: "paired",
    transportType: "wired",
    tunnelState: "connected",
  },
};

const SIMULATED_ROW = {
  hardwareProperties: {
    udid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEFFFF0000",
    platform: "iOS",
    productType: "iPhone17,2",
    reality: "simulated",
  },
  deviceProperties: { name: "iPhone 17 Pro" },
};

const REALITY_ABSENT_ROW = {
  hardwareProperties: {
    udid: "00008030-001A2B3C4D5E6F70",
    platform: "iOS",
    productType: "iPhone12,1",
  },
  deviceProperties: { name: "Older-Xcode iPhone" },
};

// Physical-device support is iPhone-only for now: a real iPad must be dropped
// while a simulated iPad is dropped by the reality check first.
const PHYSICAL_IPAD_ROW = {
  hardwareProperties: {
    udid: "00008103-000E4C3A0287001E",
    platform: "iOS",
    productType: "iPad13,18",
    marketingName: "iPad (10th generation)",
    reality: "physical",
  },
  deviceProperties: { name: "Test iPad" },
};

const SIMULATED_IPAD_ROW = {
  hardwareProperties: {
    udid: "BBBBBBBB-CCCC-4DDD-8EEE-FFFF00001111",
    platform: "iOS",
    productType: "iPad14,3",
    reality: "simulated",
  },
  deviceProperties: { name: "iPad Pro 11-inch" },
};

describe("listIosPhysicalDevices filters on hardwareProperties.reality", () => {
  it("emits physical and reality-absent rows and drops simulated ones", async () => {
    fake.payload = { result: { devices: [PHYSICAL_ROW, SIMULATED_ROW, REALITY_ABSENT_ROW] } };

    const devices = await listIosPhysicalDevices();

    expect(devices.map((d) => d.udid)).toEqual([
      "00008110-000978540290401E",
      "00008030-001A2B3C4D5E6F70",
    ]);
    // No iPad in the payload, so nothing was skipped by the iPhone-only filter.
    // The physical row's mapping is untouched by the filter.
    expect(devices[0]).toMatchObject({
      name: "Test iPhone",
      model: "iPhone 13",
      developerModeEnabled: true,
      transportType: "wired",
      tunnelState: "connected",
    });
    expect(fake.argv.slice(0, 3)).toEqual(["devicectl", "list", "devices"]);
  });
});

describe("listIosPhysicalDevices is iPhone-only", () => {
  it("drops a physical iPad", async () => {
    fake.payload = { result: { devices: [PHYSICAL_ROW, PHYSICAL_IPAD_ROW] } };

    const devices = await listIosPhysicalDevices();

    // The iPad never reaches the devices array; the count is the only trace,
    // so list-devices can explain the absence.
    expect(devices.map((d) => d.udid)).toEqual(["00008110-000978540290401E"]);
  });

  it("does not count a simulated iPad: only skipped hardware deserves a note", async () => {
    fake.payload = { result: { devices: [SIMULATED_IPAD_ROW] } };

    const devices = await listIosPhysicalDevices();

    expect(devices).toEqual([]);
  });
});

describe("listIosPhysicalDevices falls back for absent name and model", () => {
  it("names a row after its udid and leaves the model null", async () => {
    fake.payload = {
      result: { devices: [{ hardwareProperties: { udid: "00008030-DEADBEEF", platform: "iOS" } }] },
    };

    const devices = await listIosPhysicalDevices();

    // Absent fields read as null everywhere else in the row, and a device with
    // no reported name is still addressable by its udid.
    expect(devices[0]).toMatchObject({ name: "00008030-DEADBEEF", model: null });
  });
});
