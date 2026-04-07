import { describe, expect, it, vi } from "vitest";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { nativeDevtoolsStatusTool } from "../src/tools/native-devtools/native-devtools-status";

function makeNativeApi(options: {
  envSetup?: boolean;
  connected?: boolean;
  appRunning?: boolean;
}): { api: NativeDevtoolsApi; ensureEnvReady: ReturnType<typeof vi.fn> } {
  let envSetup = options.envSetup ?? false;
  const ensureEnvReady = vi.fn(async () => {
    envSetup = true;
  });

  return {
    api: {
      isEnvSetup: () => envSetup,
      socketPath: "/tmp/mock.sock",
      ensureEnvReady,
      isConnected: () => options.connected ?? false,
      isAppRunning: async () => options.appRunning ?? false,
      listConnectedBundleIds: () => [],
      requiresAppRestart: async () => {
        throw new Error("native-devtools-status should compute restart guidance directly");
      },
      activateNetworkInspection: () => {},
      getNetworkLog: () => [],
      clearNetworkLog: () => {},
      getAppState: async () => {
        throw new Error("not implemented");
      },
      detectFrontmostBundleId: async () => null,
      queryViewHierarchy: async () => ({}),
    },
    ensureEnvReady,
  };
}

describe("native-devtools-status tool", () => {
  it("reports a running uninjected app as needing restart", async () => {
    const { api, ensureEnvReady } = makeNativeApi({ appRunning: true, connected: false });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "SIM-1", bundleId: "com.example.app" }
      )
    ).resolves.toEqual({
      envSetup: true,
      appRunning: true,
      connected: false,
      requiresRestart: true,
      nextLaunchWillBeInjected: true,
    });

    expect(ensureEnvReady).toHaveBeenCalledOnce();
  });

  it("reports a stopped app as launch-ready without requiring restart", async () => {
    const { api } = makeNativeApi({ appRunning: false, connected: false });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "SIM-1", bundleId: "com.example.app" }
      )
    ).resolves.toEqual({
      envSetup: true,
      appRunning: false,
      connected: false,
      requiresRestart: false,
      nextLaunchWillBeInjected: true,
    });
  });
});
