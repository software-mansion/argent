import { describe, expect, it, vi } from "vitest";
import {
  MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
  type NativeDevtoolsApi,
  type NativeDevtoolsInitFailure,
} from "../src/blueprints/native-devtools";
import { nativeDevtoolsStatusTool } from "../src/tools/native-devtools/native-devtools-status";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";

function makeNativeApi(options: {
  envSetup?: boolean;
  connected?: boolean;
  appRunning?: boolean;
  initFailure?: NativeDevtoolsInitFailure | null;
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
      getInitFailure: () => options.initFailure ?? null,
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
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.example.app" }
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
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.example.app" }
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

describe("native-devtools tools — init_failed precheck", () => {
  const FAILED_UDID = "22222222-2222-2222-2222-222222222222";

  it("native-describe-screen returns init_failed when the api reports givenUp", async () => {
    const { api } = makeNativeApi({
      initFailure: {
        attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
        lastError: "ensureEnv timeout",
        givenUp: true,
      },
    });

    const result = await nativeDescribeScreenTool.execute(
      { nativeDevtools: api },
      { udid: FAILED_UDID, bundleId: "com.example.app" }
    );
    expect(result).toMatchObject({
      status: "init_failed",
      attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
    });
    if (result.status === "init_failed") {
      expect(result.message).toContain(FAILED_UDID);
      expect(result.message).toContain("ensureEnv timeout");
    }
  });

  it("native-describe-screen proceeds normally below the cap", async () => {
    // Below cap → not given up → tool should NOT short-circuit. We trigger a
    // restart_required response by stubbing requiresAppRestart to true; the
    // point is to confirm the precheck didn't fire.
    const { api } = makeNativeApi({
      initFailure: {
        attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS - 1,
        lastError: "transient",
        givenUp: false,
      },
    });
    api.requiresAppRestart = async () => true;

    const result = await nativeDescribeScreenTool.execute(
      { nativeDevtools: api },
      { udid: FAILED_UDID, bundleId: "com.example.app" }
    );
    expect(result).toMatchObject({ status: "restart_required" });
  });

  it("native-devtools-status returns init_failed when the api reports givenUp", async () => {
    const { api } = makeNativeApi({
      initFailure: {
        attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
        lastError: "simctl spawn timed out",
        givenUp: true,
      },
    });

    const result = await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: FAILED_UDID, bundleId: "com.example.app" }
    );
    expect(result).toMatchObject({ status: "init_failed" });
  });

  it("converts a transient ensureEnvReady throw into init_failed (fail-fast)", async () => {
    // !givenUp at call time, but ensureEnvReady throws and records a fresh
    // failure. The precheck must surface the freshly-recorded state as
    // init_failed instead of letting the raw Error escape to the agent.
    const { api } = makeNativeApi({
      initFailure: {
        attempts: 1,
        lastError: "first attempt failed",
        givenUp: false,
      },
    });
    api.ensureEnvReady = async () => {
      throw new Error("transient ensureEnv failure");
    };

    const result = await nativeDescribeScreenTool.execute(
      { nativeDevtools: api },
      { udid: FAILED_UDID, bundleId: "com.example.app" }
    );
    expect(result).toMatchObject({ status: "init_failed", attempts: 1 });
    if (result.status === "init_failed") {
      expect(result.message).toContain(FAILED_UDID);
    }
  });
});
