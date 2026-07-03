import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { NON_INJECTABLE_NATIVE_WARNING } from "../src/blueprints/native-devtools";
import { createDescribeTool } from "../src/tools/describe";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";
import { isTvOsSimulator } from "../src/utils/ios-devices";

// describeIos probes the runtime kind to short-circuit tvOS. Mock it so these
// unit tests stay hermetic (no real `simctl`) and default to the iOS path; the
// dedicated tvOS test below overrides it per-call.
vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
}));
const mockIsTvOsSimulator = vi.mocked(isTvOsSimulator);

// The describe tool no longer surfaces the JSON tree — `result.description`
// is the text rendering produced by format-tree.ts. `elementLineCount` counts
// the per-element lines (everything indented under a section header), which
// is what the old `tree.children.length` was effectively measuring once you
// ignore the root AXGroup wrapper.
function elementLineCount(description: string): number {
  return description.split("\n").filter((l) => /^ {2}AX/.test(l)).length;
}

function makeAXServiceApi(
  response: AXDescribeResponse,
  options?: { degraded?: boolean }
): AXServiceApi {
  return {
    degraded: options?.degraded ?? false,
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
    reverifyEnv: async () => {},
    getInitFailure: () => null,
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
    // `describe` dispatches by udid shape (classifyDevice). The tests pass
    // iOS-shape udids that route to the iOS branch, whose `requires:["xcrun"]`
    // would shell out to probe PATH on Linux CI without xcrun. Prime the dep
    // cache so neither branch probes — handlers run with mock services.
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
    mockIsTvOsSimulator.mockResolvedValue(false);
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

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });
    expect(result.source).toBe("ax-service");
    expect(result.description).toContain("ROOT  AXGroup");
    expect(result.description).toMatch(/AXButton\s+"General"/);
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

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });
    expect(result.source).toBe("ax-service");
    expect(elementLineCount(result.description)).toBe(2);
    expect(result.description).toMatch(/AXButton\s+"Allow Once"/);
    expect(result.description).toMatch(/AXButton\s+"Don\u2019t Allow"/);
  });

  it("returns empty root when no elements and no native fallback", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });
    expect(result.source).toBe("ax-service");
    expect(result.description).toContain("ROOT  AXGroup");
    expect(elementLineCount(result.description)).toBe(0);
  });

  it("uses bundleId for native-devtools fallback when AX returns empty", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    // An injectable (non-Apple) app: the native fallback queries it by the
    // provided bundleId. (Apple system apps are gated off the native path — see
    // the non-injectable test below.)
    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: ["com.example.settings"],
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
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.settings" }
    );
    expect(result.source).toBe("native-devtools");
    expect(result.description).toMatch(/AXButton\s+"General"/);
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

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });
    expect(result.source).toBe("native-devtools");
    expect(result.description).toContain('"Hello World"');
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
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.app" }
    );
    expect(result.source).toBe("ax-service");
    expect(result.should_restart).toBe(true);
    expect(elementLineCount(result.description)).toBe(0);
  });

  it("does NOT return should_restart for a non-injectable Apple system app (no restart loop)", async () => {
    // com.apple.* apps can never load the injected dylib, so requiresAppRestart
    // is always true for them on real hardware. Without an injectability gate,
    // describe returns should_restart:true → the agent restarts the system app →
    // AX is still empty → describe again → unbounded loop. The fallback must
    // instead return the (empty) AX result with a screenshot hint.
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: [],
      requiresRestart: true, // real behavior: a com.apple.* app never connects
    });
    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.apple.Preferences" }
    );
    expect(result.source).toBe("ax-service");
    expect(result.should_restart).toBeUndefined();
    expect(elementLineCount(result.description)).toBe(0);
    expect(result.hint).toMatch(/system app/i);
    // Reached only after describe's own AX path returned empty, so this hint
    // leads with `screenshot` rather than re-recommending `describe`. It still
    // carries the same native-* dead-end warning verbatim as the precheck throw
    // and the native-devtools-status description (finding #4).
    expect(result.hint).toMatch(/`screenshot`/);
    expect(result.hint).toContain(NON_INJECTABLE_NATIVE_WARNING);
  });

  it("returns empty AX result when native-devtools is unavailable", async () => {
    const axApi = makeAXServiceApi({
      alertVisible: false,
      elements: [],
    });

    // No native devtools service provided — resolveService will throw
    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });
    expect(result.source).toBe("ax-service");
    expect(elementLineCount(result.description)).toBe(0);
    expect(result.should_restart).toBeUndefined();
  });

  it("returns degraded result with hint when ax-service is unavailable", async () => {
    const registry = makeMockRegistry({});
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });
    expect(result.source).toBe("ax-service");
    expect(result.hint).toMatch(/boot-device/);
    expect(elementLineCount(result.description)).toBe(0);
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

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });
    expect(result.source).toBe("ax-service");
    expect(elementLineCount(result.description)).toBe(3);
    // value is dropped when it duplicates label — see format-tree.ts hasContent comment
    expect(result.description).toMatch(/AXTextField\s+"Search"\s+\(/);
    expect(result.description).not.toMatch(/value="Search"/);
    expect(result.description).toMatch(/AXButton\s+"General"/);
    expect(result.description).toMatch(/AXButton\s+"Accessibility"/);
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

    await tool.execute({}, { udid: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB" });
    expect(registry.resolveService).toHaveBeenCalledWith(
      "AXService:BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB",
      {
        device: { id: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB", platform: "ios", kind: "simulator" },
        transport: "unix",
      }
    );
  });

  it("includes hint when ax-service is degraded (sim booted outside argent)", async () => {
    const axApi = makeAXServiceApi(
      {
        alertVisible: false,
        screenFrame: { width: 440, height: 956 },
        elements: [
          {
            label: "General",
            frame: { x: 0.045, y: 0.337, width: 0.909, height: 0.046 },
            traits: ["button"],
          },
        ],
      },
      { degraded: true }
    );

    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });
    expect(result.source).toBe("ax-service");
    expect(result.hint).toMatch(/boot-device/);
    expect(result.hint).toMatch(/system dialogs/i);
  });

  it("omits hint when ax-service is not degraded", async () => {
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

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });
    expect(result.hint).toBeUndefined();
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
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.app" }
    );
    expect(result.source).toBe("ax-service");
    expect(elementLineCount(result.description)).toBe(0);
  });

  it("routes a tvOS target to the focus-driven view instead of the iOS ax-service", async () => {
    mockIsTvOsSimulator.mockResolvedValue(true);
    // The TV focus backend answers; the iOS ax-service must never be resolved
    // for an Apple TV device.
    const tvApi = {
      describe: vi.fn().mockResolvedValue({
        bundleId: "com.example.tv",
        focused: { label: "Home", isFocused: true },
        focusable: [{ label: "Home", isFocused: true }, { label: "Search" }],
      }),
      recycleAx: vi.fn().mockResolvedValue(undefined),
    };
    const registry = {
      resolveService: vi.fn(async (urn: string) => {
        if (urn.startsWith("TvControl:")) return tvApi;
        throw new Error(`ax-service must not be resolved for tvOS: ${urn}`);
      }),
    } as any;
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD" });

    expect(result.source).toBe("tv-focus");
    expect(result.description).toContain("Focused: Home");
    expect(result.description).toContain("Focusable (2):");
    expect(result.hint).toBeUndefined();
    // Resolved the TV control service, never the iOS ax-service.
    expect(registry.resolveService).toHaveBeenCalledWith(
      "TvControl:DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD",
      expect.anything()
    );
  });
});
