import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression cover for the "adb-connected VVD" bug: once a 2nd adb transport is
// added (`adb connect 127.0.0.1:<port+1>`), `vega device list` switches to adb-form
// rows that parseVegaDeviceList skips. The process table (ps) stays authoritative,
// so isVvdRunning() and listVegaDevices() must recover the running VVD from it.
// Mock the subprocess boundary to drive that exact state deterministically.
const listRunningVvdConsolePorts = vi.fn();
vi.mock("../src/utils/vega-process", () => ({
  listRunningVvdConsolePorts: (...a: unknown[]) => listRunningVvdConsolePorts(...a),
}));

const runVega = vi.fn();
const runVegaDevice = vi.fn();
const resolveVegaBinary = vi.fn();
vi.mock("../src/utils/vega-cli", () => ({
  runVega: (...a: unknown[]) => runVega(...a),
  runVegaDevice: (...a: unknown[]) => runVegaDevice(...a),
  resolveVegaBinary: (...a: unknown[]) => resolveVegaBinary(...a),
}));

const listVvdImages = vi.fn();
vi.mock("../src/utils/vega-sdk", () => ({
  listVvdImages: (...a: unknown[]) => listVvdImages(...a),
}));

import { listVegaDevices } from "../src/utils/vega-devices";
import { isVvdRunning } from "../src/utils/vega-vvd";

// Real outputs captured from a live VVD (amazon-3ef2badfb9a39e0b).
const ADB_FORM_LIST =
  "Found the following devices:\n127.0.0.1:5555 : AN4ZFZ17D377Y\nemulator-5554 : AN4ZFZ17D377Y\n";
const DEVICE_TYPE_LIST =
  "Found the following device:\nVirtualDevice : tv - aarch64 - OS - amazon-3ef2badfb9a39e0b\n";
const INFO_JSON = JSON.stringify({
  idme: "AN4ZFZ17D377Y",
  hostname: "amazon-3ef2badfb9a39e0b",
  profile: "tv",
  product: "vvrp-tv-arm64",
  buildDescription: "OS 1.1",
  simulated: true,
});

beforeEach(() => {
  listRunningVvdConsolePorts.mockReset();
  runVega.mockReset();
  runVegaDevice.mockReset();
  resolveVegaBinary.mockReset().mockResolvedValue("/x/vega/bin/vega");
  listVvdImages.mockReset().mockResolvedValue([{ name: "tv", path: "/x/tv" }]);
  // `device info` is pinned to the VVD via -d, so it returns real data even adb-connected.
  runVegaDevice.mockResolvedValue({ stdout: INFO_JSON, stderr: "" });
});

describe("isVvdRunning() uses the process table, not `vega device list`", () => {
  it("true when a VVD process is running (survives the adb-form list)", async () => {
    listRunningVvdConsolePorts.mockResolvedValue(new Set([5554]));
    expect(await isVvdRunning()).toBe(true);
  });
  it("false when no VVD process is running", async () => {
    listRunningVvdConsolePorts.mockResolvedValue(new Set());
    expect(await isVvdRunning()).toBe(false);
  });
});

describe("listVegaDevices() recovers the running VVD when adb-connected", () => {
  it("adb-form list + running ps → one running vvd, no phantom stopped row", async () => {
    runVega.mockResolvedValue({ stdout: ADB_FORM_LIST, stderr: "" });
    listRunningVvdConsolePorts.mockResolvedValue(new Set([5554]));
    const devices = await listVegaDevices();
    const running = devices.filter((d) => d.kind === "vvd" && d.state === "running");
    expect(running).toHaveLength(1);
    expect(running[0]!.serial).toBe("amazon-3ef2badfb9a39e0b");
    expect(running[0]!.vvdImage).toBe("tv");
    // the running image must NOT also appear as a stopped row, and the VVD's adb
    // shadows must not surface as Android (no vega entry claims serial null here):
    expect(devices.some((d) => d.state === "stopped" && d.vvdImage === "tv")).toBe(false);
  });

  it("no regression: normal device-type list still yields the running VVD", async () => {
    runVega.mockResolvedValue({ stdout: DEVICE_TYPE_LIST, stderr: "" });
    listRunningVvdConsolePorts.mockResolvedValue(new Set([5554]));
    const devices = await listVegaDevices();
    const running = devices.filter((d) => d.kind === "vvd" && d.state === "running");
    expect(running).toHaveLength(1);
    expect(running[0]!.serial).toBe("amazon-3ef2badfb9a39e0b");
    expect(running[0]!.vvdImage).toBe("tv");
  });

  it("no VVD running: adb-form list + empty ps → only the stopped image (no false running row)", async () => {
    runVega.mockResolvedValue({ stdout: ADB_FORM_LIST, stderr: "" });
    listRunningVvdConsolePorts.mockResolvedValue(new Set());
    const devices = await listVegaDevices();
    expect(devices.filter((d) => d.state === "running")).toHaveLength(0);
    expect(devices.some((d) => d.state === "stopped" && d.vvdImage === "tv")).toBe(true);
  });
});
