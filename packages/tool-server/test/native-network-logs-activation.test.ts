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

/**
 * The service as a read sees it once network-capture-start started the app's
 * capture. The calls a read must never make, the ones that turn capture on,
 * are spies.
 */
function startedApi(over: Record<string, unknown> = {}) {
  return {
    isNetworkCaptureStarted: () => true,
    isNetworkCaptureStopped: () => false,
    startNetworkCapture: vi.fn(async () => true),
    refreshLentNetworkCapture: vi.fn(async () => {}),
    armsEnv: true,
    ...over,
  } as any;
}

async function tool() {
  const { createNativeNetworkLogsTool } =
    await import("../src/tools/native-devtools/native-network-logs");
  const { Registry } = await import("@argent/registry");
  return createNativeNetworkLogsTool(new Registry());
}

const params = { udid: UDID, bundleId: "com.example.app", limit: 50, clear: false };

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
  ] as const)("answers $status for a started app without turning capture on", async (block) => {
    const { precheckNativeDevtools } = await import("../src/blueprints/native-devtools");
    vi.mocked(precheckNativeDevtools).mockResolvedValueOnce(block);
    const api = startedApi();

    const result = await (await tool()).execute({ nativeDevtools: api }, params);

    expect(result).toEqual(block);
    // network-capture-start already made capture sticky for the relaunch the block asks for.
    expect(api.startNetworkCapture).not.toHaveBeenCalled();
    expect(api.refreshLentNetworkCapture).not.toHaveBeenCalled();
  });

  it("keeps the missed-requests note for the first ok answer", async () => {
    const { precheckNativeDevtools } = await import("../src/blueprints/native-devtools");
    // Blocked once, then through.
    vi.mocked(precheckNativeDevtools)
      .mockResolvedValueOnce({ status: "init_failed", message: "re-boot" } as any)
      .mockResolvedValueOnce(null);
    // The start found the app already running.
    let gap = true;
    const api = startedApi({
      takeCaptureGap: vi.fn(() => {
        const had = gap;
        gap = false;
        return had;
      }),
      isConnected: () => true,
      networkRecords: () => ({ records: () => [], state: () => ({ armed: true }), clear() {} }),
    });
    const nativeNetworkLogsTool = await tool();

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
    expect(api.startNetworkCapture).not.toHaveBeenCalled();
  });

  it("says capture is armed when a started app is not connected yet", async () => {
    const { precheckNativeDevtools } = await import("../src/blueprints/native-devtools");
    vi.mocked(precheckNativeDevtools).mockResolvedValueOnce(null);
    const api = startedApi({ isConnected: () => false });

    await expect((await tool()).execute({ nativeDevtools: api }, params)).rejects.toThrow(
      /capture for it is armed.*call again/
    );
    expect(api.startNetworkCapture).not.toHaveBeenCalled();
  });
});
