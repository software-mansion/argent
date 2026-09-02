import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type DeviceInfo,
  type Registry,
} from "@argent/registry";
import type { NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import type { DescribeNode } from "../../src/tools/describe/contract";
import {
  MAX_LISTED_APPS,
  MAX_TARGETING_REASON_CHARS,
  queryFullHierarchyTree,
} from "../../src/tools/flows/flow-ios-tree";
import { evaluateCondition, selectorToFrame } from "../../src/utils/ui-tree-match";
import { resolveNativeTargetApp } from "../../src/utils/native-target-app";
import {
  __resetDeviceSetCacheForTesting,
  deviceSetForUdid,
  rememberDeviceSet,
} from "../../src/utils/ios-device-sets";

// A pass-through spy, so the case below can count which reasons pay for the
// device-set lookup while every other case keeps the real memo.
vi.mock("../../src/utils/ios-device-sets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/ios-device-sets")>();
  return { ...actual, deviceSetForUdid: vi.fn(actual.deviceSetForUdid) };
});

const DEVICE = {
  id: "00000000-0000-0000-0000-0000000000ab",
  platform: "ios",
  kind: "simulator",
} as DeviceInfo;

function registryFor(api: Partial<NativeDevtoolsApi>): Registry {
  return {
    resolveService: vi.fn(async () => api),
  } as unknown as Registry;
}

// The udid to device-set memo is module state. Without this reset, a seeded
// `--set` prefix leaks into the next case.
afterEach(() => {
  __resetDeviceSetCacheForTesting();
});

describe("flow iOS full-hierarchy source", () => {
  it("requests enough hierarchy depth for deeply nested app content", async () => {
    // A real window, not `windows: []`: an empty list is a hard read failure,
    // indistinguishable from an uninjectable app.
    const queryViewHierarchy = vi.fn(async () => ({
      windows: [
        {
          className: "UIWindow",
          frame: { x: 0, y: 0, width: 400, height: 800 },
          windowFrame: { x: 0, y: 0, width: 400, height: 800 },
          children: [
            {
              className: "UIView",
              windowFrame: { x: 0, y: 0, width: 400, height: 800 },
              children: [],
            },
          ],
        },
      ],
    }));
    const api = {
      listConnectedBundleIds: () => ["com.example.app"],
      getAppState: vi.fn(async (bundleId: string) => ({
        bundleId,
        applicationState: "active",
        foregroundActiveSceneCount: 1,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 0,
        unattachedSceneCount: 0,
        isFrontmostCandidate: true,
      })),
      queryViewHierarchy,
    } as unknown as NativeDevtoolsApi;

    await queryFullHierarchyTree(registryFor(api), DEVICE);

    expect(queryViewHierarchy).toHaveBeenCalledWith(
      "com.example.app",
      "ViewHierarchy.getFullHierarchy",
      expect.objectContaining({ maxDepth: 100 })
    );
  });

  it("adapts and resolves a view buried deeper than the old 40-level cap", async () => {
    // A maxDepth of 100 proves nothing on its own: the device cap truncates.
    const DEEP = 45;
    const buildRaw = (maxDepth: number) => {
      // Innermost first, then wrap outward, so the leaf sits at depth `DEEP`.
      let node: Record<string, unknown> = {
        className: "UIButton",
        identifier: "deep-button",
        label: "Buy now",
        frame: { x: 100, y: 400, width: 200, height: 40 },
        windowFrame: { x: 100, y: 400, width: 200, height: 40 },
        children: [],
      };
      for (let depth = DEEP - 1; depth >= 1; depth--) {
        node = {
          className: "RNSScreenView",
          frame: { x: 0, y: 0, width: 400, height: 800 },
          windowFrame: { x: 0, y: 0, width: 400, height: 800 },
          // The device drops everything past the requested depth.
          children: depth < maxDepth ? [node] : [],
        };
      }
      return {
        windows: [
          {
            className: "UIWindow",
            frame: { x: 0, y: 0, width: 400, height: 800 },
            windowFrame: { x: 0, y: 0, width: 400, height: 800 },
            children: [node],
          },
        ],
      };
    };

    const apiWithCap = (deviceCap: number) =>
      ({
        listConnectedBundleIds: () => ["com.example.app"],
        getAppState: vi.fn(async (bundleId: string) => ({
          bundleId,
          applicationState: "active",
          foregroundActiveSceneCount: 1,
          foregroundInactiveSceneCount: 0,
          backgroundSceneCount: 0,
          unattachedSceneCount: 0,
          isFrontmostCandidate: true,
        })),
        queryViewHierarchy: vi.fn(async (_bundleId, _method, params) =>
          buildRaw(Math.min((params as { maxDepth: number }).maxDepth, deviceCap))
        ),
      }) as unknown as NativeDevtoolsApi;

    const { tree } = await queryFullHierarchyTree(registryFor(apiWithCap(DEEP)), DEVICE);
    expect(selectorToFrame(tree, { identifier: "deep-button" })).toBeDefined();

    // Sensitivity check: under the old cap the same fixture loses the view.
    const { tree: truncated } = await queryFullHierarchyTree(registryFor(apiWithCap(40)), DEVICE);
    expect(selectorToFrame(truncated, { identifier: "deep-button" })).toBeUndefined();
  });

  // A `card` container under RN wrappers, over labels at four depths, two of them
  // past the old cap of 40. Hoisting stops at the next identified node, so
  // everything below lands in the card's `subtreeText`.
  const hoistCardUnder = async (deviceCap: number): Promise<DescribeNode> => {
    const LABEL_AT = [20, 30, 41, 55];
    const buildRaw = (maxDepth: number) => {
      let node: Record<string, unknown> | null = null;
      for (let depth = 60; depth >= 1; depth--) {
        const children: Record<string, unknown>[] = [];
        if (node && depth < maxDepth) children.push(node);
        if (LABEL_AT.includes(depth) && depth < maxDepth) {
          children.push({
            className: "UILabel",
            label: `row-${depth}-content`,
            frame: { x: 0, y: 0, width: 400, height: 20 },
            windowFrame: { x: 0, y: 0, width: 400, height: 20 },
            children: [],
          });
        }
        node = {
          className: "RNSScreenView",
          ...(depth === 2 ? { identifier: "card" } : {}),
          frame: { x: 0, y: 0, width: 400, height: 800 },
          windowFrame: { x: 0, y: 0, width: 400, height: 800 },
          children,
        };
      }
      return {
        windows: [
          {
            className: "UIWindow",
            frame: { x: 0, y: 0, width: 400, height: 800 },
            windowFrame: { x: 0, y: 0, width: 400, height: 800 },
            children: [node as Record<string, unknown>],
          },
        ],
      };
    };
    const api = {
      listConnectedBundleIds: () => ["com.example.app"],
      getAppState: vi.fn(async (bundleId: string) => ({
        bundleId,
        applicationState: "active",
        foregroundActiveSceneCount: 1,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 0,
        unattachedSceneCount: 0,
        isFrontmostCandidate: true,
      })),
      queryViewHierarchy: vi.fn(async (_bundleId, _method, params) =>
        buildRaw(Math.min((params as { maxDepth: number }).maxDepth, deviceCap))
      ),
    } as unknown as NativeDevtoolsApi;

    const { tree } = await queryFullHierarchyTree(registryFor(api), DEVICE);
    const find = (node: DescribeNode): DescribeNode | undefined => {
      if (node.identifier === "card") return node;
      for (const child of node.children ?? []) {
        const inner = find(child);
        if (inner) return inner;
      }
      return undefined;
    };
    return find(tree)!;
  };

  it("hoists more text into an identified container as the cap admits more of it", async () => {
    // The cost of the raised cap, claimed by the `FLOW_TREE_MAX_DEPTH` docblock.
    // `assertReason`'s `text` arm quotes the hoisted subtreeText verbatim into a
    // failing reason, and nothing truncates it later.
    const shallow = (await hoistCardUnder(40)).subtreeText ?? "";
    const deep = (await hoistCardUnder(100)).subtreeText ?? "";

    expect(shallow).toContain("row-20-content");
    expect(shallow).not.toContain("row-41-content");
    expect(deep).toContain("row-41-content");
    expect(deep).toContain("row-55-content");
    expect(deep.length).toBeGreaterThan(shallow.length);
  });

  it("moves an `equals` text verdict against a container as the cap admits more of it", async () => {
    // `assert: { text: { in: { id: card }, equals: <hoist> } }` reads the
    // container's subtreeText, which now carries the deeper rows.
    // `evaluateCondition` also tries the node's own label and value, but a
    // testID'd wrapper has neither.
    const shallow = await hoistCardUnder(40);
    const deep = await hoistCardUnder(100);
    const asRecordedAt40 = shallow.subtreeText ?? "";

    expect(asRecordedAt40).toBe("row-30-content row-20-content");
    expect(deep.subtreeText).toBe("row-55-content row-41-content row-30-content row-20-content");

    // `contains` is the docblock's remedy for this, along with retargeting at the
    // leaf.
    expect(evaluateCondition("text", asRecordedAt40, [shallow], "equals")).toBe(true);
    expect(evaluateCondition("text", asRecordedAt40, [deep], "equals")).toBe(false);
    expect(evaluateCondition("text", asRecordedAt40, [deep], "contains")).toBe(true);
  });

  it("keeps native-target FailureError metadata while replacing impossible advice", async () => {
    const api = {
      listConnectedBundleIds: () => [] as string[],
      getAppState: vi.fn(),
    } as unknown as NativeDevtoolsApi;

    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(error).toBeInstanceOf(FailureError);
    expect(getFailureSignal(error)).toMatchObject({
      error_code: FAILURE_CODES.NATIVE_TARGET_NO_CONNECTED_APPS,
      failure_stage: "native_target_auto_resolve",
    });
    expect(error.message).not.toContain("provide bundleId explicitly");
    expect(error.message).toContain("restart-app");
    expect(error.message).toContain("com.apple.*");
    expect(error.message).toContain("raw point taps");
    // An injectable app launched outside Argent also reaches this branch, and the
    // native-* tools still work for it: the precheck throws only for com.apple.*,
    // and returns restart_required otherwise.
    expect(error.message).not.toContain("native-describe-screen");
    expect(error.message).not.toContain("Do not fall back to the native-devtools feature tools");
    // The wording covers the six tools that run the throwing 3-arg precheck.
    // "The native-* tools" would also cover native-devtools-status, which reports
    // injectable:false from the 2-arg form, and native-profiler-*, which never
    // prechecks.
    expect(error.message).toContain("the native-devtools feature tools refuse it too");
    expect(error.message).not.toContain("the native-* tools");
    // Trimming at the sentence break keeps the source's second sentence out of the
    // flow reason.
    expect(error.message).toContain(
      "(No native-devtools-connected apps are available for auto-targeting.)"
    );
  });

  it("preserves app diagnostics and gives relevant advice when auto-targeting is ambiguous", async () => {
    const api = {
      listConnectedBundleIds: () => ["com.example.second", "com.example.first"],
      getAppState: vi.fn(async (bundleId: string) => ({
        bundleId,
        applicationState: "background",
        foregroundActiveSceneCount: 0,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 1,
        unattachedSceneCount: 0,
        isFrontmostCandidate: false,
      })),
    } as unknown as NativeDevtoolsApi;

    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(error).toBeInstanceOf(FailureError);
    expect(getFailureSignal(error)).toMatchObject({
      error_code: FAILURE_CODES.NATIVE_TARGET_MULTIPLE_APPS_AMBIGUOUS,
      failure_stage: "native_target_auto_resolve",
    });
    expect(error.message).toContain("com.example.first (applicationState=background");
    expect(error.message).toContain("com.example.second (applicationState=background");
    // Only the trailing advice line is dropped. The strip is anchored at the end
    // of the message, not per line.
    const source = await resolveNativeTargetApp(api, undefined).catch((err) => err);
    expect(error.message).toContain(source.message.split("\n").slice(0, -1).join("\n"));
    expect(error.message).toContain("Flow selectors auto-target and cannot name a bundleId");
    expect(error.message).toContain("Foreground the intended app with launch-app");
    // argent has no terminate tool, and restart-app would bring the cleared app
    // back to the front.
    expect(error.message).toContain("xcrun simctl terminate <udid> <bundleId>");
    expect(error.message).toContain("argent has no terminate tool");
    // Backgrounding does not help: the apps stay connected and, once suspended,
    // cannot answer the state probe.
    expect(error.message).not.toContain("background or terminate");
    expect(error.message).not.toContain("Provide bundleId explicitly");
    expect(error.message).not.toContain("guarantees instrumentation");
  });

  it("tells a lone backgrounded app to foreground (not relaunch) and keeps its diagnostic", async () => {
    const api = {
      listConnectedBundleIds: () => ["com.example.solo"],
      getAppState: vi.fn(async (bundleId: string) => ({
        bundleId,
        applicationState: "background",
        foregroundActiveSceneCount: 0,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 1,
        unattachedSceneCount: 0,
        isFrontmostCandidate: false,
      })),
    } as unknown as NativeDevtoolsApi;

    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(error).toBeInstanceOf(FailureError);
    expect(getFailureSignal(error)).toMatchObject({
      error_code: FAILURE_CODES.NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND,
      failure_stage: "native_target_auto_resolve",
    });
    // Preserves the per-app applicationState diagnostic from resolveNativeTargetApp.
    expect(error.message).toContain("com.example.solo (applicationState=background");
    // launch-app foregrounds without terminating, so existing instrumentation
    // survives.
    expect(error.message).toContain("Bring that app to the foreground with launch-app");
    expect(error.message).toContain("already instrumented");
    // Not the impossible advice, and not the no-connected-app relaunch text.
    expect(error.message).not.toContain("Provide bundleId explicitly");
    expect(error.message).not.toContain("guarantees instrumentation");
  });

  it("does not call a suspended-but-connected app uninstrumented", async () => {
    // iOS suspends a backgrounded app within about 1s. The devtools socket stays
    // open, but Application.getState stops answering and the RPC times out.
    const api = {
      listConnectedBundleIds: () => ["com.example.solo"],
      getAppState: vi.fn(async () => {
        throw new FailureError("ViewInspector RPC timed out: Application.getState", {
          error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
          failure_stage: "native_devtools_rpc_request",
          failure_area: "tool_server",
          error_kind: "timeout",
        });
      }),
    } as unknown as NativeDevtoolsApi;

    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(getFailureSignal(error)).toMatchObject({
      error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
    });
    // The dotted identifier names the RPC that hung. Keying on a bare period used
    // to cut it off.
    expect(error.message).toContain("(ViewInspector RPC timed out: Application.getState)");
    expect(error.message).toContain("com.example.solo");
    // The app is instrumented, so relaunching it discards the flow's state.
    expect(error.message).toContain("do not relaunch");
    expect(error.message).toContain("launch-app");
    expect(error.message).not.toContain("guarantees instrumentation");
    expect(error.message).not.toContain("restart-app");
  });

  it("blames the unreadable connection, not the healthy frontmost app", async () => {
    // A second instrumented app, left suspended, fails the whole state probe even
    // though the flow's own app is frontmost and readable.
    const api = {
      listConnectedBundleIds: () => ["com.example.driven", "com.example.stale"],
      getAppState: vi.fn(async (bundleId: string) => {
        if (bundleId === "com.example.stale") {
          throw new FailureError("ViewInspector RPC timed out: Application.getState", {
            error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
            failure_stage: "native_devtools_rpc_request",
            failure_area: "tool_server",
            error_kind: "timeout",
          });
        }
        return {
          bundleId,
          applicationState: "active",
          foregroundActiveSceneCount: 1,
          foregroundInactiveSceneCount: 0,
          backgroundSceneCount: 0,
          unattachedSceneCount: 0,
          isFrontmostCandidate: true,
        };
      }),
    } as unknown as NativeDevtoolsApi;

    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(error.message).toContain("com.example.driven, com.example.stale");
    expect(error.message).toContain("xcrun simctl terminate <udid> <bundleId>");
    // These apps are instrumented, so relaunching one discards state and does not
    // fix the read.
    expect(error.message).not.toMatch(/Relaunch with restart-app/i);
    expect(error.message).toContain("do not relaunch");
  });

  it("addresses the terminate command to the device set the simulator lives in", async () => {
    // simctl scopes every operation to a single device set, so the bare command
    // cannot resolve a udid from a configured `ios.additionalDeviceSets` set, such
    // as a Radon IDE simulator.
    const RADON = "/Users/dev/Library/Caches/com.swmansion.radon-ide/Devices/iOS";
    rememberDeviceSet(DEVICE.id, RADON);
    const api = {
      listConnectedBundleIds: () => ["com.example.driven", "com.example.stale"],
      getAppState: vi.fn(rpcTimeout),
    } as unknown as NativeDevtoolsApi;

    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(error.message).toContain(`xcrun simctl --set ${RADON} terminate <udid> <bundleId>`);

    // The ambiguous branch offers the same command.
    const ambiguous = {
      listConnectedBundleIds: () => ["com.example.driven", "com.example.stale"],
      getAppState: vi.fn(async (bundleId: string) =>
        appState(bundleId, {
          applicationState: "background",
          isFrontmostCandidate: false,
          foregroundActiveSceneCount: 0,
          backgroundSceneCount: 1,
        })
      ),
    } as unknown as NativeDevtoolsApi;

    const ambiguousError = await queryFullHierarchyTree(registryFor(ambiguous), DEVICE).catch(
      (err) => err
    );

    expect(ambiguousError.message).toContain(
      `xcrun simctl --set ${RADON} terminate <udid> <bundleId>`
    );
  });

  // One entry per failure branch of `queryFullHierarchyTree`, iterated by the
  // length guard below. The bundle ids are long on purpose, so the measured
  // budget holds for real ones.
  //
  // `launched` covers the branch auto-targeting never reaches: a flow that ran a
  // `launch:` step passes that id down, and with nothing connected the read fails
  // through `unreadableHierarchyReason`. Those entries hold the longest reason
  // (`unregistered`, 775 chars) and the branch the recorder takes, since
  // `captureTapSelector` passes a launched id on every captured tap.
  const LONG_ID = "com.example.enterprise.mobile.client";
  const rpcTimeout = (): never => {
    throw new FailureError("ViewInspector RPC timed out: Application.getState", {
      error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
      failure_stage: "native_devtools_rpc_request",
      failure_area: "tool_server",
      error_kind: "timeout",
    });
  };
  const appState = (bundleId: string, over: Record<string, unknown> = {}) => ({
    bundleId,
    applicationState: "active",
    foregroundActiveSceneCount: 1,
    foregroundInactiveSceneCount: 0,
    backgroundSceneCount: 0,
    unattachedSceneCount: 0,
    isFrontmostCandidate: true,
    ...over,
  });
  const notFrontmost = { applicationState: "background", isFrontmostCandidate: false } as const;

  const targetingFailures = (
    appCount: number
  ): { branch: string; api: NativeDevtoolsApi; launched?: string }[] => {
    const ids = Array.from({ length: appCount }, (_, i) => `${LONG_ID}${i}`);
    // Nothing connected plus a launched id is the only shape that reaches
    // `unreadableHierarchyReason`. One entry per state it diagnoses.
    const launchGone = (
      state: string,
      bundleId = ids[0],
      label = state
    ): { branch: string; api: NativeDevtoolsApi; launched?: string } => ({
      branch: `launched app not connected: ${label}`,
      api: {
        listConnectedBundleIds: () => [] as string[],
        appConnectionState: vi.fn(async () => state),
        getAppState: vi.fn(),
      } as unknown as NativeDevtoolsApi,
      launched: bundleId,
    });
    return [
      {
        branch: "ambiguous connected set",
        api: {
          listConnectedBundleIds: () => ids,
          getAppState: vi.fn(async (b: string) =>
            appState(b, { ...notFrontmost, foregroundActiveSceneCount: 0, backgroundSceneCount: 1 })
          ),
        } as unknown as NativeDevtoolsApi,
      },
      {
        branch: "single app not foreground",
        api: {
          listConnectedBundleIds: () => [ids[0]],
          getAppState: vi.fn(async (b: string) =>
            appState(b, { ...notFrontmost, foregroundActiveSceneCount: 0, backgroundSceneCount: 1 })
          ),
        } as unknown as NativeDevtoolsApi,
      },
      {
        branch: "state probe failed, connections live",
        api: {
          listConnectedBundleIds: () => ids,
          getAppState: vi.fn(rpcTimeout),
        } as unknown as NativeDevtoolsApi,
      },
      {
        branch: "no connected app",
        api: {
          listConnectedBundleIds: () => [] as string[],
          getAppState: vi.fn(),
        } as unknown as NativeDevtoolsApi,
      },
      {
        branch: "target dropped its connection",
        api: (() => {
          let connected = [ids[0]];
          return {
            listConnectedBundleIds: () => {
              const now = connected;
              connected = [];
              return now;
            },
            getAppState: vi.fn(async (b: string) => appState(b)),
          } as unknown as NativeDevtoolsApi;
        })(),
      },
      {
        branch: "no windows",
        api: {
          listConnectedBundleIds: () => [ids[0]],
          getAppState: vi.fn(async (b: string) => appState(b)),
          queryViewHierarchy: vi.fn(async () => ({ windows: [] })),
        } as unknown as NativeDevtoolsApi,
      },
      {
        branch: "getFullHierarchy errored",
        api: {
          listConnectedBundleIds: () => [ids[0]],
          getAppState: vi.fn(async (b: string) => appState(b)),
          queryViewHierarchy: vi.fn(async () => ({ error: "serializer busy" })),
        } as unknown as NativeDevtoolsApi,
      },
      ...["not_running", "stale_process", "connecting", "indeterminate", "unregistered"].map(
        (state) => launchGone(state)
      ),
      // Two branches answer before the state switch: a connection that arrived
      // mid-read, and a bundle the dylib may not load into.
      launchGone("connected"),
      launchGone("not_running", "com.apple.Preferences", "non-injectable bundle"),
    ];
  };

  it("keeps every targeting reason short enough to repeat per step", async () => {
    // The recorder embeds this reason in the warning for each captured tap, and a
    // failing `await` repeats it once per poll. At about 900 characters, one
    // stuck screen made the recorder the largest context consumer of a session.
    for (const { branch, api, launched } of targetingFailures(2)) {
      // Unpinned: these branches are auto-targeting's, and a launched id is only
      // the hint auto-resolve falls back to.
      const error = await queryFullHierarchyTree(
        registryFor(api),
        DEVICE,
        launched ? { bundleId: launched, pinned: false, probeAnswered: false } : undefined
      ).catch((err) => err);
      expect(`${branch}: ${error.message.length}`).toBe(
        `${branch}: ${Math.min(error.message.length, MAX_TARGETING_REASON_CHARS)}`
      );
    }
    // The service-unresolvable wrap never reaches an api, so it is built here.
    const unresolvable = await queryFullHierarchyTree(
      {
        resolveService: vi.fn(async () => {
          throw new Error("no simulator-server for 0000…00ab");
        }),
      } as unknown as Registry,
      DEVICE
    ).catch((err) => err);
    expect(unresolvable.message.length).toBeLessThanOrEqual(MAX_TARGETING_REASON_CHARS);
  });

  it("resolves the device set only for a reason that offers the terminate command", async () => {
    // With additional sets configured, a default-set udid matches none of them,
    // so `deviceSetForUdid` caches no verdict and re-runs the whole
    // `simctl list devices` sweep on every call. Building the command up front
    // charged that to every branch, including the four that never quote it - and
    // a failing `await:` rebuilds its reason once per poll.
    const lookups = vi.mocked(deviceSetForUdid);
    // One connection covers the sub-case with nothing to clear: the probe-failure
    // branch offers the command only when a second app is connected.
    for (const appCount of [1, 2]) {
      for (const { branch, api, launched } of targetingFailures(appCount)) {
        lookups.mockClear();
        const error = await queryFullHierarchyTree(
          registryFor(api),
          DEVICE,
          launched ? { bundleId: launched, pinned: false, probeAnswered: false } : undefined
        ).catch((err) => err);
        const quotesCommand = error.message.includes("xcrun simctl");
        expect(`${branch} x${appCount}: ${lookups.mock.calls.length}`).toBe(
          `${branch} x${appCount}: ${quotesCommand ? 1 : 0}`
        );
      }
    }
  });

  it("keeps the reason the same size as connections pile up", async () => {
    // The device must not be able to spend the budget. Both list-bearing branches
    // used to grow per app: the ambiguous one measured 778, 1000 and 1444 chars at
    // 2, 4 and 8 apps.
    for (const branch of ["ambiguous connected set", "state probe failed, connections live"]) {
      const lengths = await Promise.all(
        [2, 4, 16].map(async (appCount) => {
          const { api } = targetingFailures(appCount).find((f) => f.branch === branch)!;
          const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);
          return error.message.length as number;
        })
      );
      // Not byte-identical: the "(+N more)" count gains a digit. Four more
      // connections cost one digit, not four lines of about 110 characters.
      expect(`${branch}: ${lengths[2] - lengths[1] < 5}`).toBe(`${branch}: true`);
      expect(lengths[2]).toBeLessThanOrEqual(MAX_TARGETING_REASON_CHARS);
    }
  });

  it("reports nothing withheld when the connected set is exactly at the cap", async () => {
    // The boundary both cap helpers turn on. Away from it, `<=` and `<` behave the
    // same. With `<`, a list that dropped nothing still gets "(+0 more)".
    for (const { branch, api } of targetingFailures(MAX_LISTED_APPS)) {
      if (branch !== "ambiguous connected set" && branch !== "state probe failed, connections live")
        continue;
      const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

      for (let i = 0; i < MAX_LISTED_APPS; i++) {
        expect(`${branch}: ${error.message.includes(`${LONG_ID}${i}`)}`).toBe(`${branch}: true`);
      }
      expect(`${branch}: ${/\(\+\d+ more/.test(error.message)}`).toBe(`${branch}: false`);
    }
  });

  it("says how many connected apps a capped reason left out", async () => {
    const { api } = targetingFailures(5).find((f) => f.branch === "ambiguous connected set")!;
    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(error.message).toContain(`${LONG_ID}0 (applicationState=background`);
    expect(error.message).toContain(`${LONG_ID}1 (applicationState=background`);
    expect(error.message).not.toContain(`${LONG_ID}2 (`);
    expect(error.message).toContain("(+3 more connected apps)");

    const probe = targetingFailures(5).find(
      (f) => f.branch === "state probe failed, connections live"
    )!;
    const probeError = await queryFullHierarchyTree(registryFor(probe.api), DEVICE).catch(
      (err) => err
    );
    expect(probeError.message).toContain(`Connected: ${LONG_ID}0, ${LONG_ID}1 (+3 more).`);
  });

  it("reports an unresolvable native-devtools service and keeps the original error", async () => {
    const cause = new Error("no simulator-server for 0000…00ab");
    const registry = {
      resolveService: vi.fn(async () => {
        throw cause;
      }),
    } as unknown as Registry;

    const error = await queryFullHierarchyTree(registry, DEVICE).catch((err) => err);

    expect(error.message).toContain("native devtools is unavailable");
    expect(error.message).toContain("no simulator-server for 0000…00ab");
    // A plain Error carries no failure signal, so the wrapper stays a plain Error
    // rather than inventing one.
    expect(error).not.toBeInstanceOf(FailureError);
    expect(error.cause).toBe(cause);
  });

  it("keeps the original error as the cause of a wrapped targeting failure", async () => {
    const api = {
      listConnectedBundleIds: () => [] as string[],
      getAppState: vi.fn(),
    } as unknown as NativeDevtoolsApi;

    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(error.cause).toBeInstanceOf(FailureError);
    // The rendered message keeps only the source's first sentence. The cause keeps
    // the full text.
    expect((error.cause as Error).message).toContain("provide bundleId explicitly");
    expect(error.message).not.toContain("provide bundleId explicitly");
  });

  it("reports a dropped connection, not a pre-instrumentation launch, when the target needs a restart", async () => {
    // Auto-resolution only yields ids from `listConnectedBundleIds()`, so a target
    // missing from that map later means the socket dropped between the resolve and
    // the read. The mock is connected for the resolve and gone by the re-read.
    let connected = ["com.example.app"];
    const api = {
      listConnectedBundleIds: () => {
        const now = connected;
        connected = [];
        return now;
      },
      getAppState: vi.fn(async (bundleId: string) => ({
        bundleId,
        applicationState: "active",
        foregroundActiveSceneCount: 1,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 0,
        unattachedSceneCount: 0,
        isFrontmostCandidate: true,
      })),
    } as unknown as NativeDevtoolsApi;

    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("com.example.app answered the target probe and then dropped");
    // The app was instrumented, so the message names the retry before the
    // relaunch.
    expect(error.message).toContain("It was instrumented");
    expect(error.message).toContain("a retry may ride this out");
    expect(error.message).not.toContain("launched before argent's instrumentation loaded");
    expect(error.message).toContain("relaunch with restart-app");
    expect(error.message).not.toContain("launch-app, or a flow");
  });
});
