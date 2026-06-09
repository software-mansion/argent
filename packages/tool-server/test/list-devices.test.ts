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

// `runAdb` and `listAvds` resolve adb / emulator to an absolute path before
// spawning, so a bare `cmd === "adb" / "emulator"` matcher would never fire
// on real hosts. Stub the resolver to return the bare name so existing test
// mocks keep working regardless of host SDK install state.
vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (name: "adb" | "emulator") => name),
  __resetAndroidBinaryCacheForTesting: () => {},
}));

import { listDevicesTool } from "../src/tools/devices/list-devices";

function simctlJson(): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
        {
          udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
          name: "iPhone 16",
          state: "Booted",
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          isAvailable: true,
        },
        {
          udid: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
          name: "iPad Pro",
          state: "Shutdown",
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro",
          isAvailable: true,
        },
        {
          udid: "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC",
          name: "iPhone 16 (unavailable)",
          state: "Shutdown",
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          isAvailable: false,
        },
      ],
      "com.apple.CoreSimulator.SimRuntime.tvOS-17-5": [
        {
          udid: "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD",
          name: "Apple TV",
          state: "Shutdown",
          deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.Apple-TV",
          isAvailable: true,
        },
      ],
    },
  });
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe("list-devices", () => {
  it("merges iOS simulators and Android devices into a single tagged array", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "xcrun" && args[0] === "simctl" && args[1] === "list") {
        return { stdout: simctlJson(), stderr: "" };
      }
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shellCmd = args[3] ?? "";
        if (shellCmd.includes("ro.product.model")) return { stdout: "Pixel_3a\n", stderr: "" };
        if (shellCmd.includes("ro.build.version.sdk")) return { stdout: "34\n", stderr: "" };
        if (shellCmd.includes("ro.kernel.qemu.avd_name"))
          return { stdout: "Pixel_3a_API_34\n", stderr: "" };
      }
      if (cmd === "emulator" && args[0] === "-list-avds") {
        return { stdout: "Pixel_3a_API_34\nPixel_7_API_34\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});

    // Every device has a `platform` discriminator; there is no separate iOS/Android
    // list the caller has to merge.
    for (const d of result.devices) {
      expect(d.platform === "ios" || d.platform === "android").toBe(true);
    }

    const ios = result.devices.filter((d) => d.platform === "ios") as Array<{
      platform: "ios";
      udid: string;
      name: string;
      state: string;
    }>;
    // Unavailable simulators are filtered out; tvOS is filtered out (non-iOS runtime).
    expect(ios.map((d) => d.name).sort()).toEqual(["iPad Pro", "iPhone 16"]);
    // Booted iOS devices come before shut-down ones.
    expect(ios[0]!.state).toBe("Booted");
    expect(ios[0]!.name).toBe("iPhone 16");

    const android = result.devices.filter((d) => d.platform === "android") as Array<{
      platform: "android";
      serial: string;
      sdkLevel: number | null;
      avdName: string | null;
      isEmulator: boolean;
    }>;
    expect(android).toHaveLength(1);
    expect(android[0]).toMatchObject({
      serial: "emulator-5554",
      sdkLevel: 34,
      avdName: "Pixel_3a_API_34",
      isEmulator: true,
    });

    // AVDs list comes from `emulator -list-avds`.
    expect(result.avds).toEqual([{ name: "Pixel_3a_API_34" }, { name: "Pixel_7_API_34" }]);
  });

  it("silently omits iOS when xcrun is unavailable — other platforms still returned", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "xcrun") {
        return new Error("xcrun: error: invalid active developer path");
      }
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        return { stdout: "", stderr: "" };
      }
      if (cmd === "emulator") {
        return { stdout: "Pixel_3a_API_34\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});
    expect(result.devices.filter((d) => d.platform === "ios")).toHaveLength(0);
    expect(result.devices.filter((d) => d.platform === "android")).toHaveLength(1);
    expect(result.avds.length).toBeGreaterThan(0);
  });

  it("silently omits Android when adb is unavailable — iOS still returned", async () => {
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "xcrun" && args[0] === "simctl") {
        return { stdout: simctlJson(), stderr: "" };
      }
      if (cmd === "adb") {
        return new Error("adb: command not found");
      }
      if (cmd === "emulator") {
        return new Error("emulator: command not found");
      }
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});
    expect(result.devices.filter((d) => d.platform === "android")).toHaveLength(0);
    expect(result.devices.filter((d) => d.platform === "ios").length).toBeGreaterThan(0);
    expect(result.avds).toEqual([]);
  });
});
