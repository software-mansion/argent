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
});
