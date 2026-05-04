import { describe, it, expect } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { axServiceBlueprint } from "../../src/blueprints/ax-service";

// Regression: same crash class as simulator-server. A missing udid would
// throw `getSocketPath(undefined).slice` synchronously and `udid.slice` in
// the stderr listener fatally. The id-shape check sits *after* the apple-
// only check so an Android caller still gets the clearer iOS-only error.
describe("ax-service blueprint — input validation", () => {
  it("rejects when options.device is missing", async () => {
    await expect(axServiceBlueprint.factory({}, "ignored")).rejects.toThrow(
      /requires a resolved DeviceInfo via options\.device/
    );
  });

  it("rejects an Android device with the iOS-only diagnostic before id-shape check", async () => {
    const device: DeviceInfo = { id: "emulator-5554", platform: "android", kind: "emulator" };
    await expect(axServiceBlueprint.factory({}, "ignored", { device })).rejects.toThrow(/iOS-only/);
  });

  it("rejects when device.id is undefined", async () => {
    const device = { id: undefined, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(axServiceBlueprint.factory({}, "ignored", { device })).rejects.toThrow(
      /requires a non-empty device\.id/
    );
  });

  it("rejects when device.id is an empty string", async () => {
    const device: DeviceInfo = { id: "", platform: "ios", kind: "simulator" };
    await expect(axServiceBlueprint.factory({}, "ignored", { device })).rejects.toThrow(
      /requires a non-empty device\.id/
    );
  });

  it("rejects when device.id is a non-string value", async () => {
    const device = { id: 42, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(axServiceBlueprint.factory({}, "ignored", { device })).rejects.toThrow(
      /requires a non-empty device\.id/
    );
  });
});
