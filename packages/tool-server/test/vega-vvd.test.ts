import { describe, it, expect, vi, beforeEach } from "vitest";

// The running VVD's console port comes from the process table; mock that source.
const listRunningVvdConsolePorts = vi.fn();
vi.mock("../src/utils/vega-process", () => ({
  listRunningVvdConsolePorts: (...a: unknown[]) => listRunningVvdConsolePorts(...a),
}));

// discoverVegaConsolePort also confirms the VVD's `emulator-<port>` is adb-ready;
// mock the `adb devices` call but keep the real parser.
const runAdb = vi.fn();
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return { ...actual, runAdb: (...a: unknown[]) => runAdb(...a) };
});

import { discoverVegaConsolePort, MultipleVegaDevicesError } from "../src/utils/vega-vvd";

function adbDevices(...serials: string[]): { stdout: string; stderr: string } {
  return {
    stdout: ["List of devices attached", ...serials.map((s) => `${s}\tdevice`)].join("\n") + "\n",
    stderr: "",
  };
}

beforeEach(() => {
  listRunningVvdConsolePorts.mockReset();
  runAdb.mockReset();
  runAdb.mockResolvedValue(adbDevices("emulator-5556")); // adb-ready by default
});

describe("discoverVegaConsolePort", () => {
  it("returns the sole running VVD's console port once it is adb-ready", async () => {
    listRunningVvdConsolePorts.mockResolvedValue(new Set([5556]));
    expect(await discoverVegaConsolePort()).toBe(5556);
  });

  it("throws an actionable error when no VVD process is running", async () => {
    listRunningVvdConsolePorts.mockResolvedValue(new Set());
    await expect(discoverVegaConsolePort()).rejects.toThrow(/No running Vega Virtual Device/);
  });

  it("throws a typed MultipleVegaDevicesError when more than one VVD is running", async () => {
    listRunningVvdConsolePorts.mockResolvedValue(new Set([5554, 5556]));
    await expect(discoverVegaConsolePort()).rejects.toBeInstanceOf(MultipleVegaDevicesError);
    await expect(discoverVegaConsolePort()).rejects.toThrow(
      /Multiple Vega Virtual Devices detected/
    );
  });

  it("waits for adb and throws a clear error if the VVD's emulator never registers", async () => {
    listRunningVvdConsolePorts.mockResolvedValue(new Set([5556]));
    runAdb.mockResolvedValue(adbDevices()); // emulator-5556 absent from `adb devices`
    await expect(discoverVegaConsolePort({ adbReadyTimeoutMs: 0 })).rejects.toThrow(
      /has not registered with adb/
    );
  });
});
