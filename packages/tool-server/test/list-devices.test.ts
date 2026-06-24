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

// Chromium discovery probes real TCP ports (9222 plus any persisted by a
// previous tool-server on this machine). A developer actually running an
// Chromium app would leak it into this test's device list — stub discovery
// so the result only contains what the simctl / adb mocks define.
vi.mock("../src/utils/chromium-discovery", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/chromium-discovery")>(
    "../src/utils/chromium-discovery"
  );
  return { ...actual, discoverChromiumDevices: vi.fn(async () => []) };
});

// VVD image enumeration hits the real filesystem (~/vega SDK); stub it so `vvds`
// is deterministic. Defaults to none; the dedicated test overrides per-call.
vi.mock("../src/utils/vega-sdk", () => ({ listVvdImages: vi.fn(async () => []) }));

import { listDevicesTool } from "../src/tools/devices/list-devices";
import { __resetVegaBinaryCacheForTests } from "../src/utils/vega-cli";
import { listVvdImages } from "../src/utils/vega-sdk";

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

  // A running VVD surfaces on adb as `emulator-XXXX`; the dedup reads its console
  // port from the `vega-virtual-device` process (mocked via the `ps` branch).
  function mockVegaVvd(cmd: string, args: string[]): { stdout: string; stderr: string } | null {
    if (cmd === "/bin/sh" && args[0] === "-c" && args[1]?.includes("command -v vega")) {
      return { stdout: "/usr/bin/vega\n", stderr: "" };
    }
    if (cmd === "/bin/sh" && args[0] === "-c") return { stdout: "", stderr: "" }; // kepler probe
    if (cmd.endsWith("vega") && args[0] === "device" && args[1] === "list") {
      return {
        stdout:
          "Found the following device:\nVirtualDevice : tv - aarch64 - OS - amazon-4a27df03c9777152\n",
        stderr: "",
      };
    }
    if (cmd.endsWith("vega") && args[0] === "virtual-device" && args[1] === "status") {
      return { stdout: JSON.stringify({ running: true }), stderr: "" };
    }
    if (cmd.endsWith("vega") && args[0] === "device" && args[1] === "info") {
      return { stdout: JSON.stringify({ product: "vvrp_aarch64", simulated: true }), stderr: "" };
    }
    return null;
  }

  // A `ps` listing with a `vega-virtual-device` process per console port.
  function psWithVvds(...consolePorts: number[]): { stdout: string; stderr: string } {
    const lines = ["/sbin/launchd", "/usr/libexec/secd"];
    for (const p of consolePorts) {
      lines.push(
        "/Users/me/vega/sdk/vega-sdk/main/0.22.6759/vvd/images/tv/vmtools/agent/qemu/" +
          `darwin-aarch64/vega-virtual-device -avd-arch arm64 -ports ${p},${p + 1} ` +
          `-qemu -qmp unix:/tmp/qmp-socket-${p}.sock,server,nowait`
      );
    }
    return { stdout: lines.join("\n") + "\n", stderr: "" };
  }

  it("de-duplicates a running VVD that also auto-registers on adb (shows only as vega)", async () => {
    __resetVegaBinaryCacheForTests();
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const vega = mockVegaVvd(cmd, args);
      if (vega) return vega;
      if (cmd === "ps") return psWithVvds(5554); // VVD on console port 5554
      if (cmd === "xcrun") return { stdout: simctlJson(), stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        return { stdout: "", stderr: "" }; // enrichment getprops — irrelevant to dedup
      }
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});
    const android = result.devices.filter((d) => d.platform === "android");
    const vega = result.devices.filter((d) => d.platform === "vega");

    expect(vega).toHaveLength(1);
    expect((vega[0] as { serial: string }).serial).toBe("amazon-4a27df03c9777152");
    // The emulator-5554 shadow row is dropped — the VVD appears exactly once.
    expect(android).toHaveLength(0);
  });

  it("de-duplicates a VVD reached via `adb connect` 127.0.0.1:5555 (edge 1)", async () => {
    __resetVegaBinaryCacheForTests();
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const vega = mockVegaVvd(cmd, args);
      if (vega) return vega;
      if (cmd === "ps") return psWithVvds(5554);
      if (cmd === "xcrun") return { stdout: simctlJson(), stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        // adb port = console + 1, so the `adb connect` serial is 127.0.0.1:5555.
        return { stdout: "List of devices attached\n127.0.0.1:5555\tdevice\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});
    expect(result.devices.filter((d) => d.platform === "android")).toHaveLength(0);
    expect(result.devices.filter((d) => d.platform === "vega")).toHaveLength(1);
  });

  it("keeps a real Android emulator running alongside the VVD (edge 2 / distinguishes QEMU)", async () => {
    // Real emulator on 5554, VVD on 5556 (from its process). Only the VVD's row is
    // dropped; a co-running emulator / QEMU is never mistaken for the VVD.
    __resetVegaBinaryCacheForTests();
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const vega = mockVegaVvd(cmd, args);
      if (vega) return vega;
      if (cmd === "ps") return psWithVvds(5556); // VVD on console port 5556
      if (cmd === "xcrun") return { stdout: simctlJson(), stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        return {
          stdout: "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n",
          stderr: "",
        };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        const shellCmd = args[3] ?? "";
        if (shellCmd.includes("ro.product.model")) return { stdout: "Pixel_7\n", stderr: "" };
        if (shellCmd.includes("ro.build.version.sdk")) return { stdout: "34\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});
    const android = result.devices.filter((d) => d.platform === "android");
    const vega = result.devices.filter((d) => d.platform === "vega");

    expect(vega).toHaveLength(1);
    // The shadow (emulator-5556) is dropped; the real emulator stays.
    expect(android).toHaveLength(1);
    expect((android[0] as { serial: string }).serial).toBe("emulator-5554");
  });

  it("does not filter an emulator when no VVD process is running (e.g. mid-boot)", async () => {
    // Vega SDK present but no `vega-virtual-device` process → no running VVD. A
    // standalone emulator must NOT be mistaken for a shadow.
    __resetVegaBinaryCacheForTests();
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "/bin/sh" && args[0] === "-c" && args[1]?.includes("command -v vega")) {
        return { stdout: "/usr/bin/vega\n", stderr: "" };
      }
      if (cmd === "/bin/sh" && args[0] === "-c") return { stdout: "", stderr: "" };
      if (cmd.endsWith("vega") && args[0] === "device" && args[1] === "list") {
        return { stdout: "Found the following device:\n", stderr: "" }; // no devices
      }
      if (cmd === "ps") return { stdout: "/sbin/launchd\n", stderr: "" }; // no VVD process
      if (cmd === "xcrun") return { stdout: simctlJson(), stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});
    const android = result.devices.filter((d) => d.platform === "android");
    const vega = result.devices.filter((d) => d.platform === "vega");

    expect(vega).toHaveLength(0);
    expect(android).toHaveLength(1);
    expect((android[0] as { serial: string }).serial).toBe("emulator-5554");
  });

  it("does not re-list a running VVD as a phantom stopped image when its profile is absent", async () => {
    // `vega device info` omits `profile`, but an image named "tv" is installed.
    // The running VVD must dedup against that image (single installed image) so it
    // shows up once as running, not also as a stopped "tv".
    __resetVegaBinaryCacheForTests();
    vi.mocked(listVvdImages).mockResolvedValueOnce([{ name: "tv", path: "/sdk/vvd/images/tv" }]);
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      const vega = mockVegaVvd(cmd, args);
      if (vega) return vega;
      if (cmd === "ps") return psWithVvds(5554);
      if (cmd === "xcrun") return { stdout: simctlJson(), stderr: "" };
      if (cmd === "adb" && args[0] === "devices") {
        return { stdout: "List of devices attached\nemulator-5554\tdevice\n", stderr: "" };
      }
      if (cmd === "adb" && args[0] === "-s" && args[2] === "shell") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});
    const vega = result.devices.filter((d) => d.platform === "vega") as Array<{
      state: string;
      serial: string | null;
      vvdImage: string | null;
    }>;

    expect(vega).toHaveLength(1);
    expect(vega[0]).toMatchObject({ state: "running", vvdImage: "tv" });
  });

  it("lists an installed-but-stopped VVD under devices[] (state stopped, no serial)", async () => {
    __resetVegaBinaryCacheForTests();
    vi.mocked(listVvdImages).mockResolvedValueOnce([{ name: "tv", path: "/sdk/vvd/images/tv" }]);
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "/bin/sh" && args[0] === "-c" && args[1]?.includes("command -v vega")) {
        return { stdout: "/usr/bin/vega\n", stderr: "" };
      }
      if (cmd === "/bin/sh" && args[0] === "-c") return { stdout: "", stderr: "" };
      // No device connected and not running → the VVD is stopped.
      if (cmd.endsWith("vega") && args[0] === "device" && args[1] === "list") {
        return { stdout: "Found the following device:\n", stderr: "" };
      }
      if (cmd === "xcrun") return { stdout: simctlJson(), stderr: "" };
      return { stdout: "", stderr: "" };
    });

    const result = await listDevicesTool.execute!({}, {});
    const vega = result.devices.filter((d) => d.platform === "vega") as Array<{
      kind: string;
      state: string;
      serial: string | null;
      vvdImage: string | null;
    }>;

    expect(vega).toHaveLength(1);
    expect(vega[0]).toMatchObject({
      kind: "vvd",
      state: "stopped",
      serial: null,
      vvdImage: "tv",
    });
  });
});
