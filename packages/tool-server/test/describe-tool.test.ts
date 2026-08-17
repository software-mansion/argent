import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AXServiceApi, AXDescribeResponse } from "../src/blueprints/ax-service";
import type { NativeDevtoolsApi, NativeDevtoolsAppState } from "../src/blueprints/native-devtools";
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
  state?: NativeDevtoolsAppState;
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
    appConnectionState: async () =>
      options.state ?? (options.requiresRestart ? "stale_process" : "connected"),
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
    // The boolean alone is an undocumented JSON field; the reason the relaunch
    // is warranted has to travel with it.
    expect(result.hint).toContain("restart-app");
  });

  it("carries the loop escape for a process it could not inspect", async () => {
    // `indeterminate` is the only unconnected state a *running* app reaches on
    // ios-remote, whose app processes cannot be inspected. describe sets
    // should_restart there and await-ui-element renders it as "call restart-app
    // and retry", so without the diagnosis riding along the agent restarts
    // forever with nothing ever naming the tool-server.
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: [],
      state: "indeterminate",
    });
    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.app" }
    );
    expect(result.source).toBe("ax-service");
    expect(result.should_restart).toBe(true);
    expect(result.hint).toContain("do not keep restarting the app");
    expect(result.hint).toContain("argent server stop && argent server start --detach");
  });

  it("names the stopped app rather than only flagging a restart", async () => {
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: [],
      state: "not_running",
    });
    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.app" }
    );
    expect(result.should_restart).toBe(true);
    expect(result.hint).toContain("com.example.app");
    expect(result.hint).toContain("launch-app");
  });

  it("keeps the AX-degraded hint alongside the connection diagnosis", async () => {
    // The two hints answer different questions — how to fix the sim boot, and
    // why the native fallback is silent — so neither may displace the other.
    // Both arms of the should_restart split build the hint separately, so
    // covering one leaves the other free to drop it.
    const remedies: Record<string, string> = {
      stale_process: "restart-app",
      unregistered: "argent server stop && argent server start --detach",
    };
    for (const [state, remedy] of Object.entries(remedies)) {
      const axApi = makeAXServiceApi({ alertVisible: false, elements: [] }, { degraded: true });
      const nativeApi = makeNativeDevtoolsApi({
        connectedBundleIds: [],
        state: state as "stale_process" | "unregistered",
      });
      const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
      const tool = createDescribeTool(registry);

      const result = await tool.execute(
        {},
        { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.app" }
      );
      expect(result.hint, `${state} must keep the boot guidance`).toContain("boot-device");
      expect(result.hint, `${state} must keep its own remedy`).toContain(remedy);
    }
  });

  // `appConnectionState` re-applies the launchd env before it can answer, so it
  // rejects on a sim that went away mid-call. An empty tree returned bare there
  // reads as "nothing on screen" rather than "could not be read".
  it("still explains itself when the connection probe throws", async () => {
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const nativeApi = makeNativeDevtoolsApi({ connectedBundleIds: [], state: "stale_process" });
    nativeApi.appConnectionState = async () => {
      throw new Error("Invalid device: AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");
    };
    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.app" }
    );
    expect(result.hint).toBeDefined();
    expect(result.hint).toContain("do not keep restarting the app");
  });

  // Without `bundleId`, `resolveNativeTargetApp` draws its candidates from the
  // connected list — so every state the diagnosis explains throws out of the
  // resolution, before anything is measured. This is the DEFAULT form of the
  // call, so the two forms would otherwise answer differently for one device
  // state.
  it("explains an unreadable empty screen even with no bundleId to measure", async () => {
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const nativeApi = makeNativeDevtoolsApi({ connectedBundleIds: [], state: "unregistered" });
    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });

    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/not evidence that nothing is on screen/);
    // No app was resolved, so no state was measured and no relaunch may be
    // prescribed — the empty read is marked untrustworthy, nothing more.
    expect(result.should_restart).toBeUndefined();
  });

  // The blueprint is registered unconditionally, so on an iOS target a failed
  // resolution never means "no such service" — it means the service did not come
  // up (commonly a socket bind losing to a concurrent same-udid server). A
  // failed attempt at corroboration, so the empty read is still unexplained.
  it("explains the read when the native-devtools service fails to come up", async () => {
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });

    expect(result.hint).toMatch(/not evidence that nothing is on screen/);
    expect(result.should_restart).toBeUndefined();
  });

  // All three sites that emit this hint are reachable with an explicit
  // bundleId, so "pass bundleId" would name the step the caller already took.
  it("does not tell a caller that passed bundleId to pass bundleId", async () => {
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const nativeApi = makeNativeDevtoolsApi({ connectedBundleIds: ["com.example.app"] });
    nativeApi.queryViewHierarchy = async () => {
      throw new Error("inspector timeout after 5000ms");
    };
    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.app" }
    );

    expect(result.hint).toMatch(/not evidence that nothing is on screen/);
    expect(result.hint).not.toMatch(/Pass `bundleId`/);
    // Dropping the bundleId half must not drop `screenshot` with it — the only
    // action left when the hierarchy cannot be read.
    expect(result.hint).toMatch(/screenshot/);
  });

  // An agent reads both forms, so both have to parse as English: the
  // conditional clause and the action it leads into are one sentence, and
  // joining them wrongly yields "measured, or Take a `screenshot`".
  it.each([
    ["with bundleId", "com.example.app", /on screen\. Take a `screenshot` to see what is there\.$/],
    [
      "without bundleId",
      undefined,
      /on screen\. Pass `bundleId` to have the connection state measured, or take a `screenshot` to see what is there\.$/,
    ],
  ] as const)("reads as one grammatical sentence %s", async (_label, bundleId, expected) => {
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", ...(bundleId ? { bundleId } : {}) }
    );

    expect(result.hint).toMatch(expected);
  });

  // The ax-service's own hint is the simulator's state and carries the only
  // corrective action for it; the read-level note must not displace it.
  it("keeps the ax-degraded boot guidance ahead of the unreadable-hierarchy note", async () => {
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] }, { degraded: true });
    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute({}, { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA" });

    expect(result.hint).toContain("boot-device");
    expect(result.hint).toMatch(/not evidence that nothing is on screen/);
    // "ahead of" is the point: a reader who stops at the first sentence must
    // reach the sim-level corrective action, not the note about one read.
    // Presence alone passes with the two swapped.
    expect(result.hint!.indexOf("boot-device")).toBeLessThan(
      result.hint!.indexOf("not evidence that nothing is on screen")
    );
  });

  it("does NOT return should_restart while the app is still connecting", async () => {
    // await-ui-element renders `should_restart` as "call restart-app and retry",
    // and exec is what starts the dial — so obeying it mid-handshake discards the
    // connection being waited on and resets the age the verdict reads.
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: [],
      state: "connecting",
    });
    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.app" }
    );
    expect(result.source).toBe("ax-service");
    expect(result.should_restart).toBeUndefined();
    expect(result.hint).toContain("Wait a few seconds");
    // The prohibition, not just the absence of the hyphenated tool name — the
    // hint is describe's only prose channel, and "then relaunch the app" would
    // satisfy every other assertion here. With its colon, so that a qualified
    // "…more than once" cannot pass off one relaunch as permitted: here the
    // first one is already the one that discards the handshake.
    expect(result.hint).toContain("Do NOT restart the app:");
    expect(result.hint).not.toMatch(/restart-app/);
  });

  it("does NOT return should_restart when the app is injected but unregistered", async () => {
    // The process here already launched with this service's injection in place,
    // so a relaunch reproduces it and `should_restart` would rebuild the
    // restart-app → describe loop. The diagnosis travels as a hint instead,
    // which still marks the empty read untrustworthy for await-ui-element.
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: [],
      state: "unregistered",
    });
    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.example.app" }
    );
    expect(result.source).toBe("ax-service");
    expect(result.should_restart).toBeUndefined();
    expect(result.hint).toContain("argent server stop && argent server start --detach");
    expect(result.hint).not.toMatch(/restart-app/);
  });

  it("does NOT return should_restart for a non-injectable Apple system app (no restart loop)", async () => {
    // A com.apple.* app cannot be relied on to load the dylib, so it may never
    // connect — yet the simulator's launchd env is applied process-wide, so its
    // process carries the injection tokens and the measurement judges it on age.
    // Older than this tool-server's listener (the usual case: system apps are
    // already running when the server starts) reads `stale_process`, whose
    // remedy is restart-app. Without an injectability gate that is
    // should_restart:true → restart → AX still empty → describe → unbounded
    // loop. The fallback must return the (empty) AX result with a screenshot
    // hint instead.
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
    // and the native-devtools-status description.
    expect(result.hint).toMatch(/`screenshot`/);
    expect(result.hint).toContain(NON_INJECTABLE_NATIVE_WARNING);
    // One of the agent-facing surfaces that must agree with the rest on HOW
    // certain the injectability claim is (see the cross-surface check in
    // native-devtools-status.test.ts): #453 saw the dylib fail to load on iOS
    // 26.5, an E2E run saw it succeed on 18.5, so no surface may claim
    // impossibility while all keep the terminal do-not-retry instruction.
    expect(result.hint).not.toMatch(/can never (be injected|load|inject)/);
    expect(result.hint).toMatch(/will NOT\s+help|cannot be relied on/);
  });

  it("keeps the degraded re-boot hint for a com.apple.* app when the ax-service is degraded", async () => {
    // When the sim was not booted through argent, the ax-service is degraded and
    // returns an empty tree, so describe reaches the non-injectable branch. Here
    // the empty tree is a fixable sim-config problem, not proof the system app is
    // undescribable: a proper `boot-device force=true` may let the ax-service
    // read this app's full tree. So the terminal "use screenshot" hint must NOT
    // clobber the re-boot guidance — otherwise the agent never learns its sim is
    // degraded (which affects every describe call). should_restart still stays
    // unset, so the restart loop remains broken.
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] }, { degraded: true });
    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: [],
      requiresRestart: true,
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
    // The degraded re-boot guidance wins over the terminal screenshot hint.
    expect(result.hint).toMatch(/boot-device/i);
    expect(result.hint).not.toContain(NON_INJECTABLE_NATIVE_WARNING);
  });

  it("returns the terminal hint for an explicit system app even when native-devtools is unavailable", async () => {
    // Injectability of an explicit bundleId is static, so the terminal hint
    // must not depend on the native-devtools service resolving (a downed
    // ios-remote tunnel or a dispose race would otherwise swallow it into the
    // generic catch and return no guidance at all).
    const axApi = makeAXServiceApi({ alertVisible: false, elements: [] });
    // No native devtools service provided — resolveService throws for it.
    const registry = makeMockRegistry({ axService: axApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.apple.Preferences" }
    );
    expect(result.source).toBe("ax-service");
    expect(result.should_restart).toBeUndefined();
    expect(result.hint).toContain(NON_INJECTABLE_NATIVE_WARNING);
  });

  it("returns the real AX tree for a non-injectable system app when AX is non-empty (early return, before the gate)", async () => {
    // The common case for a com.apple.* app: its accessibility tree is NON-empty
    // (Settings et al. expose a rich AX tree). describe must return that real
    // tree via the `tree.children.length > 0` early return, which is reached
    // BEFORE the injectability gate — the gate only guards the empty-tree native
    // fallback. If the gate were ever hoisted above the early return it would
    // silently replace a real system-app tree with the terminal screenshot hint;
    // the other non-injectable tests use an empty tree and would not catch that,
    // so this test is the guard for the populated-tree path.
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
    // requiresRestart:true mirrors a real com.apple.* app (it never connects);
    // it must stay irrelevant here because the non-empty tree returns before the
    // native fallback that would ever consult it.
    const nativeApi = makeNativeDevtoolsApi({
      connectedBundleIds: [],
      requiresRestart: true,
    });
    const registry = makeMockRegistry({ axService: axApi, nativeDevtools: nativeApi });
    const tool = createDescribeTool(registry);

    const result = await tool.execute(
      {},
      { udid: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", bundleId: "com.apple.Preferences" }
    );
    expect(result.source).toBe("ax-service");
    expect(result.should_restart).toBeUndefined();
    expect(result.description).toMatch(/AXButton\s+"General"/);
    expect(elementLineCount(result.description)).toBe(1);
    // The real tree must be returned untouched, with no terminal non-injectable
    // hint clobbering it — `hint` is the field the screenshot guidance lands in.
    expect(result.hint).toBeUndefined();
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
    // The third site that returns an empty tree after a failed corroboration —
    // its two siblings (the resolve catch and the outer catch) are both pinned,
    // and this one answered with an in-band error rather than throwing. Returned
    // bare, the empty tree reads as a blank screen, and `await-ui-element`'s
    // blind-read guard keys off exactly `hint` / `should_restart`: with neither
    // set, a `hidden` wait resolves against an element still on screen.
    expect(result.hint).toMatch(/not evidence that nothing is on screen/);
    expect(result.hint).toContain("view hierarchy unavailable");
    // Nothing was measured about the app, so no relaunch may be prescribed.
    expect(result.should_restart).toBeUndefined();
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
