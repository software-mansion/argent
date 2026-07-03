import { describe, it, expect, vi, beforeEach } from "vitest";
import { FailureError, FAILURE_CODES } from "@argent/registry";

// Build a `runVega` rejection shaped like the real one: runVega wraps failures in a
// FailureError whose signal.error_kind distinguishes a `timeout` (wedged agent) from
// an ordinary `subprocess` failure. listVegaDevices keys its no-recovery decision off
// that, so the tests must reject with the right kind rather than a bare Error.
function vegaFailure(kind: "timeout" | "subprocess"): FailureError {
  return new FailureError(`vega device list ${kind}`, {
    error_code: FAILURE_CODES.VEGA_CLI_COMMAND_FAILED,
    failure_stage: "vega_cli_command",
    failure_area: "tool_server",
    error_kind: kind,
  });
}

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

  it("no stacking: a *timed-out* `device list` does not trigger a second `device info` call", async () => {
    // The root cause of the `list-devices` "hang": against a wedged device agent
    // `device list` times out, and the old code fell through to the `device info`
    // recovery — a second 20s hang back-to-back (~40s total). The recovery is now
    // skipped specifically on a timeout, so a wedged agent does NOT pay for a second
    // hanging call even though a VVD is running.
    runVega.mockRejectedValue(vegaFailure("timeout"));
    listRunningVvdConsolePorts.mockResolvedValue(new Set([5554])); // a VVD IS running
    const devices = await listVegaDevices();
    expect(runVegaDevice).not.toHaveBeenCalled();
    // It still degrades gracefully to the installed image rather than hanging.
    expect(devices.some((d) => d.state === "stopped" && d.vvdImage === "tv")).toBe(true);
  });

  it("a *fast* (non-timeout) `device list` failure still recovers a running VVD", async () => {
    // A transient CLI error is NOT a wedged agent: `device info` would still answer,
    // so recovery must run — otherwise a genuinely-running VVD is mis-reported as
    // stopped. This is the case the timeout-only gate preserves (a blanket
    // "any failure → no recovery" gate would regress it).
    runVega.mockRejectedValue(vegaFailure("subprocess"));
    listRunningVvdConsolePorts.mockResolvedValue(new Set([5554])); // a VVD IS running
    const devices = await listVegaDevices();
    expect(runVegaDevice).toHaveBeenCalled(); // recovery via `device info` fired
    const running = devices.filter((d) => d.kind === "vvd" && d.state === "running");
    expect(running).toHaveLength(1);
    expect(running[0]!.serial).toBe("amazon-3ef2badfb9a39e0b");
    expect(devices.some((d) => d.state === "stopped" && d.vvdImage === "tv")).toBe(false);
  });
});
