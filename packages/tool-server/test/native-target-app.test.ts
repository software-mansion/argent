import { describe, it, expect } from "vitest";
import {
  chooseFrontmostConnectedApp,
  inspectConnectedNativeApps,
  resolveNativeTargetApp,
} from "../src/utils/native-target-app";
import type { NativeAppState, NativeDevtoolsApi } from "../src/blueprints/native-devtools";

function makeAppState(bundleId: string, overrides: Partial<NativeAppState> = {}): NativeAppState {
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

function makeApi(apps: NativeAppState[]): NativeDevtoolsApi {
  const byBundleId = new Map(apps.map((app) => [app.bundleId, app]));
  return {
    isEnvSetup: () => true,
    socketPath: "/tmp/mock.sock",
    ensureEnvReady: async () => {},
    isConnected: (bundleId) => byBundleId.has(bundleId),
    isAppRunning: async (bundleId) => byBundleId.has(bundleId),
    listConnectedBundleIds: () => [...byBundleId.keys()],
    requiresAppRestart: async () => false,
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async (bundleId) => {
      const app = byBundleId.get(bundleId);
      if (!app) throw new Error(`unknown bundleId: ${bundleId}`);
      return app;
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => ({}),
  };
}

describe("native-target-app", () => {
  describe("chooseFrontmostConnectedApp", () => {
    it("returns the unique strong candidate when one app is active", () => {
      const result = chooseFrontmostConnectedApp([
        makeAppState("com.example.a", { applicationState: "background" }),
        makeAppState("com.example.b", { applicationState: "active" }),
      ]);

      expect(result?.bundleId).toBe("com.example.b");
    });

    it("returns the unique weak candidate when no strong candidate exists", () => {
      const result = chooseFrontmostConnectedApp([
        makeAppState("com.example.a", { applicationState: "background" }),
        makeAppState("com.example.b", {
          applicationState: "inactive",
          foregroundInactiveSceneCount: 1,
        }),
      ]);

      expect(result?.bundleId).toBe("com.example.b");
    });

    it("returns null when multiple strong candidates exist", () => {
      const result = chooseFrontmostConnectedApp([
        makeAppState("com.example.a", { applicationState: "active" }),
        makeAppState("com.example.b", { foregroundActiveSceneCount: 1 }),
      ]);

      expect(result).toBeNull();
    });
  });

  describe("inspectConnectedNativeApps", () => {
    it("returns connected apps sorted by bundle id", async () => {
      const api = makeApi([makeAppState("com.example.z"), makeAppState("com.example.a")]);

      const result = await inspectConnectedNativeApps(api);
      expect(result.map((app) => app.bundleId)).toEqual(["com.example.a", "com.example.z"]);
    });
  });

  describe("resolveNativeTargetApp", () => {
    it("uses explicit bundleId when provided", async () => {
      const api = makeApi([makeAppState("com.example.a")]);

      await expect(resolveNativeTargetApp(api, "com.example.explicit")).resolves.toEqual({
        bundleId: "com.example.explicit",
        source: "explicit",
      });
    });

    it("auto-selects the only connected app", async () => {
      const api = makeApi([
        makeAppState("com.example.only", {
          applicationState: "active",
          foregroundActiveSceneCount: 1,
        }),
      ]);

      await expect(resolveNativeTargetApp(api)).resolves.toEqual({
        bundleId: "com.example.only",
        source: "single_connected_foreground_like",
      });
    });

    it("requires explicit bundleId when the only connected app is background-only", async () => {
      const api = makeApi([makeAppState("com.example.background-only")]);

      await expect(resolveNativeTargetApp(api)).rejects.toThrow(
        "Provide bundleId explicitly if you still want to target this app."
      );
    });

    it("auto-selects the unique frontmost connected app", async () => {
      const api = makeApi([
        makeAppState("com.example.background"),
        makeAppState("com.example.front", { applicationState: "active" }),
      ]);

      await expect(resolveNativeTargetApp(api)).resolves.toEqual({
        bundleId: "com.example.front",
        source: "frontmost_detected",
      });
    });

    it("throws when no connected apps are available", async () => {
      const api = makeApi([]);

      await expect(resolveNativeTargetApp(api)).rejects.toThrow(
        "No native-devtools-connected apps are available for auto-targeting. Launch or restart the app first, provide bundleId explicitly, or use screenshot to inspect visible Home/system UI."
      );
    });

    it("throws when multiple connected apps exist and none is uniquely frontmost", async () => {
      const api = makeApi([
        makeAppState("com.example.a", { applicationState: "active" }),
        makeAppState("com.example.b", { foregroundActiveSceneCount: 1 }),
      ]);

      await expect(resolveNativeTargetApp(api)).rejects.toThrow("Provide bundleId explicitly.");
    });
  });
});
