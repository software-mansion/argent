import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { ensureDeviceReady } from "../src/utils/ios-device/devicectl";
import { isUsbmuxDeviceAvailable } from "../src/utils/ios-device/usbmux";

vi.mock("../src/utils/ios-device/usbmux", () => ({
  isUsbmuxDeviceAvailable: vi.fn(async () => false),
}));

const fake = vi.hoisted(() => ({ connectionProperties: {} as Record<string, string> }));

// devicectl promisifies execFile at module load, so the mock must replace the
// callback-style function itself (same idiom as ios-device-devicectl-list).
// `device info details` writes its payload to the --json-output tmp file named
// in argv, never to stdout.
vi.mock("node:child_process", async () => {
  const { writeFileSync } = await import("node:fs");
  return {
    execFile: (_file: unknown, args: unknown, _options: unknown, callback: unknown) => {
      const argv = args as string[];
      writeFileSync(
        argv[argv.indexOf("--json-output") + 1]!,
        JSON.stringify({ result: { connectionProperties: fake.connectionProperties } })
      );
      (callback as (error: null, result: { stdout: string; stderr: string }) => void)(null, {
        stdout: "",
        stderr: "",
      });
    },
  };
});

// ensureDeviceReady memoizes readiness for 5s per udid, so each case needs its
// own udid to actually run the probe.
beforeEach(() => {
  vi.mocked(isUsbmuxDeviceAvailable).mockReset().mockResolvedValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe("ensureDeviceReady requires wired transport or a live usbmux entry", () => {
  it("rejects an unplugged device even while its tunnel reports connected", async () => {
    // A connected CoreDevice tunnel alone is not evidence of usbmux availability.
    fake.connectionProperties = { transportType: "localNetwork", tunnelState: "connected" };

    const error = await ensureDeviceReady("00008110-000000000000001E").catch(
      (caught: unknown) => caught
    );

    expect((error as Error).name).toBe("IosDeviceControlError");
    expect((error as Error).message).toBe(
      "Device is not available through a supported usbmux connection (transport: localNetwork). " +
        "Hint: Connect the device by USB cable or restore its forwarded USB connection, unlock it, then retry."
    );
    // The verdict bypasses runDevicectl's stamp (devicectl itself succeeded),
    // so it carries its own: the registry must not file a pulled cable as
    // unclassified.
    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED);
    expect(signal?.failure_stage).toBe("ios_device_ready");
    expect(signal?.error_kind).toBe("not_found");
    expect(signal?.failure_command).toBe("devicectl");
    expect(isUsbmuxDeviceAvailable).toHaveBeenCalledWith("00008110-000000000000001E");
  });

  it("rejects a wired device whose CoreDevice tunnel is still connecting", async () => {
    fake.connectionProperties = { transportType: "wired", tunnelState: "connecting" };

    const error = await ensureDeviceReady("00008110-000000000000004E").catch(
      (caught: unknown) => caught
    );

    expect((error as Error).name).toBe("IosDeviceControlError");
    expect((error as Error).message).toBe(
      "Device tunnel is still connecting. " +
        "Hint: Keep the device unlocked and connected; retry in a few seconds."
    );
    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED);
    expect(signal?.failure_stage).toBe("ios_device_ready");
    expect(signal?.error_kind).toBe("network");
  });

  it("accepts a wired device with a settled tunnel", async () => {
    fake.connectionProperties = { transportType: "wired", tunnelState: "connected" };

    await expect(ensureDeviceReady("00008110-000000000000002E")).resolves.toBeUndefined();
    expect(isUsbmuxDeviceAvailable).not.toHaveBeenCalled();
  });

  it("accepts a device whose payload omits transportType (older toolchains)", async () => {
    fake.connectionProperties = { tunnelState: "connected" };

    await expect(ensureDeviceReady("00008110-000000000000003E")).resolves.toBeUndefined();
    expect(isUsbmuxDeviceAvailable).not.toHaveBeenCalled();
  });

  it("accepts forwarded USB when CoreDevice reports localNetwork", async () => {
    fake.connectionProperties = { transportType: "localNetwork", tunnelState: "connected" };
    vi.mocked(isUsbmuxDeviceAvailable).mockResolvedValue(true);

    await expect(ensureDeviceReady("00008110-000000000000005E")).resolves.toBeUndefined();
    expect(isUsbmuxDeviceAvailable).toHaveBeenCalledWith("00008110-000000000000005E");
  });

  it("still rejects a connecting tunnel when usbmux can see the device", async () => {
    fake.connectionProperties = { transportType: "localNetwork", tunnelState: "connecting" };
    vi.mocked(isUsbmuxDeviceAvailable).mockResolvedValue(true);

    await expect(ensureDeviceReady("00008110-000000000000006E")).rejects.toThrow(
      "Device tunnel is still connecting"
    );
  });

  it("rejects an unknown transport without probing usbmux", async () => {
    fake.connectionProperties = { transportType: "unknown", tunnelState: "connected" };
    vi.mocked(isUsbmuxDeviceAvailable).mockResolvedValue(true);

    await expect(ensureDeviceReady("00008110-000000000000007E")).rejects.toThrow(
      "transport: unknown"
    );
    expect(isUsbmuxDeviceAvailable).not.toHaveBeenCalled();
  });

  it("rejects a detached forwarded USB device after the readiness memo expires", async () => {
    fake.connectionProperties = { transportType: "localNetwork", tunnelState: "connected" };
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    vi.mocked(isUsbmuxDeviceAvailable).mockResolvedValue(true);
    const udid = "00008110-000000000000008E";

    await ensureDeviceReady(udid);
    vi.mocked(isUsbmuxDeviceAvailable).mockResolvedValue(false);
    now.mockReturnValue(15_001);

    await expect(ensureDeviceReady(udid)).rejects.toThrow("not available");
    expect(isUsbmuxDeviceAvailable).toHaveBeenCalledTimes(2);
  });
});
