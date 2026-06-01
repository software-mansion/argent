import { describe, it, expect, vi } from "vitest";
import type { DeviceInfo } from "@argent/registry";

// The native-profiler and native-devtools blueprints both open real OS
// resources (sockets, processes) if we let them reach past the gate. Stub the
// heavy bits so the only behavior under test is the iOS/Android classification
// throw.
vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/bootstrap.dylib",
  simulatorServerBinaryPath: () => "/fake/sim-server",
  simulatorServerBinaryDir: () => "/fake",
}));

import { nativeDevtoolsBlueprint } from "../src/blueprints/native-devtools";
import { nativeProfilerSessionBlueprint } from "../src/blueprints/native-profiler-session";
import { axServiceBlueprint } from "../src/blueprints/ax-service";

function iosDevice(udid: string): DeviceInfo {
  return { id: udid, platform: "ios", kind: "simulator" };
}

function androidDevice(serial: string): DeviceInfo {
  return { id: serial, platform: "android", kind: "emulator" };
}

describe("iOS-only blueprints reject Android targets up-front", () => {
  // Agents see both iOS and Android targets in list-devices. Feeding an Android
  // serial to a tool backed by an iOS-only blueprint (native-devtools,
  // native-profiler-session) used to resolve the service, fail deep in
  // launchctl / xctrace / socket connect, and surface as an opaque error.
  // These gates turn that into a clear "iOS-only, pick an iOS udid" message
  // at the blueprint boundary — using the caller-supplied DeviceInfo, not a
  // re-classification of the URN payload.

  it("native-devtools blueprint rejects an Android device with a targeted error", async () => {
    const device = androidDevice("emulator-5554");
    await expect(nativeDevtoolsBlueprint.factory({}, device, { device })).rejects.toThrow(
      /NativeDevtools is iOS-only.*Android/
    );
  });

  it("native-profiler-session blueprint rejects an Android device with a targeted error", async () => {
    const device = androidDevice("emulator-5556");
    await expect(nativeProfilerSessionBlueprint.factory({}, device, { device })).rejects.toThrow(
      /NativeProfilerSession currently supports iOS only.*Android/
    );
  });

  it("native-devtools blueprint does NOT gate an iOS DeviceInfo (gate is one-sided)", async () => {
    // Proof-of-gate: if the caller hands us an iOS device we pass the
    // `device.platform !== "ios"` check. Whether the rest of the factory
    // resolves or rejects depends on socket state which this test doesn't
    // control — the invariant we care about is that the failure mode is
    // never the iOS-only gate message for an iOS target.
    const device = iosDevice("11111111-2222-3333-4444-555555555555");
    let threwGateError = false;
    try {
      const instance = await nativeDevtoolsBlueprint.factory({}, device, { device });
      // If the factory resolves, dispose it so we don't leak the socket watcher.
      await instance.dispose();
    } catch (e) {
      if (e instanceof Error && /NativeDevtools is iOS-only/.test(e.message)) {
        threwGateError = true;
      }
    }
    expect(threwGateError).toBe(false);
  });

  it("native-devtools blueprint rejects when caller forgets options.device", async () => {
    // Defensive: without a DeviceInfo the factory has no way to gate on
    // platform — surface a clear error pointing at the helper rather than
    // silently defaulting.
    const stub = iosDevice("ignored");
    await expect(nativeDevtoolsBlueprint.factory({}, stub)).rejects.toThrow(
      /requires a resolved DeviceInfo via options\.device/
    );
  });

  it("native-profiler-session blueprint rejects when caller forgets options.device", async () => {
    const stub = iosDevice("ignored");
    await expect(nativeProfilerSessionBlueprint.factory({}, stub)).rejects.toThrow(
      /requires a resolved DeviceInfo via options\.device/
    );
  });

  it("ax-service blueprint rejects an Android device with a targeted error", async () => {
    const device = androidDevice("emulator-5554");
    await expect(axServiceBlueprint.factory({}, device, { device })).rejects.toThrow(
      /AXService is iOS-only.*Android.*uiautomator/
    );
  });

  it("ax-service blueprint rejects when caller forgets options.device", async () => {
    const stub = iosDevice("ignored");
    await expect(axServiceBlueprint.factory({}, stub)).rejects.toThrow(
      /requires a resolved DeviceInfo via options\.device/
    );
  });
});
