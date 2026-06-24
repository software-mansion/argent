import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The running VVD's console port / pids come from the process table; mock that source.
const listRunningVvdConsolePorts = vi.fn();
const listRunningVvdPids = vi.fn();
vi.mock("../src/utils/vega-process", () => ({
  listRunningVvdConsolePorts: (...a: unknown[]) => listRunningVvdConsolePorts(...a),
  listRunningVvdPids: (...a: unknown[]) => listRunningVvdPids(...a),
}));

// stopVvd asks the CLI to stop first; mock it so we can make it succeed or throw.
const runVega = vi.fn();
vi.mock("../src/utils/vega-cli", () => ({
  runVega: (...a: unknown[]) => runVega(...a),
}));

// discoverVegaConsolePort also confirms the VVD's `emulator-<port>` is adb-ready;
// mock the `adb devices` call but keep the real parser.
const runAdb = vi.fn();
vi.mock("../src/utils/adb", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/adb")>("../src/utils/adb");
  return { ...actual, runAdb: (...a: unknown[]) => runAdb(...a) };
});

import { discoverVegaConsolePort, MultipleVegaDevicesError, stopVvd } from "../src/utils/vega-vvd";

function adbDevices(...serials: string[]): { stdout: string; stderr: string } {
  return {
    stdout: ["List of devices attached", ...serials.map((s) => `${s}\tdevice`)].join("\n") + "\n",
    stderr: "",
  };
}

beforeEach(() => {
  listRunningVvdConsolePorts.mockReset();
  listRunningVvdPids.mockReset();
  runVega.mockReset();
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

describe("stopVvd", () => {
  let kill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Don't actually signal real processes from the test runner.
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });
  afterEach(() => kill.mockRestore());

  it("does not signal anything when the CLI stop succeeds and no VVD process remains", async () => {
    runVega.mockResolvedValue({ stdout: "", stderr: "" });
    listRunningVvdPids.mockResolvedValue([]);
    await stopVvd();
    expect(runVega).toHaveBeenCalledWith(
      ["virtual-device", "stop"],
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills a VVD the CLI refused to stop, and does not rethrow the CLI failure", async () => {
    // The CLI exits non-zero ("virtual device not running") for a VVD it lost track of.
    runVega.mockRejectedValue(
      new Error("vega virtual-device stop failed: virtual device not running")
    );
    listRunningVvdPids.mockResolvedValue([75137]);
    listRunningVvdConsolePorts.mockResolvedValue(new Set()); // isVvdRunning → gone after SIGTERM
    await expect(stopVvd({ killGraceMs: 50, verifyPollMs: 5 })).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith(75137, "SIGTERM");
    expect(kill).not.toHaveBeenCalledWith(75137, "SIGKILL");
  });

  it("escalates to SIGKILL when SIGTERM leaves the VVD running", async () => {
    runVega.mockResolvedValue({ stdout: "", stderr: "" });
    listRunningVvdPids.mockResolvedValue([75137]);
    listRunningVvdConsolePorts.mockResolvedValue(new Set([5554])); // still running through the grace window
    await stopVvd({ killGraceMs: 20, verifyPollMs: 5 });
    expect(kill).toHaveBeenCalledWith(75137, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(75137, "SIGKILL");
  });
});
