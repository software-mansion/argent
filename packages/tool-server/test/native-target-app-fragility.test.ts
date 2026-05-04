import { describe, it, expect } from "vitest";
import { inspectConnectedNativeApps, resolveNativeTargetApp } from "../src/utils/native-target-app";
import type { NativeAppState, NativeDevtoolsApi } from "../src/blueprints/native-devtools";

function appState(bundleId: string, overrides: Partial<NativeAppState> = {}): NativeAppState {
  return {
    bundleId,
    applicationState: "background",
    foregroundActiveSceneCount: 0,
    foregroundInactiveSceneCount: 0,
    backgroundSceneCount: 1,
    unattachedSceneCount: 0,
    isFrontmostCandidate: false,
    ...overrides,
  };
}

/**
 * detectFrontmostBundleId in the native-devtools blueprint wraps getAppState in
 * try/catch so a single mid-tear-down app can't poison the frontmost lookup —
 * the error is filtered out and the remaining apps are considered.
 *
 * inspectConnectedNativeApps takes the simpler Promise.all path. If even one
 * connected app's getAppState rejects, the whole utility rejects and
 * resolveNativeTargetApp loses its ability to auto-target ANY app — including
 * the healthy frontmost app that the user actually wants. The describe tool's
 * outer try/catch swallows that error and silently returns an empty AX result,
 * so the agent sees "no elements" instead of the auto-target it should have
 * found.
 */
function makeApi(apps: { state: NativeAppState; throwOnGetState?: boolean }[]): NativeDevtoolsApi {
  const byId = new Map(apps.map((a) => [a.state.bundleId, a]));
  return {
    isEnvSetup: () => true,
    socketPath: "/tmp/test.sock",
    ensureEnvReady: async () => {},
    isConnected: (bundleId) => byId.has(bundleId),
    isAppRunning: async () => true,
    listConnectedBundleIds: () => [...byId.keys()],
    requiresAppRestart: async () => false,
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async (bundleId) => {
      const entry = byId.get(bundleId);
      if (!entry) throw new Error(`unknown bundleId: ${bundleId}`);
      if (entry.throwOnGetState) {
        throw new Error(`mid-tear-down: ${bundleId}`);
      }
      return entry.state;
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => ({}),
  };
}

describe("inspectConnectedNativeApps — robustness when one app's getAppState fails", () => {
  it("does not let a single failing app poison the auto-target lookup for the others", async () => {
    // Setup: one app is mid-tear-down (its getAppState rejects), the other is
    // a healthy unique frontmost candidate. resolveNativeTargetApp SHOULD pick
    // the healthy one — that is exactly the scenario detectFrontmostBundleId
    // already handles.
    const api = makeApi([
      { state: appState("com.healthy", { applicationState: "active" }) },
      { state: appState("com.dying"), throwOnGetState: true },
    ]);

    await expect(resolveNativeTargetApp(api)).resolves.toEqual({
      bundleId: "com.healthy",
      source: "frontmost_detected",
    });
  });

  it("returns the surviving apps when one bundle's getAppState rejects", async () => {
    const api = makeApi([
      { state: appState("com.alive") },
      { state: appState("com.dying"), throwOnGetState: true },
    ]);

    const apps = await inspectConnectedNativeApps(api);
    expect(apps.map((a) => a.bundleId)).toEqual(["com.alive"]);
  });
});
