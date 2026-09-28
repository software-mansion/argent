import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

// The profile plist is read from disk; the fake bundle paths below must exist.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: (p: string) => String(p).includes(".simdevicetype") };
});

import {
  __resetSimulatorRuntimeKindCacheForTesting,
  isFoldableDeviceType,
  isFoldableSimulator,
  listIosSimulators,
} from "../src/utils/ios-devices";

const DUO = "B6C52FD4-5408-402B-9369-EF7C66B98E6F";
const PRO = "8BDBFD47-E557-41BA-926B-2DD39A17A53E";
const DUO_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
const PRO_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro";
const DUO_BUNDLE = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone Duo.simdevicetype";
const PRO_BUNDLE =
  "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 18 Pro.simdevicetype";

/** The `capabilities.displays` of each profile, as `plutil -extract` prints them. */
const DISPLAYS: Record<string, unknown[]> = {
  [DUO_BUNDLE]: [
    { screenID: 1, displayType: "integrated", deviceName: "primary" },
    { screenID: 3, displayType: "integrated", deviceName: "primary-1", nativeRotation: 270 },
    { screenID: 2, displayType: "tvOut" },
    { screenID: 4, displayType: "carPlay" },
    { screenID: 5, displayType: "scene" },
  ],
  [PRO_BUNDLE]: [
    { screenID: 1, displayType: "integrated" },
    { screenID: 2, displayType: "tvOut" },
    { screenID: 3, displayType: "carPlay" },
    { screenID: 4, displayType: "scene" },
  ],
};

function mockSimctl(): void {
  execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
    if (cmd === "xcrun" && args[0] === "simctl" && args[1] === "list" && args[2] === "devices") {
      return {
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [
              {
                udid: DUO,
                name: "iPhone Duo",
                state: "Booted",
                deviceTypeIdentifier: DUO_TYPE,
                isAvailable: true,
              },
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
              {
                udid: PRO,
                name: "iPhone 18 Pro",
                state: "Shutdown",
                deviceTypeIdentifier: PRO_TYPE,
                isAvailable: true,
              },
            ],
          },
        }),
      };
    }
    if (
      cmd === "xcrun" &&
      args[0] === "simctl" &&
      args[1] === "list" &&
      args[2] === "devicetypes"
    ) {
      return {
        stdout: JSON.stringify({
          devicetypes: [
            { identifier: DUO_TYPE, name: "iPhone Duo", bundlePath: DUO_BUNDLE },
            { identifier: PRO_TYPE, name: "iPhone 18 Pro", bundlePath: PRO_BUNDLE },
          ],
        }),
      };
    }
    if (cmd === "plutil") {
      const plist = args[args.length - 1]!;
      const bundle = Object.keys(DISPLAYS).find((b) => plist.startsWith(b));
      expect(args.slice(0, 5)).toEqual(["-extract", "capabilities.displays", "json", "-o", "-"]);
      return bundle ? { stdout: JSON.stringify(DISPLAYS[bundle]) } : new Error("no such file");
    }
    return new Error(`unexpected ${cmd} ${args.join(" ")}`);
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  __resetSimulatorRuntimeKindCacheForTesting();
  mockSimctl();
});

describe("foldable simulators", () => {
  it("flags a device type with more than one integrated display", async () => {
    expect(await isFoldableDeviceType(DUO_TYPE)).toBe(true);
    expect(await isFoldableDeviceType(PRO_TYPE)).toBe(false);
    expect(await isFoldableDeviceType("com.apple.CoreSimulator.SimDeviceType.Nope")).toBe(false);
  });

  it("reads each profile once, whatever the number of listings", async () => {
    await listIosSimulators();
    await listIosSimulators();
    const plutilCalls = execFileMock.mock.calls.filter(([cmd]) => cmd === "plutil");
    expect(plutilCalls).toHaveLength(2);
    const typeListings = execFileMock.mock.calls.filter(
      ([, args]) => (args as string[])[2] === "devicetypes"
    );
    expect(typeListings).toHaveLength(1);
  });

  it("lists the foldable with `foldable: true` and every other device without the key", async () => {
    const sims = await listIosSimulators();
    expect(sims.find((s) => s.udid === DUO)).toMatchObject({ name: "iPhone Duo", foldable: true });
    expect(sims.find((s) => s.udid === PRO)).not.toHaveProperty("foldable");
  });

  it("answers per UDID, memoized by the listing", async () => {
    expect(await isFoldableSimulator(DUO)).toBe(true);
    expect(await isFoldableSimulator(PRO)).toBe(false);
    expect(await isFoldableSimulator("ext:acme-3f2a9c:" + DUO)).toBe(true);
    execFileMock.mockClear();
    expect(await isFoldableSimulator(DUO)).toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(await isFoldableSimulator("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("degrades to not foldable when the profile cannot be read", async () => {
    execFileMock.mockImplementation((cmd: string, args: readonly string[]) => {
      if (cmd === "plutil") return new Error("plutil: cannot read");
      if (cmd === "xcrun" && args[2] === "devicetypes") return { stdout: "garbage" };
      return { stdout: JSON.stringify({ devices: {} }) };
    });
    expect(await isFoldableDeviceType(DUO_TYPE)).toBe(false);
  });
});
