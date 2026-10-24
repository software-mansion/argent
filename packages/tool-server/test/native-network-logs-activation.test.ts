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

  it("registers network capture before answering restart_required", async () => {
    const activateNetworkInspection = vi.fn();
    const api = { activateNetworkInspection } as any;
    const { nativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");

    const result = await nativeNetworkLogsTool.execute(
      { nativeDevtools: api },
      { udid: UDID, bundleId: "com.example.app", limit: 50, clear: false }
    );

    expect(result).toMatchObject({ status: "restart_required" });
    // So the relaunched app starts capturing at its handshake.
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
      activateNetworkInspection: vi.fn(() => {
        gap = true;
      }),
      takeCaptureGap: vi.fn(() => {
        const had = gap;
        gap = false;
        return had;
      }),
      isConnected: () => true,
      getNetworkLog: () => [],
      armsEnv: true,
    } as any;
    const { nativeNetworkLogsTool } =
      await import("../src/tools/native-devtools/native-network-logs");
    const params = { udid: UDID, bundleId: "com.example.app", limit: 50, clear: false };

    expect(await nativeNetworkLogsTool.execute({ nativeDevtools: api }, params)).toMatchObject({
      status: "init_failed",
    });
    expect(api.takeCaptureGap).not.toHaveBeenCalled();

    const ok = (await nativeNetworkLogsTool.execute({ nativeDevtools: api }, params)) as {
      status: string;
      note?: string;
    };
    expect(ok.status).toBe("ok");
    expect(ok.note).toMatch(/were not recorded.*restart-app/);
  });
});
