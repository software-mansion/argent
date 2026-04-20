import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { createDescribeTool } from "../src/tools/interactions/describe";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { __resetClassifyCacheForTests } from "../src/utils/platform-detect";

function makeAXServiceApi(response: AXDescribeResponse): AXServiceApi {
  return {
    describe: async () => response,
    alertCheck: async () => response.alertVisible,
    ping: async () => true,
  };
}

function makeNativeDevtoolsApi(options: {
  connectedBundleIds?: string[];
  requiresRestart?: boolean;
  describeScreenResult?: unknown;
}): NativeDevtoolsApi {
  const connected = new Set(options.connectedBundleIds ?? []);
  return {
    isEnvSetup: () => true,
    socketPath: "/tmp/test.sock",
    ensureEnvReady: async () => {},
    isConnected: (bundleId) => connected.has(bundleId),
    isAppRunning: async () => true,
    listConnectedBundleIds: () => [...connected],
    requiresAppRestart: async () => options.requiresRestart ?? false,
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
    detectFrontmostBundleId: async () => [...connected][0] ?? null,
    queryViewHierarchy: async () =>
      options.describeScreenResult ?? {
        screenFrame: { x: 0, y: 0, width: 440, height: 956 },
        elements: [],
      },
  } as NativeDevtoolsApi;
}

function makeMockRegistry(options: {
  axService?: AXServiceApi;
  nativeDevtools?: NativeDevtoolsApi;
}) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) {
        if (options.axService) return options.axService;
        throw new Error("ax-service not available");
      }
      if (urn.startsWith("NativeDevtools:")) {
        if (options.nativeDevtools) return options.nativeDevtools;
        throw new Error("native-devtools not available");
      }
      throw new Error(`unknown service: ${urn}`);
    }),
  } as any;
}

describe("describe tool", () => {
  beforeEach(() => {
    // `describe` is cross-platform: after classifyDevice it calls
    // ensureDep('xcrun' | 'adb'). The tests here pass raw iOS-shape udids
    // that don't appear in any simctl inventory, so classifyDevice falls
    // through to the shape check — on Linux CI without xcrun/adb that would
    // then fail the dep gate before the actual describe logic runs. Prime
    // both caches so neither side probes PATH or shells out.
    __resetClassifyCacheForTests();
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  it("returns elements from ax-service daemon", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "General",
          frame: { x: 0.045, y: 0.337, width: 0.909, height: 0.046 },
          traits: ["button"],
        },
      ],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "11111111-1111-1111-1111-111111111111" });
    expect(result.source).toBe("ax-service");
    expect(result.tree.role).toBe("AXGroup");
    expect(result.tree.children[0]?.label).toBe("General");
    expect(result.tree.children[0]?.role).toBe("AXButton");
  });

  it("returns dialog elements when alertVisible is true", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: true,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "Allow Once",
          frame: { x: 0.1, y: 0.5, width: 0.8, height: 0.05 },
          traits: ["button"],
        },
        {
          label: "Don\u2019t Allow",
          frame: { x: 0.1, y: 0.56, width: 0.8, height: 0.05 },
          traits: ["button"],
        },
      ],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "11111111-1111-1111-1111-111111111111" });
    expect(result.source).toBe("ax-service");
    expect(result.tree.children).toHaveLength(2);
    expect(result.tree.children[0]?.label).toBe("Allow Once");
    expect(result.tree.children[0]?.role).toBe("AXButton");
    expect(result.tree.children[1]?.label).toBe("Don\u2019t Allow");
  });

  it("returns empty root when no elements and no native fallback", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "11111111-1111-1111-1111-111111111111" });
    expect(result.source).toBe("ax-service");
    expect(result.tree.role).toBe("AXGroup");
    expect(result.tree.children).toHaveLength(0);
  });

  it("uses bundleId for native-devtools fallback when AX returns empty", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: ["com.apple.Preferences"],
      describeScreenResult: {
        screenFrame: { x: 0, y: 0, width: 440, height: 956 },
        elements: [
          {
            frame: { x: 20, y: 150, width: 400, height: 44 },
            tapPoint: { x: 220, y: 172 },
            normalizedFrame: { x: 0.045, y: 0.157, width: 0.909, height: 0.046 },
            normalizedTapPoint: { x: 0.5, y: 0.18 },
            traits: ["button"],
            label: "General",
          },
        ],
      },
    });

    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.apple.Preferences" }
    );
    expect(result.source).toBe("native-devtools");
    expect(result.tree.children[0]?.label).toBe("General");
    expect(result.tree.children[0]?.role).toBe("AXButton");
  });

  it("falls back to native-devtools with auto-target when AX returns empty", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: ["com.example.app"],
      describeScreenResult: {
        screenFrame: { x: 0, y: 0, width: 440, height: 956 },
        elements: [
          {
            frame: { x: 10, y: 100, width: 420, height: 40 },
            tapPoint: { x: 220, y: 120 },
            normalizedFrame: { x: 0.023, y: 0.105, width: 0.955, height: 0.042 },
            normalizedTapPoint: { x: 0.5, y: 0.126 },
            traits: ["staticText"],
            label: "Hello World",
          },
        ],
      },
    });

    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "11111111-1111-1111-1111-111111111111" });
    expect(result.source).toBe("native-devtools");
    expect(result.tree.children[0]?.label).toBe("Hello World");
    expect(result.should_restart).toBeUndefined();
  });

  it("returns should_restart when native-devtools app requires restart", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: ["com.example.app"],
      requiresRestart: true,
    });

    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.example.app" }
    );
    expect(result.source).toBe("ax-service");
    expect(result.should_restart).toBe(true);
    expect(result.tree.children).toHaveLength(0);
  });

  it("returns empty AX result when native-devtools is unavailable", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    // No native devtools service provided — resolveService will throw
    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "11111111-1111-1111-1111-111111111111" });
    expect(result.source).toBe("ax-service");
    expect(result.tree.children).toHaveLength(0);
    expect(result.should_restart).toBeUndefined();
  });

  it("throws when ax-service is unavailable", async () => {
    const registry = makeMockRegistry({});
    const tool = createDescribeTool(registry);

    await expect(
      tool.execute({}, { udid: "11111111-1111-1111-1111-111111111111" })
    ).rejects.toThrow("ax-service not available");
  });

  it("returns multiple elements with correct roles", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "Search",
          frame: { x: 0.05, y: 0.16, width: 0.9, height: 0.04 },
          traits: ["searchField"],
          value: "Search",
        },
        {
          label: "General",
          frame: { x: 0.05, y: 0.34, width: 0.9, height: 0.05 },
          traits: ["button", "staticText"],
        },
        {
          label: "Accessibility",
          frame: { x: 0.05, y: 0.4, width: 0.9, height: 0.05 },
          traits: ["button", "staticText"],
        },
      ],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "11111111-1111-1111-1111-111111111111" });
    expect(result.source).toBe("ax-service");
    expect(result.tree.children).toHaveLength(3);
    expect(result.tree.children[0]?.role).toBe("AXTextField");
    expect(result.tree.children[0]?.value).toBe("Search");
    expect(result.tree.children[1]?.role).toBe("AXButton");
    expect(result.tree.children[2]?.label).toBe("Accessibility");
  });

  it("resolves ax-service with the correct URN", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      screenFrame: { width: 440, height: 956 },
      elements: [
        {
          label: "Item",
          frame: { x: 0.05, y: 0.3, width: 0.9, height: 0.05 },
          traits: ["staticText"],
        },
      ],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    await tool.execute({}, { udid: "11111111-2222-3333-4444-555555555555" });
    expect(registry.resolveService).toHaveBeenCalledWith(
      "AXService:11111111-2222-3333-4444-555555555555"
    );
  });

  it("returns empty AX result when native queryViewHierarchy returns an error", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: ["com.example.app"],
      describeScreenResult: { error: "view hierarchy unavailable" },
    });

    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.example.app" }
    );
    expect(result.source).toBe("ax-service");
    expect(result.tree.children).toHaveLength(0);
  });
});
