import { describe, it, expect, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";
import { simulatorServerBlueprint } from "../../src/blueprints/simulator-server";
import { isTvOsSimulator } from "../../src/utils/ios-devices";
import { UnsupportedOperationError } from "../../src/utils/capability";

// The factory probes the runtime kind to reject tvOS sims (simulator-server
// can't drive the Apple TV focus engine; its fire-and-forget transport would
// silently no-op a touch/key and the tool would still report success). Mock so
// the test stays hermetic and defaults to the iOS path; the tvOS case overrides.
vi.mock("../../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
}));
const mockIsTvOsSimulator = vi.mocked(isTvOsSimulator);

// Regression: a missing `udid` reaching the factory used to spawn `--id
// undefined`, then throw `udid.slice` inside an async stderr listener →
// uncaughtException → tool-server crash. Reachable via wrappers that don't
// re-validate the inner tool's schema (e.g. flow-add-step).
describe("simulator-server blueprint — input validation", () => {
  it("rejects when options.device is missing", async () => {
    await expect(
      simulatorServerBlueprint.factory({}, "ignored" as unknown as DeviceInfo)
    ).rejects.toThrow(/requires a resolved DeviceInfo via options\.device/);
  });

  it("rejects when device.id is undefined", async () => {
    const device = { id: undefined, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(
      simulatorServerBlueprint.factory({}, "ignored" as unknown as DeviceInfo, { device })
    ).rejects.toThrow(/requires a non-empty device\.id/);
  });

  it("rejects when device.id is an empty string", async () => {
    const device: DeviceInfo = { id: "", platform: "ios", kind: "simulator" };
    await expect(
      simulatorServerBlueprint.factory({}, "ignored" as unknown as DeviceInfo, { device })
    ).rejects.toThrow(/requires a non-empty device\.id/);
  });

  it("rejects when device.id is a non-string value", async () => {
    const device = { id: 42, platform: "ios", kind: "simulator" } as unknown as DeviceInfo;
    await expect(
      simulatorServerBlueprint.factory({}, "ignored" as unknown as DeviceInfo, { device })
    ).rejects.toThrow(/requires a non-empty device\.id/);
  });

  // Regression: gesture/keyboard/paste/rotate tools all resolve this service
  // for an iOS-shaped udid, but a tvOS sim has no touchscreen — simulator-server
  // accepts the command and silently no-ops, so the tool reported a misleading
  // success. The factory now rejects tvOS before spawning, pointing at the tv-*
  // tools; the HTTP layer maps UnsupportedOperationError to a clean 400.
  it("rejects a tvOS simulator with an UnsupportedOperationError pointing at the tv-* tools", async () => {
    mockIsTvOsSimulator.mockResolvedValue(true);
    const device: DeviceInfo = {
      id: "F579A1DF-1F20-4682-99C7-C98F043D0352",
      platform: "ios",
      kind: "simulator",
    };
    await expect(
      simulatorServerBlueprint.factory({}, "ignored" as unknown as DeviceInfo, { device })
    ).rejects.toThrow(UnsupportedOperationError);
    await expect(
      simulatorServerBlueprint.factory({}, "ignored" as unknown as DeviceInfo, { device })
    ).rejects.toThrow(/Apple TV|tvOS|tv-navigate/);
    mockIsTvOsSimulator.mockResolvedValue(false);
  });
});
