import { describe, it, expect } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { simulatorServerBlueprint } from "../../src/blueprints/simulator-server";

// Regression: a missing `udid` reaching the factory used to spawn `--id
// undefined`, then throw `udid.slice` inside an async stderr listener →
// uncaughtException → tool-server crash. Reachable via wrappers that don't
// re-validate the inner tool's schema (e.g. flow-add-step).
describe("simulator-server blueprint — input validation", () => {
  it("rejects when options.device is missing", async () => {
    await expect(simulatorServerBlueprint.factory({}, "ignored")).rejects.toThrow(
      /requires a resolved DeviceInfo via options\.device/
    );
  });

  it("rejects when device.id is undefined", async () => {
    const device = { id: undefined, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(simulatorServerBlueprint.factory({}, "ignored", { device })).rejects.toThrow(
      /requires a non-empty device\.id/
    );
  });

  it("rejects when device.id is an empty string", async () => {
    const device: DeviceInfo = { id: "", platform: "ios", kind: "simulator" };
    await expect(simulatorServerBlueprint.factory({}, "ignored", { device })).rejects.toThrow(
      /requires a non-empty device\.id/
    );
  });

  it("rejects when device.id is a non-string value", async () => {
    const device = { id: 42, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(simulatorServerBlueprint.factory({}, "ignored", { device })).rejects.toThrow(
      /requires a non-empty device\.id/
    );
  });
});
