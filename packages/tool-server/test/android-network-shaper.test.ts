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

    await api.throttle({ latencyMs: 400 });

    expect(proxy.setConditions).toHaveBeenCalledWith({ latencyMs: 400 });
    expect(setArgentProxy).toHaveBeenCalledWith(SERIAL, 50000);
  });

  it("removes the conditions and the emulator's proxy on clear", async () => {
    const { api } = await instantiate();

    await api.clear();

    expect(proxy.setConditions).toHaveBeenCalledWith(null);
    expect(clearArgentProxy).toHaveBeenCalledWith(SERIAL);
  });

  it("removes the proxy of a throttle still waiting when the tool-server stops", async () => {
    const instance = await instantiate();
    const order: string[] = [];
    vi.mocked(setArgentProxy).mockImplementation(async () => void order.push("set"));
    vi.mocked(clearArgentProxy).mockImplementation(async () => void order.push("clear"));

    const throttle = instance.api.throttle({ latencyMs: 400 });
    await Promise.all([throttle, instance.dispose()]);

    expect(order).toEqual(["set", "clear"]);
    expect(proxy.close).toHaveBeenCalled();
  });

  it("leaves the emulator alone when it stops without having throttled", async () => {
    const instance = await instantiate();

    await instance.dispose();

    expect(clearArgentProxy).not.toHaveBeenCalled();
    expect(proxy.close).toHaveBeenCalled();
  });

  it("sends 10.0.2.2 to the host's loopback and any other host as named", async () => {
    await instantiate();
    const { resolveTarget } = proxy.options!;

    await expect(resolveTarget("10.0.2.2", 3000)).resolves.toEqual({
      host: "127.0.0.1",
      port: 3000,
    });
    await expect(resolveTarget("example.com", 443)).resolves.toEqual({
      host: "example.com",
      port: 443,
    });
  });
});
