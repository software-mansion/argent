import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/blueprints/native-devtools", async () => {
  const actual = await vi.importActual<typeof import("../src/blueprints/native-devtools")>(
    "../src/blueprints/native-devtools"
  );
  return {
    ...actual,
    precheckNativeDevtools: vi.fn(async () => ({
      status: "restart_required",
      message: "restart the app",
    })),
  };
});

const UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

describe("native-network-logs before the app is instrumented", () => {
  beforeEach(async () => {
    const { __resetDepCacheForTests, __primeDepCacheForTests } =
      await import("../src/utils/check-deps");
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun"]);
  });

  it.each([
    { status: "restart_required", message: "restart the app" },
    { status: "service_stale", message: "restart the tool-server" },
    { status: "connect_pending", message: "wait and retry" },
  ] as const)("registers network capture before answering $status", async (block) => {
    const { precheckNativeDevtools } = await import("../src/blueprints/native-devtools");
    vi.mocked(precheckNativeDevtools).mockResolvedValueOnce(block);
    const activateNetworkInspection = vi.fn();
    const api = { activateNetworkInspection } as any;
    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

    const result = await nativeNetworkLogsTool.execute(
      { nativeDevtools: api },
      { udid: UDID, bundleId: "com.example.app", limit: 50, clear: false }
    );

    expect(result).toEqual(block);
    // So the app starts capturing as soon as it connects, whatever the block asked for.
    expect(activateNetworkInspection).toHaveBeenCalledWith("com.example.app");
  });

  it("keeps the missed-requests note for the first ok answer", async () => {
    const { precheckNativeDevtools } = await import("../src/blueprints/native-devtools");
    // Blocked once (init_failed after activation reached a live connection), then through.
    vi.mocked(precheckNativeDevtools)
      .mockResolvedValueOnce({ status: "init_failed", message: "re-boot" } as any)
      .mockResolvedValueOnce(null);
    let gap = false;
    const api = {
      activateNetworkInspection: vi.fn(async () => {
        gap = true;
        return true;
      }),
      takeCaptureGap: vi.fn(() => {
        const had = gap;
        gap = false;
        return had;
      }),
      isConnected: () => true,
      networkRecords: () => ({ records: () => [], state: () => ({ armed: true }), clear() {} }),
      armsEnv: true,
    } as any;
    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());
    const params = { udid: UDID, bundleId: "com.example.app", limit: 50, clear: false };

    expect(await nativeNetworkLogsTool.execute({ nativeDevtools: api }, params)).toMatchObject({
      status: "init_failed",
    });
    expect(api.takeCaptureGap).not.toHaveBeenCalled();

    const ok = (await nativeNetworkLogsTool.execute({ nativeDevtools: api }, params)) as {
      status: string;
      header: string;
    };
    expect(ok.status).toBe("ok");
    expect(ok.header).toMatch(/were not recorded.*restart-app/);
  });

  it("says capture is armed when the app is not connected yet", async () => {
    const { precheckNativeDevtools } = await import("../src/blueprints/native-devtools");
    vi.mocked(precheckNativeDevtools).mockResolvedValueOnce(null);
    const activateNetworkInspection = vi.fn();
    const api = { activateNetworkInspection, isConnected: () => false, armsEnv: true } as any;
    const { createNativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const { Registry } = await import("@argent/registry");
    const nativeNetworkLogsTool = createNativeNetworkLogsTool(new Registry());

    await expect(
      nativeNetworkLogsTool.execute(
        { nativeDevtools: api },
        { udid: UDID, bundleId: "com.example.app", limit: 50, clear: false }
      )
    ).rejects.toThrow(/capture for it is armed.*call again/);
    expect(activateNetworkInspection).toHaveBeenCalledWith("com.example.app");
  });
});
