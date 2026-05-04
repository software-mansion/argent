import { describe, it, expect, vi } from "vitest";
import { nativeFindViewsTool } from "../src/tools/native-devtools/native-find-views";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";

function makeApi(): NativeDevtoolsApi {
  return {
    isEnvSetup: () => true,
    socketPath: "/tmp/test.sock",
    ensureEnvReady: async () => {},
    isConnected: () => true,
    isAppRunning: async () => true,
    listConnectedBundleIds: () => ["com.example.app"],
    requiresAppRestart: async () => false,
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async (bundleId) => ({
      bundleId,
      applicationState: "active",
      foregroundActiveSceneCount: 1,
      foregroundInactiveSceneCount: 0,
      backgroundSceneCount: 0,
      unattachedSceneCount: 0,
      isFrontmostCandidate: true,
    }),
    detectFrontmostBundleId: async () => "com.example.app",
    queryViewHierarchy: vi.fn(async () => ({
      matches: [],
    })) as unknown as NativeDevtoolsApi["queryViewHierarchy"],
  };
}

describe("native-find-views — at-least-one-filter contract", () => {
  it("rejects when called without any filter, matching the docstring promise", async () => {
    // The tool's docstring claims:
    //   "At least one of className, identifier, label, tag, or nativeID must be provided."
    // The zodSchema marks every filter as `.optional()` so the schema layer cannot
    // enforce this. A runtime guard at the top of execute must surface the contract
    // — otherwise an unfiltered RPC reaches the device, returns empty matches, and
    // the agent misreads "no matches" as "view does not exist".
    const api = makeApi();
    const tool = nativeFindViewsTool;

    await expect(
      tool.execute!({ nativeDevtools: api } as Record<string, unknown>, {
        udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
        bundleId: "com.example.app",
      })
    ).rejects.toThrow(/at least one of/i);
  });

  it("does not call the underlying RPC when no filter is provided", async () => {
    const api = makeApi();
    const queryViewHierarchy = api.queryViewHierarchy as ReturnType<typeof vi.fn>;
    const tool = nativeFindViewsTool;

    await expect(
      tool.execute!({ nativeDevtools: api } as Record<string, unknown>, {
        udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
        bundleId: "com.example.app",
      })
    ).rejects.toThrow();

    expect(queryViewHierarchy).not.toHaveBeenCalled();
  });

  it("accepts the call when at least one filter is provided", async () => {
    const api = makeApi();
    const tool = nativeFindViewsTool;

    await expect(
      tool.execute!({ nativeDevtools: api } as Record<string, unknown>, {
        udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
        bundleId: "com.example.app",
        className: "UIButton",
      })
    ).resolves.toEqual({ status: "ok", matches: [] });
  });
});
