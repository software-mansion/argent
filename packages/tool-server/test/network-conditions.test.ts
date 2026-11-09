import { describe, it, expect, vi, beforeEach } from "vitest";
import { TypedEventEmitter } from "@argent/registry";

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async () => ({ stdout: "OK\n", stderr: "" })),
}));

vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
  ensureDeps: vi.fn(async () => {}),
}));

import { networkConditionsTool } from "../src/tools/network-conditions";
import { createNetworkManager } from "../src/chromium-server/network";
import { runAdb } from "../src/utils/adb";

const chromiumUdid = "chromium-cdp-9222";
const androidEmulator = "emulator-5554";
const iosUdid = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const bundleId = "com.example.app";

function fakeCdp() {
  const events = new TypedEventEmitter<{
    event: (m: string, p: Record<string, unknown>) => void;
  }>();
  const send = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({}) as unknown);
  return { send, cdp: { events, send } as never };
}

function chromiumServices() {
  const { send, cdp } = fakeCdp();
  const network = createNetworkManager({ cdp });
  return { send, network, services: { chromium: { server: { network } } } as never };
}

function emulatedConditionsCalls(send: ReturnType<typeof fakeCdp>["send"]) {
  return send.mock.calls.filter(([method]) => method === "Network.emulateNetworkConditions");
}

function fakeNativeDevtools(options: { connected?: boolean } = {}) {
  const api = {
    getInitFailure: () => null,
    ensureEnvReady: vi.fn(async () => {}),
    appConnectionState: vi.fn(async () =>
      options.connected === false ? "not_running" : "connected"
    ),
    isConnected: vi.fn(() => options.connected !== false),
    setNetworkConditions: vi.fn(),
  };
  return { api, services: { nativeDevtools: api } as never };
}

function adbArgs(): string[][] {
  return vi.mocked(runAdb).mock.calls.map(([args]) => args as string[]);
}

beforeEach(() => {
  vi.mocked(runAdb).mockClear();
});

describe("network-conditions on Chromium", () => {
  it("sends Network.emulateNetworkConditions with throughput in bytes per second", async () => {
    const { send, services } = chromiumServices();

    await expect(
      networkConditionsTool.execute(services, {
        udid: chromiumUdid,
        latencyMs: 300,
        downloadKbps: 1600,
      })
    ).resolves.toEqual({ scope: "tab", conditions: { latencyMs: 300, downloadKbps: 1600 } });

    expect(emulatedConditionsCalls(send)).toEqual([
      [
        "Network.emulateNetworkConditions",
        { offline: false, latency: 300, downloadThroughput: 200_000, uploadThroughput: -1 },
      ],
    ]);
  });

  it("resets throttling when no condition is given", async () => {
    const { send, services } = chromiumServices();

    await expect(networkConditionsTool.execute(services, { udid: chromiumUdid })).resolves.toEqual({
      scope: "tab",
      conditions: null,
    });

    expect(emulatedConditionsCalls(send)).toEqual([
      [
        "Network.emulateNetworkConditions",
        { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      ],
    ]);
  });

  it("applies the conditions again when the session reattaches to a new tab", async () => {
    const { send, network, services } = chromiumServices();
    await networkConditionsTool.execute(services, { udid: chromiumUdid, offline: true });
    send.mockClear();

    await network.reattach();

    expect(send.mock.calls.map(([method]) => method)).toEqual([
      "Network.enable",
      "Network.emulateNetworkConditions",
    ]);
    expect(emulatedConditionsCalls(send)[0]![1]).toMatchObject({ offline: true });
  });
});

describe("network-conditions on an Android emulator", () => {
  it("sets speed and delay on the emulator console and leaves the radios alone", async () => {
    await expect(
      networkConditionsTool.execute({} as never, {
        udid: androidEmulator,
        latencyMs: 400,
        downloadKbps: 1600,
        uploadKbps: 750,
      })
    ).resolves.toEqual({
      scope: "device",
      conditions: { latencyMs: 400, downloadKbps: 1600, uploadKbps: 750 },
    });

    expect(adbArgs()).toEqual([
      ["-s", androidEmulator, "emu", "network", "speed", "750:1600"],
      ["-s", androidEmulator, "emu", "network", "delay", "400"],
    ]);
  });

  it("leaves an unset direction unlimited", async () => {
    await networkConditionsTool.execute({} as never, { udid: androidEmulator, downloadKbps: 500 });

    expect(adbArgs()[0]).toEqual(["-s", androidEmulator, "emu", "network", "speed", "0:500"]);
  });

  it("resets to full speed, no delay and radios on when no condition is given", async () => {
    await expect(
      networkConditionsTool.execute({} as never, { udid: androidEmulator })
    ).resolves.toEqual({ scope: "device", conditions: null });

    expect(adbArgs()).toEqual([
      ["-s", androidEmulator, "emu", "network", "speed", "full"],
      ["-s", androidEmulator, "emu", "network", "delay", "none"],
      ["-s", androidEmulator, "shell", "svc", "wifi", "enable"],
      ["-s", androidEmulator, "shell", "svc", "data", "enable"],
    ]);
  });

  it("turns Wi-Fi and mobile data off for offline and back on at the next throttle call", async () => {
    await networkConditionsTool.execute({} as never, { udid: androidEmulator, offline: true });

    expect(adbArgs()).toContainEqual(["-s", androidEmulator, "shell", "svc", "wifi", "disable"]);
    expect(adbArgs()).toContainEqual(["-s", androidEmulator, "shell", "svc", "data", "disable"]);
    vi.mocked(runAdb).mockClear();

    await networkConditionsTool.execute({} as never, { udid: androidEmulator, latencyMs: 100 });

    expect(adbArgs()).toEqual([
      ["-s", androidEmulator, "emu", "network", "speed", "full"],
      ["-s", androidEmulator, "emu", "network", "delay", "100"],
      ["-s", androidEmulator, "shell", "svc", "wifi", "enable"],
      ["-s", androidEmulator, "shell", "svc", "data", "enable"],
    ]);
  });

  it("fails when the emulator console rejects a command", async () => {
    vi.mocked(runAdb).mockResolvedValueOnce({ stdout: "KO: bad speed\n", stderr: "" } as never);

    await expect(
      networkConditionsTool.execute({} as never, { udid: androidEmulator, downloadKbps: 1 })
    ).rejects.toThrow(/KO: bad speed/);
  });

  it("rejects a physical Android device before any adb traffic", async () => {
    await expect(
      networkConditionsTool.execute({} as never, { udid: "R5CT80ZABCD", latencyMs: 100 })
    ).rejects.toThrow(/not supported on android device/i);
    expect(runAdb).not.toHaveBeenCalled();
  });
});

describe("network-conditions on an iOS simulator", () => {
  it("hands the conditions to the app's native devtools", async () => {
    const { api, services } = fakeNativeDevtools();

    await expect(
      networkConditionsTool.execute(services, { udid: iosUdid, bundleId, latencyMs: 500 })
    ).resolves.toEqual({ scope: "app", conditions: { latencyMs: 500 } });

    expect(api.setNetworkConditions).toHaveBeenCalledWith(bundleId, {
      offline: false,
      latency: 500,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  });

  it("requires a bundleId", async () => {
    const { api, services } = fakeNativeDevtools();

    await expect(
      networkConditionsTool.execute(services, { udid: iosUdid, offline: true })
    ).rejects.toThrow(/bundleId/);
    expect(api.setNetworkConditions).not.toHaveBeenCalled();
  });

  it("returns the precheck status when the app is not connected", async () => {
    const { api, services } = fakeNativeDevtools({ connected: false });

    const result = await networkConditionsTool.execute(services, {
      udid: iosUdid,
      bundleId,
      offline: true,
    });

    expect(result).toMatchObject({ status: "restart_required" });
    expect(api.setNetworkConditions).not.toHaveBeenCalled();
  });

  it("clears the conditions even when the app is not connected", async () => {
    const { api, services } = fakeNativeDevtools({ connected: false });

    await expect(
      networkConditionsTool.execute(services, { udid: iosUdid, bundleId })
    ).resolves.toEqual({ scope: "app", conditions: null });

    expect(api.setNetworkConditions).toHaveBeenCalledWith(bundleId, null);
  });

  it("rejects a physical iOS device", async () => {
    const { services } = fakeNativeDevtools();

    await expect(
      networkConditionsTool.execute(services, {
        udid: "00008110-000978540290401E",
        bundleId,
        latencyMs: 100,
      })
    ).rejects.toThrow(/not supported on ios device/i);
  });
});
