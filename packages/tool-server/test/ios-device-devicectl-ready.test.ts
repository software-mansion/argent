import { describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import { ensureDeviceReady } from "../src/utils/ios-device/devicectl";

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
describe("ensureDeviceReady gates on the cable, not just the tunnel", () => {
  it("rejects an unplugged device even while its tunnel reports connected", async () => {
    // Live-verified shape for a paired iPhone with the cable pulled: CoreDevice
    // still reaches it, so only transportType tells the two apart.
    fake.connectionProperties = { transportType: "localNetwork", tunnelState: "connected" };

    const error = await ensureDeviceReady("00008110-000000000000001E").catch(
      (caught: unknown) => caught
    );

    expect((error as Error).name).toBe("IosDeviceControlError");
    expect((error as Error).message).toBe(
      "Device transport is localNetwork, not wired. " +
        "Hint: Connect the device by USB cable and unlock it, then retry."
    );
    // The verdict bypasses runDevicectl's stamp (devicectl itself succeeded),
    // so it carries its own: the registry must not file a pulled cable as
    // unclassified.
    const signal = getFailureSignal(error);
    expect(signal?.error_code).toBe(FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED);
    expect(signal?.failure_stage).toBe("ios_device_ready");
    expect(signal?.error_kind).toBe("not_found");
    expect(signal?.failure_command).toBe("devicectl");
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
  });

  it("accepts a device whose payload omits transportType (older toolchains)", async () => {
    fake.connectionProperties = { tunnelState: "connected" };

    await expect(ensureDeviceReady("00008110-000000000000003E")).resolves.toBeUndefined();
  });
});
