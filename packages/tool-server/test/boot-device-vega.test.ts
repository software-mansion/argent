import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Registry } from "@argent/registry";

const listVvdImages = vi.fn();
const isVvdRunning = vi.fn();
const startVvd = vi.fn();
const stopVvd = vi.fn();
const waitForVvdRunning = vi.fn();
const resolveRunningVvdSerial = vi.fn();
const listVegaDevices = vi.fn();
const ensureDep = vi.fn();

vi.mock("../src/utils/vega-sdk", () => ({
  listVvdImages: (...a: unknown[]) => listVvdImages(...a),
}));
vi.mock("../src/utils/vega-vvd", () => ({
  isVvdRunning: (...a: unknown[]) => isVvdRunning(...a),
  startVvd: (...a: unknown[]) => startVvd(...a),
  stopVvd: (...a: unknown[]) => stopVvd(...a),
  waitForVvdRunning: (...a: unknown[]) => waitForVvdRunning(...a),
}));
vi.mock("../src/utils/vega-devices", () => ({
  resolveRunningVvdSerial: (...a: unknown[]) => resolveRunningVvdSerial(...a),
  listVegaDevices: (...a: unknown[]) => listVegaDevices(...a),
}));
vi.mock("../src/utils/check-deps", async () => {
  const actual =
    await vi.importActual<typeof import("../src/utils/check-deps")>("../src/utils/check-deps");
  return { ...actual, ensureDep: (...a: unknown[]) => ensureDep(...a) };
});

import { createBootDeviceTool } from "../src/tools/devices/boot-device";

const registry = {} as Registry;
const SERIAL = "amazon-4a27df03c9777152";

beforeEach(() => {
  vi.clearAllMocks();
  listVvdImages.mockResolvedValue([{ name: "tv", path: "/sdk/vvd/images/tv" }]);
  ensureDep.mockResolvedValue(undefined);
  startVvd.mockResolvedValue(undefined);
  stopVvd.mockResolvedValue(undefined);
  waitForVvdRunning.mockResolvedValue(undefined);
  resolveRunningVvdSerial.mockResolvedValue(SERIAL);
  listVegaDevices.mockResolvedValue([
    { platform: "vega", kind: "vvd", state: "running", serial: SERIAL, vvdImage: "tv" },
  ]);
});

describe("boot-device — Vega VVD path", () => {
  it("boots a stopped VVD: resolves the image, starts that image via -p, waits, returns the serial", async () => {
    isVvdRunning.mockResolvedValue(false);

    const result = await createBootDeviceTool(registry).execute!({}, { vvdImage: "tv" });

    expect(ensureDep).toHaveBeenCalledWith("vega");
    expect(startVvd).toHaveBeenCalledWith({ timeoutSeconds: 120, imagePath: "/sdk/vvd/images/tv" });
    expect(waitForVvdRunning).toHaveBeenCalled();
    expect(result).toEqual({ platform: "vega", serial: SERIAL, vvdImage: "tv", booted: true });
  });

  it("returns the serial without restarting when the requested image is already running", async () => {
    isVvdRunning.mockResolvedValue(true);

    const result = await createBootDeviceTool(registry).execute!({}, { vvdImage: "tv" });

    expect(startVvd).not.toHaveBeenCalled();
    expect(stopVvd).not.toHaveBeenCalled();
    expect((result as { serial: string }).serial).toBe(SERIAL);
  });

  it("rejects a non-force boot of a different image while another VVD is running", async () => {
    isVvdRunning.mockResolvedValue(true);
    listVvdImages.mockResolvedValue([
      { name: "tv", path: "/sdk/vvd/images/tv" },
      { name: "tablet", path: "/sdk/vvd/images/tablet" },
    ]);
    listVegaDevices.mockResolvedValue([
      { platform: "vega", kind: "vvd", state: "running", serial: SERIAL, vvdImage: "tv" },
    ]);

    await expect(
      createBootDeviceTool(registry).execute!({}, { vvdImage: "tablet" })
    ).rejects.toThrow(/already running.*force:true/s);
    expect(startVvd).not.toHaveBeenCalled();
  });

  it("rejects a non-force boot when the running VVD's image cannot be confirmed (vvdImage: null)", async () => {
    isVvdRunning.mockResolvedValue(true);
    listVvdImages.mockResolvedValue([
      { name: "tv", path: "/sdk/vvd/images/tv" },
      { name: "tablet", path: "/sdk/vvd/images/tablet" },
    ]);
    // A VVD is running but its image could not be resolved (profile mismatch with
    // 2+ images, or 2+ running VVDs). An unconfirmable running image must be treated
    // as a mismatch — NOT silently reported as a successful boot of the requested
    // image while a different VVD is actually running.
    listVegaDevices.mockResolvedValue([
      { platform: "vega", kind: "vvd", state: "running", serial: SERIAL, vvdImage: null },
    ]);

    await expect(
      createBootDeviceTool(registry).execute!({}, { vvdImage: "tablet" })
    ).rejects.toThrow(/already running/i);
    expect(startVvd).not.toHaveBeenCalled();
  });

  it("force-restarts a running VVD (stop then start)", async () => {
    isVvdRunning.mockResolvedValue(true);

    await createBootDeviceTool(registry).execute!({}, { vvdImage: "tv", force: true });

    expect(stopVvd).toHaveBeenCalled();
    expect(startVvd).toHaveBeenCalled();
  });

  it("throws a helpful error listing available images for an unknown image", async () => {
    isVvdRunning.mockResolvedValue(false);
    listVvdImages.mockResolvedValue([{ name: "tv", path: "/sdk/vvd/images/tv" }]);

    await expect(
      createBootDeviceTool(registry).execute!({}, { vvdImage: "phone" })
    ).rejects.toThrow(/not found.*Available: tv/s);
    expect(startVvd).not.toHaveBeenCalled();
  });

  it("rejects more than one platform selector", async () => {
    await expect(
      createBootDeviceTool(registry).execute!({}, { vvdImage: "tv", udid: "x" })
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects when no platform selector is given", async () => {
    await expect(createBootDeviceTool(registry).execute!({}, {})).rejects.toThrow(/exactly one/);
  });
});
