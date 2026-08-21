import { describe, it, expect } from "vitest";
import { FAILURE_CODES, getFailureSignal, type DeviceInfo } from "@argent/registry";
import { axServiceBlueprint } from "../../src/blueprints/ax-service";

// Regression: same crash class as simulator-server. A missing udid would
// throw `getSocketPath(undefined).slice` synchronously and `udid.slice` in
// the stderr listener fatally. The id-shape check sits *after* the apple-
// only check so an Android caller still gets the clearer iOS-only error.
describe("ax-service blueprint — input validation", () => {
  it("rejects when options.device is missing", async () => {
    await expect(
      axServiceBlueprint.factory({}, "ignored" as unknown as DeviceInfo)
    ).rejects.toThrow(/requires a resolved DeviceInfo via options\.device/);
  });

  it("rejects an Android device with the iOS-only diagnostic before id-shape check", async () => {
    const device: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
    await expect(
      axServiceBlueprint.factory({}, "ignored" as unknown as DeviceInfo, { device })
    ).rejects.toThrow(/iOS-only/);
  });

  it("rejects a physical iPhone before it can spawn simctl inside a hardware udid", async () => {
    // The capability gate covers the tools; this covers direct resolution of
    // the service itself, which no tool capability sits in front of. Without
    // it, `simctl spawn <ECID-udid>` runs and the caller gets a deep 500
    // instead of a pointer to describe, which reads a physical iPhone's tree
    // over CoreDevice.
    const device: DeviceInfo = { id: "00008120-000E6D0C0ABBA01E", platform: "ios", kind: "device" };
    const err = await axServiceBlueprint
      .factory({}, "ignored" as unknown as DeviceInfo, { device })
      .catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.AX_PHYSICAL_DEVICE_UNSUPPORTED);
    expect((err as Error).message).toMatch(/use describe/);
  });

  it("still builds for a simulator, so the physical guard is kind-shaped", async () => {
    const device: DeviceInfo = {
      id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
      platform: "ios",
      kind: "simulator",
    };
    const err = await axServiceBlueprint
      .factory({}, "ignored" as unknown as DeviceInfo, { device })
      .catch((e: unknown) => e);
    expect(getFailureSignal(err)?.error_code).not.toBe(
      FAILURE_CODES.AX_PHYSICAL_DEVICE_UNSUPPORTED
    );
  });

  it("rejects when device.id is undefined", async () => {
    const device = { id: undefined, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(
      axServiceBlueprint.factory({}, "ignored" as unknown as DeviceInfo, { device })
    ).rejects.toThrow(/requires a non-empty device\.id/);
  });

  it("rejects when device.id is an empty string", async () => {
    const device: DeviceInfo = { id: "", platform: "ios", kind: "simulator" };
    await expect(
      axServiceBlueprint.factory({}, "ignored" as unknown as DeviceInfo, { device })
    ).rejects.toThrow(/requires a non-empty device\.id/);
  });

  it("rejects when device.id is a non-string value", async () => {
    const device = { id: 42, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(
      axServiceBlueprint.factory({}, "ignored" as unknown as DeviceInfo, { device })
    ).rejects.toThrow(/requires a non-empty device\.id/);
  });
});
