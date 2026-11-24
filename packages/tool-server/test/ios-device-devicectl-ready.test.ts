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

describe("ensureDeviceReady selects a usable runner route", () => {
  it.each([undefined, "::1", "fe80::1", "2001:db8::1", "192.168.1.2", "fdzz::1"])(
    "rejects a network tunnel with unusable address %s",
    async (address) => {
      fake.connectionProperties = { transportType: "localNetwork", tunnelState: "connected" };
      if (address) fake.connectionProperties.tunnelIPAddress = address;
      const error = await ensureDeviceReady("network").catch((caught: unknown) => caught);
      expect((error as Error).message).toContain("no connected CoreDevice IPv6 tunnel");
      expect(getFailureSignal(error)).toMatchObject({
        error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
        failure_stage: "ios_device_ready",
        error_kind: "network",
      });
    }
  );

  it("reads the current route after a USB disconnect or tunnel reconnect", async () => {
    fake.connectionProperties = { transportType: "wired", tunnelState: "connected" };
    await expect(ensureDeviceReady("changing")).resolves.toBeNull();
    fake.connectionProperties = {
      transportType: "localNetwork",
      tunnelState: "connected",
      tunnelIPAddress: "fd12::1",
    };
    await expect(ensureDeviceReady("changing")).resolves.toBe("fd12::1");
    fake.connectionProperties.tunnelIPAddress = "fd34::1";
    await expect(ensureDeviceReady("changing")).resolves.toBe("fd34::1");
    fake.connectionProperties.tunnelState = "connecting";
    await expect(ensureDeviceReady("changing")).rejects.toThrow("no connected CoreDevice");
  });

  it("rejects a wired device whose CoreDevice tunnel is still connecting", async () => {
    fake.connectionProperties = { transportType: "wired", tunnelState: "connecting" };
    await expect(ensureDeviceReady("wired-connecting")).rejects.toThrow(
      "tunnel is still connecting"
    );
  });

  it("retains USB for older toolchains that omit transportType", async () => {
    fake.connectionProperties = { tunnelState: "connected" };
    await expect(ensureDeviceReady("legacy")).resolves.toBeNull();
  });
});
