import { describe, it, expect } from "vitest";
import { FAILURE_CODES, FailureError, type DeviceInfo, type Registry } from "@argent/registry";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import { queryFullHierarchyTree } from "../../src/tools/flows/flow-ios-tree";

// The `launch:`-derived hint is a TIMEOUT ARBITER only. Target auto-resolution
// runs on every read; the hint decides the target solely when that resolution
// fails with an RPC timeout (the app's main thread is mid-stall) AND the
// hinted app's devtools connection is still up. Every answered resolution —
// including the deliberate "single app but backgrounded" error — wins over the
// hint, so no foreground-likeness guard is ever bypassed by a healthy app.

const IOS_DEVICE = {
  id: "00000000-0000-0000-0000-0000000000ab",
  platform: "ios",
} as unknown as DeviceInfo;

const APP = "com.example.app";

const rpcTimeout = () =>
  new FailureError("ViewInspector RPC timed out: Application.getState", {
    error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
    failure_stage: "native_devtools_rpc_request",
    failure_area: "tool_server",
    error_kind: "timeout",
  });

function windowSpanning() {
  return {
    className: "UIWindow",
    frame: { x: 0, y: 0, width: 400, height: 800 },
    windowFrame: { x: 0, y: 0, width: 400, height: 800 },
    children: [],
  };
}

function activeState(bundleId: string): NativeAppState {
  return {
    bundleId,
    applicationState: "active",
    foregroundActiveSceneCount: 1,
    foregroundInactiveSceneCount: 0,
    backgroundSceneCount: 0,
    unattachedSceneCount: 0,
    isFrontmostCandidate: true,
  };
}

function backgroundState(bundleId: string): NativeAppState {
  return {
    bundleId,
    applicationState: "background",
    foregroundActiveSceneCount: 0,
    foregroundInactiveSceneCount: 0,
    backgroundSceneCount: 1,
    unattachedSceneCount: 0,
    isFrontmostCandidate: false,
  };
}

function api(overrides: Partial<Record<keyof NativeDevtoolsApi, unknown>>): NativeDevtoolsApi {
  return {
    listConnectedBundleIds: () => [APP],
    getAppState: async (id: string) => activeState(id),
    queryViewHierarchy: async (bundleId: string) => ({
      windows: [windowSpanning()],
      queried: bundleId,
    }),
    ...overrides,
  } as unknown as NativeDevtoolsApi;
}

function registryFor(nativeApi: NativeDevtoolsApi): Registry {
  return { resolveService: async () => nativeApi } as unknown as Registry;
}

describe("queryFullHierarchyTree launch hint", () => {
  it("falls back to the hinted app when getState times out and the hint is connected", async () => {
    const queried: string[] = [];
    const nativeApi = api({
      getAppState: async () => {
        throw rpcTimeout();
      },
      queryViewHierarchy: async (bundleId: string) => {
        queried.push(bundleId);
        return { windows: [windowSpanning()] };
      },
    });
    const tree = await queryFullHierarchyTree(registryFor(nativeApi), IOS_DEVICE, APP);
    expect(queried).toEqual([APP]);
    expect(tree.tree).toBeDefined();
  });

  it("rethrows the timeout when no hint is provided", async () => {
    const nativeApi = api({
      getAppState: async () => {
        throw rpcTimeout();
      },
    });
    await expect(queryFullHierarchyTree(registryFor(nativeApi), IOS_DEVICE)).rejects.toThrow(
      /RPC timed out/
    );
  });

  it("rethrows the timeout when the hinted app is no longer connected", async () => {
    const nativeApi = api({
      listConnectedBundleIds: () => ["com.other.app"],
      getAppState: async () => {
        throw rpcTimeout();
      },
    });
    await expect(queryFullHierarchyTree(registryFor(nativeApi), IOS_DEVICE, APP)).rejects.toThrow(
      /RPC timed out/
    );
  });

  it("does not use the hint to bypass an answered backgrounded-app guard", async () => {
    // Resolution ANSWERS here (single app, backgrounded → deliberate error);
    // the hint must not override it.
    const nativeApi = api({
      getAppState: async (id: string) => backgroundState(id),
    });
    await expect(queryFullHierarchyTree(registryFor(nativeApi), IOS_DEVICE, APP)).rejects.toThrow(
      /not foreground-like/
    );
  });

  it("rethrows non-timeout resolution failures even with a connected hint", async () => {
    const nativeApi = api({
      getAppState: async () => {
        throw new FailureError("boom", {
          error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_ERROR,
          failure_stage: "native_devtools_rpc_response",
          failure_area: "tool_server",
          error_kind: "subprocess",
        });
      },
    });
    await expect(queryFullHierarchyTree(registryFor(nativeApi), IOS_DEVICE, APP)).rejects.toThrow(
      /boom/
    );
  });

  it("prefers the resolved frontmost app over a stale hint when resolution answers", async () => {
    // Two connected apps, resolution succeeds and picks the frontmost (B);
    // the hint (A) must not shadow it.
    const A = "com.example.app";
    const B = "com.example.other";
    const queried: string[] = [];
    const nativeApi = api({
      listConnectedBundleIds: () => [A, B],
      getAppState: async (id: string) => (id === B ? activeState(id) : backgroundState(id)),
      queryViewHierarchy: async (bundleId: string) => {
        queried.push(bundleId);
        return { windows: [windowSpanning()] };
      },
    });
    await queryFullHierarchyTree(registryFor(nativeApi), IOS_DEVICE, A);
    expect(queried).toEqual([B]);
  });
});
