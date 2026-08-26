import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_CODES, FailureError } from "@argent/registry";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { createDescribeTool } from "../src/tools/describe";
import { describeIos, __resetBootCaveatStateForTests } from "../src/tools/describe/platforms/ios";
import { createAwaitUiElementTool } from "../src/tools/await-ui-element";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

vi.mock("../src/utils/ios-devices", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/ios-devices")>(
    "../src/utils/ios-devices"
  );
  return { ...actual, isTvOsSimulator: async () => false };
});

const UDID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const DEVICE = { id: UDID, platform: "ios" as const, name: "test", state: "Booted" } as any;
const FRAME = { x: 0.1, y: 0.4, width: 0.8, height: 0.05 };

const axTimeout = () =>
  new FailureError("ax-service query timed out: describe", {
    error_code: FAILURE_CODES.AX_QUERY_TIMEOUT,
    failure_stage: "ax_service_query_socket",
    failure_area: "tool_server",
    error_kind: "timeout",
  });

function ax(describeImpl: AXServiceApi["describe"], degraded = false): AXServiceApi {
  return {
    degraded,
    describe: describeImpl,
    alertCheck: async () => false,
    ping: async () => true,
  };
}

function native(elements: unknown[] = []): NativeDevtoolsApi & { calls: number } {
  const api = {
    calls: 0,
    isEnvSetup: () => true,
    socketPath: "/tmp/test.sock",
    ensureEnvReady: async () => {},
    reverifyEnv: async () => {},
    getInitFailure: () => null,
    isConnected: () => true,
    isAppRunning: async () => true,
    listConnectedBundleIds: () => ["com.example.app"],
    appConnectionState: async () => "connected" as const,
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async (bundleId: string) => ({
      bundleId,
      applicationState: "active",
      foregroundActiveSceneCount: 1,
      foregroundInactiveSceneCount: 0,
      backgroundSceneCount: 0,
      unattachedSceneCount: 0,
      isFrontmostCandidate: true,
    }),
    detectFrontmostBundleId: async () => "com.example.app",
    queryViewHierarchy: async () => {
      api.calls += 1;
      return { screenFrame: { x: 0, y: 0, width: 440, height: 956 }, elements };
    },
  };
  return api as unknown as NativeDevtoolsApi & { calls: number };
}

function registry(axApi: AXServiceApi, nativeApi?: NativeDevtoolsApi) {
  return {
    resolveService: vi.fn(async (urn: string) => {
      if (urn.startsWith("AXService:")) return axApi;
      if (urn.startsWith("NativeDevtools:") && nativeApi) return nativeApi;
      throw new Error(`unexpected service: ${urn}`);
    }),
  } as any;
}

const nativeElement = {
  frame: { x: 20, y: 150, width: 400, height: 44 },
  tapPoint: { x: 220, y: 172 },
  normalizedFrame: { x: 0.045, y: 0.157, width: 0.909, height: 0.046 },
  normalizedTapPoint: { x: 0.5, y: 0.18 },
  traits: ["button"],
  label: "Native",
};

describe("describeIos — a read that did not complete", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
    __resetBootCaveatStateForTests();
  });
  afterEach(() => vi.useRealTimers());

  it("marks an AX timeout unreadable, skips the native fallback, and does not blame the boot", async () => {
    const nd = native([nativeElement]);
    const data = await describeIos(
      registry(
        ax(async () => {
          throw axTimeout();
        }),
        nd
      ),
      DEVICE,
      {}
    );
    expect(data.unreadable).toMatchObject({
      stage: "ax-service",
      error_code: FAILURE_CODES.AX_QUERY_TIMEOUT,
    });
    expect(data.tree.children).toHaveLength(0);
    expect(nd.calls).toBe(0);
    expect(data.hint).toMatch(/could not be read/);
    expect(data.hint).not.toMatch(/not booted through argent/);
    expect(data.should_restart).toBeUndefined();
  });

  it("keeps the native fallback for a non-timeout AX failure", async () => {
    const nd = native([nativeElement]);
    const data = await describeIos(
      registry(
        ax(async () => {
          throw new Error("ax-service daemon disconnected");
        }),
        nd
      ),
      DEVICE,
      {}
    );
    expect(nd.calls).toBe(1);
    expect(data.source).toBe("native-devtools");
    expect(data.tree.children.length).toBeGreaterThan(0);
    expect(data.unreadable).toBeUndefined();
  });

  it("skips the fallback for any failed read when fallbackOnUnreadable is false", async () => {
    const nd = native([nativeElement]);
    const data = await describeIos(
      registry(
        ax(async () => {
          throw new Error("ax-service daemon disconnected");
        }),
        nd
      ),
      DEVICE,
      {},
      { fallbackOnUnreadable: false }
    );
    expect(nd.calls).toBe(0);
    expect(data.unreadable?.stage).toBe("ax-service");
  });

  it("treats an empty answer that took seconds as unreadable, a fast empty answer as blank", async () => {
    vi.useFakeTimers();
    const slowEmpty = ax(async () => {
      vi.advanceTimersByTime(6000);
      return { alertVisible: false, screenFrame: { width: 440, height: 956 }, elements: [] };
    });
    const nd = native([nativeElement]);
    const slow = await describeIos(registry(slowEmpty, nd), DEVICE, {});
    expect(slow.unreadable?.error_code).toBe("AX_READ_SLOW_EMPTY");
    expect(nd.calls).toBe(0);

    const fastEmpty = ax(async () => ({
      alertVisible: false,
      screenFrame: { width: 440, height: 956 },
      elements: [],
    }));
    const nd2 = native([nativeElement]);
    const fast = await describeIos(registry(fastEmpty, nd2), DEVICE, {});
    expect(fast.unreadable).toBeUndefined();
    expect(nd2.calls).toBe(1);
  });

  it("passes the caller's budget to the AX read", async () => {
    const seen: unknown[] = [];
    const axApi = ax(async (opts) => {
      seen.push(opts);
      return {
        alertVisible: false,
        screenFrame: { width: 440, height: 956 },
        elements: [{ label: "X", frame: FRAME, traits: ["button"] }],
      } as AXDescribeResponse;
    });
    await describeIos(registry(axApi), DEVICE, {}, { axTimeoutMs: 1234 });
    expect(seen[0]).toEqual({ timeoutMs: 1234 });
  });
});

describe("describe tool — unreadable result", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
    __resetBootCaveatStateForTests();
  });

  it("carries `unreadable` and leads the description with SCREEN NOT READ", async () => {
    const seen: unknown[] = [];
    const axApi = ax(async (opts) => {
      seen.push(opts);
      throw axTimeout();
    });
    const tool = createDescribeTool(registry(axApi, native([nativeElement])));
    const result = await tool.execute({}, { udid: UDID, timeoutMs: 3000 });
    expect(seen[0]).toEqual({ timeoutMs: 3000 });
    expect(result.unreadable?.error_code).toBe(FAILURE_CODES.AX_QUERY_TIMEOUT);
    expect(result.description.startsWith("SCREEN NOT READ (ax-service:")).toBe(true);
  });

  it("rejects a budget outside the schema range", () => {
    const tool = createDescribeTool(
      registry(
        ax(async () => {
          throw axTimeout();
        })
      )
    );
    expect(tool.zodSchema!.safeParse({ udid: UDID, timeoutMs: 100 }).success).toBe(false);
    expect(tool.zodSchema!.safeParse({ udid: UDID, timeoutMs: 3000 }).success).toBe(true);
  });
});

describe("await-ui-element — an unreadable tree is a blind read", () => {
  beforeEach(() => {
    __resetDepCacheForTests();
    __primeDepCacheForTests(["xcrun", "adb"]);
  });

  it("does not resolve `hidden` off a read that never completed", async () => {
    const tool = createAwaitUiElementTool(
      registry(
        ax(async () => {
          throw axTimeout();
        })
      )
    );
    const result = await tool.execute(
      {},
      {
        udid: UDID,
        selector: { text: "Loading" },
        condition: "hidden",
        timeoutMs: 80,
        pollIntervalMs: 10,
      }
    );
    expect(result.success).toBe(false);
    expect(result.cause).toBe("unreadable");
  });
});
