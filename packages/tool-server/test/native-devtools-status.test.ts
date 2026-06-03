import { describe, expect, it, vi } from "vitest";
import {
  MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
  type NativeDevtoolsApi,
  type NativeDevtoolsInitFailure,
} from "../src/blueprints/native-devtools";
// Both tools gate `execute()` behind `ensureDeps(["xcrun"])`, but the
// restart-guidance / init_failed logic under test never shells out to xcrun.
// The real probe makes this pass only on a host with Xcode (dev macOS) and
// fail on the Linux CI runner with `missing: [xcrun]`. Stub the gate to a
// no-op so the test exercises the logic it's about, not the host's toolchain.
// Keep the rest of the module (DependencyMissingError, cache reset) intact.
vi.mock("../src/utils/check-deps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/check-deps")>();
  return {
    ...actual,
    ensureDeps: vi.fn(async () => {}),
    ensureDep: vi.fn(async () => {}),
  };
});

import { nativeDevtoolsStatusTool } from "../src/tools/native-devtools/native-devtools-status";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";

function makeNativeApi(options: {
  envSetup?: boolean;
  connected?: boolean;
  appRunning?: boolean;
  initFailure?: NativeDevtoolsInitFailure | null;
}): {
  api: NativeDevtoolsApi;
  ensureEnvReady: ReturnType<typeof vi.fn>;
  reverifyEnv: ReturnType<typeof vi.fn>;
} {
  let envSetup = options.envSetup ?? false;
  const ensureEnvReady = vi.fn(async () => {
    envSetup = true;
  });
  const reverifyEnv = vi.fn(async () => {
    envSetup = true;
  });

  return {
    api: {
      isEnvSetup: () => envSetup,
      socketPath: "/tmp/mock.sock",
      ensureEnvReady,
      reverifyEnv,
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
    reverifyEnv,
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

  it("re-applies the env when the app is not connected (repairs a stale latch after a sim reboot)", async () => {
    // envSetup:false models the cleared launchd state after an out-of-band
    // reboot; reverifyEnv must run and bring it back to true.
    const { api, reverifyEnv } = makeNativeApi({
      appRunning: true,
      connected: false,
      envSetup: false,
    });

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

    expect(reverifyEnv).toHaveBeenCalledOnce();
  });

  it("does not re-apply the env when the app is already connected", async () => {
    const { api, reverifyEnv } = makeNativeApi({ appRunning: true, connected: true });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.example.app" }
      )
    ).resolves.toEqual({
      envSetup: true,
      appRunning: true,
      connected: true,
      requiresRestart: false,
      nextLaunchWillBeInjected: true,
    });

    expect(reverifyEnv).not.toHaveBeenCalled();
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
