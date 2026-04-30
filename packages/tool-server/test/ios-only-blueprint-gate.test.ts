import { describe, it, expect, vi } from "vitest";

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

describe("iOS-only blueprints reject Android targets up-front", () => {
  // Agents see both iOS and Android targets in list-devices. Feeding an Android
  // serial to a tool backed by an iOS-only blueprint (native-devtools,
  // native-profiler-session) used to resolve the service, fail deep in
  // launchctl / xctrace / socket connect, and surface as an opaque error.
  // These gates turn that into a clear "iOS-only, pick an iOS udid" message
  // at the blueprint boundary.

  it("native-devtools blueprint rejects an Android serial with a targeted error", async () => {
    await expect(nativeDevtoolsBlueprint.factory({}, "emulator-5554")).rejects.toThrow(
      /NativeDevtools is iOS-only.*Android/
    );
  });

  it("native-profiler-session blueprint rejects an Android serial with a targeted error", async () => {
    await expect(nativeProfilerSessionBlueprint.factory({}, "emulator-5556")).rejects.toThrow(
      /NativeProfilerSession currently supports iOS only.*Android/
    );
  });

  it("native-devtools blueprint does NOT gate an iOS-classified udid (gate is one-sided)", async () => {
    // Proof-of-gate: if the classification is iOS we should pass the
    // `classifyDevice(...) !== "ios"` check. Whether the rest of the factory
    // resolves or rejects depends on socket state which this test doesn't
    // control — the invariant we care about is that the failure mode is
    // never the iOS-only gate message for an iOS target.
    let threwGateError = false;
    try {
      const instance = await nativeDevtoolsBlueprint.factory(
        {},
        "11111111-2222-3333-4444-555555555555"
      );
      // If the factory resolves, dispose it so we don't leak the socket watcher.
      await instance.dispose();
    } catch (e) {
      if (e instanceof Error && /NativeDevtools is iOS-only/.test(e.message)) {
        threwGateError = true;
      }
    }
    expect(threwGateError).toBe(false);
  });
});
