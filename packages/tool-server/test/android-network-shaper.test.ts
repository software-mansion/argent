import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ShapingProxyOptions } from "../src/utils/network-shaping-proxy";

const proxy = vi.hoisted(() => ({
  options: null as ShapingProxyOptions | null,
  setConditions: vi.fn(),
  close: vi.fn(async () => {}),
}));

vi.mock("../src/utils/network-shaping-proxy", () => ({
  startShapingProxy: vi.fn(async (options: ShapingProxyOptions) => {
    proxy.options = options;
    return { port: 50000, setConditions: proxy.setConditions, close: proxy.close };
  }),
}));

vi.mock("../src/utils/android-global-proxy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/android-global-proxy")>()),
  setArgentProxy: vi.fn(async () => {}),
  clearArgentProxy: vi.fn(async () => {}),
  listAdbReverses: vi.fn(async () => new Map([[3000, 4000]])),
}));

import { androidNetworkShaperBlueprint } from "../src/blueprints/android-network-shaper";
import { clearArgentProxy, setArgentProxy } from "../src/utils/android-global-proxy";

const SERIAL = "emulator-5554";

async function instantiate() {
  return androidNetworkShaperBlueprint.factory({}, SERIAL);
}

beforeEach(() => {
  vi.mocked(setArgentProxy).mockReset().mockResolvedValue();
  vi.mocked(clearArgentProxy).mockReset().mockResolvedValue();
  proxy.setConditions.mockClear();
  proxy.close.mockClear();
});

describe("the Android network shaper", () => {
  it("shapes through its proxy and points the emulator at it", async () => {
    const { api } = await instantiate();

    await api.throttle({ latencyMs: 400 }, 8081);

    expect(proxy.setConditions).toHaveBeenCalledWith({ latencyMs: 400 });
    expect(setArgentProxy).toHaveBeenCalledWith(SERIAL, 50000);
  });

  it("removes the conditions and the emulator's proxy on clear", async () => {
    const { api } = await instantiate();

    await api.clear();

    expect(proxy.setConditions).toHaveBeenCalledWith(null);
    expect(clearArgentProxy).toHaveBeenCalledWith(SERIAL);
  });

  it("removes the emulator's proxy when the tool-server stops", async () => {
    const instance = await instantiate();
    await instance.api.throttle({ latencyMs: 400 }, 8081);

    await instance.dispose();

    expect(clearArgentProxy).toHaveBeenCalledWith(SERIAL);
    expect(proxy.close).toHaveBeenCalled();
  });

  it("removes the proxy of a throttle that was still waiting when the tool-server stops", async () => {
    const instance = await instantiate();
    const order: string[] = [];
    vi.mocked(setArgentProxy).mockImplementation(async () => void order.push("set"));
    vi.mocked(clearArgentProxy).mockImplementation(async () => void order.push("clear"));

    const reset = instance.api.clear();
    const throttle = instance.api.throttle({ latencyMs: 400 }, 8081);
    await Promise.all([reset, throttle, instance.dispose()]);

    expect(order).toEqual(["clear", "set", "clear"]);
  });

  it("leaves the emulator alone when it stops without having throttled", async () => {
    const instance = await instantiate();

    await instance.dispose();

    expect(clearArgentProxy).not.toHaveBeenCalled();
    expect(proxy.close).toHaveBeenCalled();
  });

  it("runs the next call after one that fails", async () => {
    const { api } = await instantiate();
    vi.mocked(setArgentProxy).mockRejectedValueOnce(new Error("user proxy"));

    const [first, second] = await Promise.allSettled([
      api.throttle({ latencyMs: 400 }, 8081),
      api.clear(),
    ]);

    expect(first).toMatchObject({ status: "rejected" });
    expect(second).toEqual({ status: "fulfilled", value: undefined });
    expect(clearArgentProxy).toHaveBeenCalledTimes(1);
  });

  describe("targets", () => {
    async function proxyOptions(): Promise<ShapingProxyOptions> {
      const { api } = await instantiate();
      await api.throttle({ latencyMs: 400 }, 8081);
      return proxy.options!;
    }

    it("reaches the host's loopback for 10.0.2.2", async () => {
      const options = await proxyOptions();

      await expect(options.resolveTarget("10.0.2.2", 3000)).resolves.toEqual({
        host: "127.0.0.1",
        port: 3000,
      });
    });

    it("follows adb reverse for the device's own loopback", async () => {
      const options = await proxyOptions();

      await expect(options.resolveTarget("localhost", 3000)).resolves.toEqual({
        host: "localhost",
        port: 4000,
      });
      await expect(options.resolveTarget("127.0.0.1", 3000)).resolves.toMatchObject({
        port: 4000,
      });
    });

    it("cannot reach a device port without adb reverse", async () => {
      const options = await proxyOptions();

      await expect(options.resolveTarget("localhost", 5000)).resolves.toBeNull();
    });

    it("connects to any other host as named", async () => {
      const options = await proxyOptions();

      await expect(options.resolveTarget("example.com", 443)).resolves.toEqual({
        host: "example.com",
        port: 443,
      });
    });

    it("leaves only the Metro port of the host and the device's loopback unshaped", async () => {
      const options = await proxyOptions();

      expect(options.bypass("10.0.2.2", 8081)).toBe(true);
      expect(options.bypass("localhost", 8081)).toBe(true);
      expect(options.bypass("127.0.0.1", 8081)).toBe(true);
      expect(options.bypass("10.0.2.2", 3000)).toBe(false);
      expect(options.bypass("example.com", 8081)).toBe(false);
    });

    it("follows the Metro port of the latest throttle", async () => {
      const { api } = await instantiate();
      await api.throttle({ latencyMs: 400 }, 8082);

      expect(proxy.options!.bypass("10.0.2.2", 8082)).toBe(true);
      expect(proxy.options!.bypass("10.0.2.2", 8081)).toBe(false);
    });
  });
});
