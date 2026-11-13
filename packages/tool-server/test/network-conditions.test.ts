import { describe, it, expect, vi, beforeEach } from "vitest";
import { TypedEventEmitter } from "@argent/registry";

vi.mock("../src/utils/adb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/adb")>()),
  runAdb: vi.fn(async () => ({ stdout: "", stderr: "" })),
  adbShell: vi.fn(async () => "Active default network: 101\n"),
}));

vi.mock("../src/utils/check-deps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/check-deps")>()),
  ensureDep: vi.fn(async () => {}),
  ensureDeps: vi.fn(async () => {}),
}));

import { networkConditionsTool } from "../src/tools/network-conditions";
import { networkConditionsZodSchema } from "../src/tools/network-conditions/schema";
import type { NativeDevtoolsAppState } from "../src/blueprints/native-devtools";
import { createNetworkManager } from "../src/chromium-server/network";
import { adbShell, runAdb } from "../src/utils/adb";

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

function fakeNativeDevtools(state: NativeDevtoolsAppState = "connected") {
  const api = {
    getInitFailure: () => null,
    ensureEnvReady: vi.fn(async () => {}),
    appConnectionState: vi.fn(async () => state),
    isConnected: vi.fn(() => state === "connected"),
    setNetworkConditions: vi.fn(async () => {}),
  };
  return { api, services: { nativeDevtools: api } as never };
}

function adbArgs(): string[][] {
  return vi.mocked(runAdb).mock.calls.map(([args]) => args as string[]);
}

beforeEach(() => {
  vi.mocked(runAdb).mockClear();
  vi.mocked(adbShell).mockClear();
});

describe("network-conditions parameters", () => {
  it.each([{ latency: 3000 }, { downloadKbs: 500 }])("rejects the unknown key in %j", (typo) => {
    expect(networkConditionsZodSchema.safeParse({ udid: iosUdid, ...typo }).success).toBe(false);
  });

  it("routes each platform to its own service", () => {
    expect(Object.keys(networkConditionsTool.services!({ udid: chromiumUdid }))).toEqual([
      "chromium",
    ]);
    expect(Object.keys(networkConditionsTool.services!({ udid: iosUdid, bundleId }))).toEqual([
      "nativeDevtools",
    ]);
    expect(networkConditionsTool.services!({ udid: androidEmulator })).toEqual({});
  });
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

describe("network-conditions on Chromium, when the tab refuses the conditions", () => {
  it("keeps applying the previous conditions after a tab switch", async () => {
    const { send, network, services } = chromiumServices();
    await networkConditionsTool.execute(services, { udid: chromiumUdid, offline: true });
    send.mockRejectedValueOnce(new Error("Target closed"));

    await expect(
      networkConditionsTool.execute(services, { udid: chromiumUdid, latencyMs: 100 })
    ).rejects.toThrow("Target closed");
    send.mockClear();
    await network.reattach();

    expect(emulatedConditionsCalls(send)[0]![1]).toMatchObject({ offline: true, latency: 0 });
  });
});

describe("network-conditions on an Android emulator", () => {
  it.each([
    { latencyMs: 400 },
    { downloadKbps: 1600 },
    { uploadKbps: 750 },
    { offline: true, latencyMs: 1 },
  ])(
    "fails for %j, which the emulator console cannot shape, before any adb traffic",
    async (conditions) => {
      await expect(
        networkConditionsTool.execute({} as never, { udid: androidEmulator, ...conditions })
      ).rejects.toThrow(/supports only `offline`/);
      expect(runAdb).not.toHaveBeenCalled();
    }
  );

  it("turns Wi-Fi and mobile data off for offline", async () => {
    await expect(
      networkConditionsTool.execute({} as never, { udid: androidEmulator, offline: true })
    ).resolves.toEqual({ scope: "device", conditions: { offline: true } });

    expect(adbArgs()).toEqual([
      ["-s", androidEmulator, "shell", "svc", "wifi", "disable"],
      ["-s", androidEmulator, "shell", "svc", "data", "disable"],
    ]);
  });

  it("turns the radios on at a reset and waits until a network is up", async () => {
    vi.mocked(adbShell)
      .mockResolvedValueOnce("Active default network: none\n")
      .mockResolvedValueOnce("Active default network: 102\n");

    await expect(
      networkConditionsTool.execute({} as never, { udid: androidEmulator })
    ).resolves.toEqual({ scope: "device", conditions: null });

    expect(adbArgs()).toEqual([
      ["-s", androidEmulator, "shell", "svc", "wifi", "enable"],
      ["-s", androidEmulator, "shell", "svc", "data", "enable"],
    ]);
    expect(adbShell).toHaveBeenCalledTimes(2);
  });

  it("still turns Wi-Fi on when the telephony service has not started yet", async () => {
    vi.mocked(runAdb)
      .mockResolvedValueOnce({ stdout: "", stderr: "" } as never)
      .mockRejectedValueOnce(new Error("svc data enable failed: cmd: Can't find service: phone"));

    await expect(
      networkConditionsTool.execute({} as never, { udid: androidEmulator })
    ).resolves.toEqual({ scope: "device", conditions: null });
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
      conditions: { offline: false, latency: 500, downloadThroughput: -1, uploadThroughput: -1 },
      metroPort: 8081,
    });
  });

  it("leaves the Metro port named by `port` unthrottled", async () => {
    const { api, services } = fakeNativeDevtools();

    await networkConditionsTool.execute(services, {
      udid: iosUdid,
      bundleId,
      port: 8095,
      offline: true,
    });

    expect(api.setNetworkConditions).toHaveBeenCalledWith(
      bundleId,
      expect.objectContaining({ metroPort: 8095 })
    );
  });

  it("fails when the app does not confirm the conditions", async () => {
    const { api, services } = fakeNativeDevtools();
    api.setNetworkConditions.mockRejectedValueOnce(new Error("CDP RPC timed out"));

    await expect(
      networkConditionsTool.execute(services, { udid: iosUdid, bundleId, offline: true })
    ).rejects.toThrow(/timed out/);
  });

  it("requires a bundleId", async () => {
    const { api, services } = fakeNativeDevtools();

    await expect(
      networkConditionsTool.execute(services, { udid: iosUdid, offline: true })
    ).rejects.toThrow(/bundleId/);
    expect(api.setNetworkConditions).not.toHaveBeenCalled();
  });

  it.each([{ offline: true }, {}])(
    "refuses an Apple system app with its own message for %j",
    async (conditions) => {
      const { api, services } = fakeNativeDevtools();

      await expect(
        networkConditionsTool.execute(services, {
          udid: iosUdid,
          bundleId: "com.apple.mobilesafari",
          ...conditions,
        })
      ).rejects.toThrow(/Apple system app\. network-conditions on iOS/);
      expect(api.setNetworkConditions).not.toHaveBeenCalled();
    }
  );

  it.each([{ offline: true }, {}])(
    "returns restart_required for %j when the running app lost its connection",
    async (conditions) => {
      const { api, services } = fakeNativeDevtools("stale_process");

      const result = await networkConditionsTool.execute(services, {
        udid: iosUdid,
        bundleId,
        ...conditions,
      });

      expect(result).toMatchObject({ status: "restart_required" });
      expect(api.setNetworkConditions).not.toHaveBeenCalled();
    }
  );

  it("clears the stored conditions when the app is not running", async () => {
    const { api, services } = fakeNativeDevtools("not_running");

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
