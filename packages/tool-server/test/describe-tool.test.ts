import { describe, expect, it } from "vitest";
import type { NativeDevtoolsApi, NativeAppState } from "../src/blueprints/native-devtools";
import { describeTool } from "../src/tools/interactions/describe";

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

function makeNativeApi(options: {
  apps?: NativeAppState[];
  requiresRestart?: boolean;
  nativeResult?: unknown;
  queryError?: string;
}): NativeDevtoolsApi {
  const apps = options.apps ?? [];
  const byBundleId = new Map(apps.map((app) => [app.bundleId, app]));

  return {
    isEnvSetup: () => true,
    socketPath: "/tmp/mock.sock",
    ensureEnvReady: async () => {},
    isConnected: (bundleId) => byBundleId.has(bundleId),
    isAppRunning: async (bundleId) => byBundleId.has(bundleId),
    listConnectedBundleIds: () => [...byBundleId.keys()],
    requiresAppRestart: async () => options.requiresRestart ?? false,
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async (bundleId) => {
      const app = byBundleId.get(bundleId);
      if (!app) throw new Error(`unknown bundleId: ${bundleId}`);
      return app;
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => {
      if (options.queryError) return { error: options.queryError };
      return (
        options.nativeResult ?? {
          screenFrame: { x: 0, y: 0, width: 390, height: 844 },
          elements: [],
        }
      );
    },
  };
}

describe("describe tool", () => {
  it("uses the native path when bundleId is explicitly provided", async () => {
    const result = await describeTool.execute(
      {
        nativeDevtools: makeNativeApi({
          apps: [makeAppState("com.example.app")],
          nativeResult: {
            screenFrame: { x: 0, y: 0, width: 390, height: 844 },
            elements: [
              {
                frame: { x: 16, y: 80, width: 100, height: 44 },
                tapPoint: { x: 66, y: 102 },
                normalizedFrame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
                normalizedTapPoint: { x: 0.25, y: 0.25 },
                traits: ["button"],
                label: "Native button",
              },
            ],
          },
        }),
      },
      { udid: "SIM-1", bundleId: "com.example.app" }
    );

    expect(result.role).toBe("AXGroup");
    expect(result.children[0]?.label).toBe("Native button");
  });

  it("auto-targets a uniquely foreground-like connected app", async () => {
    const result = await describeTool.execute(
      {
        nativeDevtools: makeNativeApi({
          apps: [
            makeAppState("com.example.foreground", {
              applicationState: "active",
              foregroundActiveSceneCount: 1,
              backgroundSceneCount: 0,
            }),
          ],
          nativeResult: {
            screenFrame: { x: 0, y: 0, width: 390, height: 844 },
            elements: [
              {
                frame: { x: 16, y: 80, width: 100, height: 44 },
                tapPoint: { x: 66, y: 102 },
                normalizedFrame: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
                normalizedTapPoint: { x: 0.25, y: 0.25 },
                traits: ["button"],
                label: "Foreground button",
              },
            ],
          },
        }),
      },
      { udid: "SIM-1" }
    );

    expect(result.children[0]?.label).toBe("Foreground button");
  });

  it("requires a connected app when auto mode has no native target", async () => {
    await expect(
      describeTool.execute(
        {
          nativeDevtools: makeNativeApi({ apps: [] }),
        },
        { udid: "SIM-1" }
      )
    ).rejects.toThrow(
      "No native-devtools-connected apps are available for auto-targeting. Launch or restart the app first, provide bundleId explicitly, or use screenshot to inspect visible Home/system UI."
    );
  });

  it("requires explicit bundleId when the only connected app is background-only", async () => {
    await expect(
      describeTool.execute(
        {
          nativeDevtools: makeNativeApi({
            apps: [makeAppState("com.example.background-only")],
          }),
        },
        { udid: "SIM-1" }
      )
    ).rejects.toThrow("Provide bundleId explicitly if you still want to target this app.");
  });

  it("throws restart guidance when explicit bundleId requires native reinjection", async () => {
    await expect(
      describeTool.execute(
        {
          nativeDevtools: makeNativeApi({ requiresRestart: true }),
        },
        { udid: "SIM-1", bundleId: "com.example.app" }
      )
    ).rejects.toThrow("Call restart-app with the same bundleId, then retry describe.");
  });

  it("surfaces native query errors directly", async () => {
    await expect(
      describeTool.execute(
        {
          nativeDevtools: makeNativeApi({
            apps: [makeAppState("com.example.app")],
            queryError: "view hierarchy unavailable",
          }),
        },
        { udid: "SIM-1", bundleId: "com.example.app" }
      )
    ).rejects.toThrow("view hierarchy unavailable");
  });
});
