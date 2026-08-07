import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `list-devices` is the only way a physical iPhone becomes visible, and three of
 * the things it decides are load-bearing for everything downstream: whether the
 * opt-in flag is consulted at all (with it off, nothing may shell `devicectl`),
 * the `kind` discriminator the tool description tells agents to branch on, and
 * the readiness rank that decides which device an auto-detecting caller picks.
 * `list-devices.test.ts` has no physical case and never looks at `kind`.
 */
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
      const result = execFileMock(cmd, args);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

vi.mock("../src/utils/android-binary", () => ({
  resolveAndroidBinary: vi.fn(async (n: string) => n),
}));
vi.mock("../src/utils/chromium-discovery", () => ({
  discoverChromiumDevices: vi.fn(async () => []),
}));
vi.mock("../src/utils/vega-sdk", () => ({ listVvdImages: vi.fn(async () => []) }));
vi.mock("../src/utils/vega-process", () => ({ listRunningVvdConsolePorts: vi.fn(async () => []) }));

vi.mock("@argent/configuration-core", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isFlagEnabled: vi.fn(),
}));

import { isFlagEnabled } from "@argent/configuration-core";
import { listDevicesTool } from "../src/tools/devices/list-devices";

const PHYSICAL_UDID = "00008120-000E6D0C0ABBA01E";
const SIM_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const mockFlag = vi.mocked(isFlagEnabled);

// One Shutdown simulator, so the connected iPhone has something to sort against.
const simctlJson = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      {
        udid: SIM_UDID,
        name: "iPhone 16",
        state: "Shutdown",
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        isAvailable: true,
      },
    ],
  },
});

const devicectlJson = JSON.stringify({
  result: {
    devices: [
      {
        hardwareProperties: { udid: PHYSICAL_UDID, platform: "iOS", productType: "iPhone15,4" },
        deviceProperties: { name: "Real iPhone" },
        connectionProperties: { transportType: "wired", tunnelState: "connected" },
      },
    ],
  },
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  execFileMock.mockReset();
  mockFlag.mockReset();
  // `listIosDevices` is darwin-only; this suite is about what it does once it runs.
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "darwin" });
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "xcrun" && args[0] === "simctl") return { stdout: simctlJson, stderr: "" };
    if (cmd === "xcrun" && args[0] === "devicectl") return { stdout: devicectlJson, stderr: "" };
    return { stdout: "", stderr: "" };
  });
});

function devicectlSpawns() {
  return execFileMock.mock.calls.filter(
    ([cmd, args]) => cmd === "xcrun" && args[0] === "devicectl"
  );
}

describe("list-devices discovery of a physical iPhone", () => {
  it("discovers nothing, and shells no devicectl, while the flag is off", async () => {
    mockFlag.mockReturnValue(false);
    const result = await listDevicesTool.execute!({}, {});

    expect(result.devices.map((d) => (d as { udid?: string }).udid)).not.toContain(PHYSICAL_UDID);
    // Not merely filtered afterwards: an opt-in feature must not run Xcode at all.
    expect(devicectlSpawns()).toEqual([]);
  });

  it('tags the iPhone `kind: "device"` and the simulator `kind: "simulator"`', async () => {
    mockFlag.mockReturnValue(true);
    const result = await listDevicesTool.execute!({}, {});

    const ios = result.devices.filter((d) => d.platform === "ios") as Array<{
      udid: string;
      kind: string;
      state: string;
      productType?: string | null;
      runtime?: string;
    }>;
    const physical = ios.find((d) => d.udid === PHYSICAL_UDID);
    const sim = ios.find((d) => d.udid === SIM_UDID);

    // `kind` is what `resolveDevice` and every capability check branch on; a
    // physical iPhone mislabelled "simulator" is routed to simctl backends.
    expect(physical).toBeDefined();
    expect(physical!.kind).toBe("device");
    expect(physical!.state).toBe("connected");
    expect(physical!.productType).toBe("iPhone15,4");
    expect(sim!.kind).toBe("simulator");
  });

  it("ranks a connected iPhone as ready, ahead of a shut-down simulator", async () => {
    // "Booted" is simulator vocabulary; hardware reports "connected". Ranking
    // only on "Booted" pushes the one usable device to the bottom of the list an
    // agent picks its target from.
    mockFlag.mockReturnValue(true);
    const result = await listDevicesTool.execute!({}, {});
    const ids = result.devices.map((d) => (d as { udid?: string; serial?: string }).udid);
    expect(ids.indexOf(PHYSICAL_UDID)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(PHYSICAL_UDID)).toBeLessThan(ids.indexOf(SIM_UDID));
  });
});
