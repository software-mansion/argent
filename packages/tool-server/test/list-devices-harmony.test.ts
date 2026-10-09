import { describe, it, expect, vi, beforeEach } from "vitest";

// Every sibling platform branch is stubbed empty at the module boundary so the
// merged list contains only what the HarmonyOS mocks define — the same
// isolation list-devices.test.ts gets from its child_process mock, but keyed
// to the two HarmonyOS discovery sources under test here.
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
    // The id is `harmony-<connectKey>` — a `harmony-emulator-<connectKey>` id
    // here is the id-swap mutation, and makes boot-device read a phone as an
    // emulator instance.
    const phone = harmony.find((d) => d.name === "025DEK236V035771");
    expect(phone).toEqual({
      platform: "harmony",
      udid: "harmony-025DEK236V035771",
      name: "025DEK236V035771",
      kind: "device",
      state: "Connected",
      connection: "USB",
    });
    // State is preserved verbatim — an Offline target must not be laundered
    // into something readiness sorting would call drivable.
    const offline = harmony.find((d) => d.name === "FMR0223C13000654");
    expect(offline).toMatchObject({ kind: "device", state: "Offline", connection: "TCP" });
    // Readiness: the Connected target sorts ahead of the Offline one despite
    // being listed second by hdc.
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
    // `harmony-emulator-<name>` — never `harmony-<name>`, which boot-device
    // would read as a connect key and refuse to start.
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
    // readinessRank's harmony arm: a running instance (booted, drivable once
    // registered) sorts ahead of a stopped one even though the manager listed
    // the stopped one first.
    expect(harmony.map((d) => d.name)).toEqual(["running_emu", "stopped_emu"]);
  });

  it("lists a running emulator under BOTH kinds — connected target and instance", async () => {
    // The same booted emulator is visible to both discovery sources: hdc knows
    // it by its connect key, the Emulator manager by its instance name. Both
    // entries must appear, exactly as a running AVD appears in `adb devices`
    // and the AVD list.
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
    // The drivable entries — the Connected target and the running instance —
    // both sort ahead of the stopped instance.
    expect(harmony.map((d) => [d.kind, d.name, d.state])).toEqual([
      ["device", "127.0.0.1:10000", "Connected"],
      ["emulator", "booted_emu", "running"],
      ["emulator", "stopped_emu", "stopped"],
    ]);
  });

  it("returns the rest of the fleet when a HarmonyOS probe never answers", async () => {
    // Both harmony probes are branches of the same `Promise.all` as every other
    // platform's, so one that hangs — a wedged `hdc` daemon, a stuck manager —
    // takes the whole `alwaysLoad` tool with it unless the branch deadline
    // stands behind its per-call timeout. The listing must come back without
    // the harmony entries rather than not come back.
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
