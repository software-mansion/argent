import { describe, it, expect, vi, beforeEach } from "vitest";

// HarmonyOS is behind the `harmonyos` flag; these cases drive it with the flag on.
vi.mock("../src/utils/harmony-flag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/harmony-flag")>()),
  isHarmonyEnabled: () => true,
}));

// Sibling platforms are stubbed empty so only the HarmonyOS mocks contribute.
vi.mock("../src/utils/adb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/adb")>();
  return {
    ...actual,
    listAndroidDevices: vi.fn(async () => []),
    listAvds: vi.fn(async () => []),
  };
});
vi.mock("../src/utils/ios-devices", () => ({ listIosSimulators: vi.fn(async () => []) }));
vi.mock("../src/utils/sim-remote", () => ({
  simctlListDevices: vi.fn(async () => ({ devices: {} })),
}));
vi.mock("../src/utils/chromium-discovery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/chromium-discovery")>();
  return { ...actual, discoverChromiumDevices: vi.fn(async () => []) };
});
vi.mock("../src/utils/vega-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/vega-devices")>();
  return { ...actual, listVegaDevices: vi.fn(async () => []) };
});
vi.mock("../src/utils/harmony-devices", () => ({
  listHarmonyInstances: vi.fn(async () => []),
  listHarmonyHdcTargets: vi.fn(async () => []),
}));

import { BRANCH_DEADLINE_MS, listDevicesTool } from "../src/tools/devices/list-devices";
import { listHarmonyInstances, listHarmonyHdcTargets } from "../src/utils/harmony-devices";

const instances = vi.mocked(listHarmonyInstances);
const hdcTargets = vi.mocked(listHarmonyHdcTargets);

type HarmonyEntry = {
  platform: "harmony";
  udid: string;
  name: string;
  kind: "emulator" | "device";
  state: string;
  connection?: string | null;
  deviceType?: string | null;
  osVersion?: string | null;
};

async function listHarmony(): Promise<HarmonyEntry[]> {
  const result = await listDevicesTool.execute!({}, {});
  return result.devices.filter((d) => d.platform === "harmony") as HarmonyEntry[];
}

beforeEach(() => {
  instances.mockReset().mockResolvedValue([]);
  hdcTargets.mockReset().mockResolvedValue([]);
});

describe("list-devices HarmonyOS branch", () => {
  it("maps a connected hdc target to kind 'device', keyed and named by its connectKey", async () => {
    hdcTargets.mockResolvedValue([
      { connectKey: "FMR0223C13000654", connection: "TCP", state: "Offline" },
      { connectKey: "025DEK236V035771", connection: "USB", state: "Connected" },
    ]);

    const harmony = await listHarmony();

    expect(harmony).toHaveLength(2);
    const phone = harmony.find((d) => d.name === "025DEK236V035771");
    expect(phone).toEqual({
      platform: "harmony",
      udid: "harmony-025DEK236V035771",
      name: "025DEK236V035771",
      kind: "device",
      state: "Connected",
      connection: "USB",
    });
    const offline = harmony.find((d) => d.name === "FMR0223C13000654");
    expect(offline).toMatchObject({ kind: "device", state: "Offline", connection: "TCP" });
    expect(harmony[0]!.name).toBe("025DEK236V035771");
  });

  it("maps DevEco instances to kind 'emulator' with running/stopped state and metadata", async () => {
    instances.mockResolvedValue([
      {
        name: "stopped_emu",
        deviceType: "Foldable",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: false,
        display: null,
      },
      {
        name: "running_emu",
        deviceType: "Phone",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: true,
        display: null,
      },
    ]);

    const harmony = await listHarmony();

    expect(harmony).toHaveLength(2);
    const running = harmony.find((d) => d.name === "running_emu");
    expect(running).toEqual({
      platform: "harmony",
      udid: "harmony-emulator-running_emu",
      name: "running_emu",
      kind: "emulator",
      state: "running",
      deviceType: "Phone",
      osVersion: "HarmonyOS 6.1.1(24)",
    });
    const stopped = harmony.find((d) => d.name === "stopped_emu");
    expect(stopped).toMatchObject({
      udid: "harmony-emulator-stopped_emu",
      kind: "emulator",
      state: "stopped",
      deviceType: "Foldable",
    });
    expect(harmony.map((d) => d.name)).toEqual(["running_emu", "stopped_emu"]);
  });

  it("lists a running emulator under BOTH kinds — connected target and instance", async () => {
    // A booted emulator is listed by both hdc and the manager, like an AVD.
    hdcTargets.mockResolvedValue([
      { connectKey: "127.0.0.1:10000", connection: "TCP", state: "Connected" },
    ]);
    instances.mockResolvedValue([
      {
        name: "stopped_emu",
        deviceType: "Phone",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: false,
        display: null,
      },
      {
        name: "booted_emu",
        deviceType: "Phone",
        osVersion: "HarmonyOS 6.1.1(24)",
        running: true,
        display: null,
      },
    ]);

    const harmony = await listHarmony();

    expect(harmony).toHaveLength(3);
    expect(harmony.filter((d) => d.kind === "device")).toHaveLength(1);
    expect(harmony.filter((d) => d.kind === "emulator")).toHaveLength(2);
    expect(harmony.map((d) => [d.kind, d.name, d.state])).toEqual([
      ["device", "127.0.0.1:10000", "Connected"],
      ["emulator", "booted_emu", "running"],
      ["emulator", "stopped_emu", "stopped"],
    ]);
  });

  it("returns the rest of the fleet when a HarmonyOS probe never answers", async () => {
    // A hung probe must not take the whole listing with it.
    vi.useFakeTimers();
    hdcTargets.mockImplementation(() => new Promise(() => {}));
    instances.mockResolvedValue([
      { name: "emu", deviceType: "Phone", osVersion: null, running: false, display: null },
    ]);

    const pending = listDevicesTool.execute!({}, {});
    await vi.advanceTimersByTimeAsync(BRANCH_DEADLINE_MS + 1_000);
    const devices = (await pending).devices.filter((d) => d.platform === "harmony");

    expect(devices.map((d) => d.kind)).toEqual(["emulator"]);
    vi.useRealTimers();
  });
});
