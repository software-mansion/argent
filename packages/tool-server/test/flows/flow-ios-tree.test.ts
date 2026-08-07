import { describe, expect, it, vi } from "vitest";
import {
  FAILURE_CODES,
  FailureError,
  getFailureSignal,
  type DeviceInfo,
  type Registry,
} from "@argent/registry";
import type { NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import { queryFullHierarchyTree } from "../../src/tools/flows/flow-ios-tree";
import { selectorToFrame } from "../../src/utils/ui-tree-match";
import { resolveNativeTargetApp } from "../../src/utils/native-target-app";

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

describe("flow iOS full-hierarchy source", () => {
  it("requests enough hierarchy depth for deeply nested app content", async () => {
    // A real window, not `windows: []` — an empty list is now a hard read
    // failure (it cannot be told from an uninjectable app), and this test is
    // about the depth the query ASKS for, not about the no-windows path.
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
      requiresAppRestart: vi.fn(async () => false),
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
    // The claim the raised cap rests on: a view at depth 41+ must survive the
    // query, survive adaptation, and be reachable by an `id:` selector. Asking
    // for maxDepth 100 proves nothing on its own — the device is what truncates.
    const DEEP = 45;
    const buildRaw = (maxDepth: number) => {
      // Innermost first, then wrap outward, so the leaf sits at depth DEEP.
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
          // The device drops everything past the requested depth; below the cap
          // the wrapper keeps its subtree.
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
        requiresAppRestart: vi.fn(async () => false),
        queryViewHierarchy: vi.fn(async (_bundleId, _method, params) =>
          buildRaw(Math.min((params as { maxDepth: number }).maxDepth, deviceCap))
        ),
      }) as unknown as NativeDevtoolsApi;

    const { tree } = await queryFullHierarchyTree(registryFor(apiWithCap(DEEP)), DEVICE);
    expect(selectorToFrame(tree, { identifier: "deep-button" })).toBeDefined();

    // Sensitivity check: the same fixture read under the old cap loses it, so a
    // pass above is the depth doing the work and not the fixture being shallow.
    const { tree: truncated } = await queryFullHierarchyTree(registryFor(apiWithCap(40)), DEVICE);
    expect(selectorToFrame(truncated, { identifier: "deep-button" })).toBeUndefined();
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
    // An injectable app simply launched outside Argent also lands here, and for
    // it the native-* tools do NOT dead-end — the injection precheck throws the
    // non-injectable error only for com.apple.*, and returns restart_required
    // otherwise. So that blanket warning must not ride along.
    expect(error.message).not.toContain("native-describe-screen");
    expect(error.message).not.toContain("Do not fall back to the native-devtools feature tools");
    // The clause is trimmed at the sentence break, so the impossible advice in
    // the source's SECOND sentence never reaches the flow reason.
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
    // Only the TRAILING advice line is dropped; every other line of the source
    // diagnostic survives verbatim. Anchoring the strip per-line instead of at
    // the end of the message would start eating the middle of it.
    const source = await resolveNativeTargetApp(api, undefined).catch((err) => err);
    expect(error.message).toContain(source.message.split("\n").slice(0, -1).join("\n"));
    expect(error.message).toContain(
      "Flow selector steps auto-target and cannot provide a bundleId"
    );
    expect(error.message).toContain("to the foreground with launch-app");
    // Clearing the other apps has to name something the agent can actually run:
    // argent exposes no terminate tool, and restart-app would bring the very app
    // being cleared back to the front.
    expect(error.message).toContain("xcrun simctl terminate <udid> <bundleId>");
    expect(error.message).toContain("argent exposes no terminate tool");
    // Backgrounding is the wrong half of that advice — it leaves them connected
    // and, once suspended, unable to answer the state probe at all.
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
    // Correct remedy, and the tool that performs it: launch-app foregrounds
    // without terminating, so the instrumentation the app already has survives.
    expect(error.message).toContain("Bring that app to the foreground with launch-app");
    expect(error.message).toContain("already instrumented");
    // Not the impossible advice, and not the misleading relaunch-for-instrumentation
    // narrative meant for the no-connected-app case.
    expect(error.message).not.toContain("Provide bundleId explicitly");
    expect(error.message).not.toContain("guarantees instrumentation");
  });

  it("does not call a suspended-but-connected app uninstrumented", async () => {
    // iOS suspends a backgrounded app within ~1s; its devtools socket stays
    // open but Application.getState stops answering and the RPC times out.
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
    // The dotted identifier is the actionable half of the clause — it names the
    // RPC that hung, and keying the clause on a bare period used to chop it.
    expect(error.message).toContain("(ViewInspector RPC timed out: Application.getState)");
    expect(error.message).toContain("com.example.solo");
    // The app IS instrumented: relaunching it throws the flow's state away.
    expect(error.message).toContain("do not relaunch");
    expect(error.message).toContain("launch-app");
    expect(error.message).not.toContain("guarantees instrumentation");
    expect(error.message).not.toContain("restart-app");
  });

  it("blames the unreadable connection, not the healthy frontmost app", async () => {
    // A second instrumented app left suspended rejects the whole state probe,
    // even though the app the flow drives is frontmost and readable — so
    // relaunching the flow's own target could never fix it.
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
    // restart-app may only appear as the thing NOT to reach for: these apps are
    // instrumented, so relaunching one discards state and cannot fix the read.
    expect(error.message).not.toMatch(/Relaunch with restart-app/i);
    expect(error.message).toContain("do not relaunch");
  });

  it("keeps every targeting reason short enough to repeat per step", async () => {
    // The recorder embeds this reason in the warning for EVERY captured tap
    // while the read is failing, and a failing `await` repeats it once per
    // poll. A reason that ran to ~900 characters made the recorder the
    // session's largest context consumer for a single stuck screen.
    const backgrounded = {
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
    const disconnected = {
      listConnectedBundleIds: () => [] as string[],
      getAppState: vi.fn(),
    } as unknown as NativeDevtoolsApi;

    for (const api of [backgrounded, disconnected]) {
      const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);
      expect(error.message.length).toBeLessThan(600);
    }
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
    // A plain Error carries no failure signal, so the wrapper must stay a plain
    // Error rather than inventing one — but the cause still has to survive.
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
    // The rendered message trims the source down to its first sentence; the
    // untrimmed original is only reachable through the cause.
    expect((error.cause as Error).message).toContain("provide bundleId explicitly");
    expect(error.message).not.toContain("provide bundleId explicitly");
  });

  it("names restart-app (not launch-app) when the target loaded before instrumentation", async () => {
    // NOTE: the mock forces a state the live service cannot reach for an
    // auto-resolved target — requiresAppRestart returns false for every
    // connected bundle id, and auto-resolution only ever yields connected ones.
    // This pins the message's wording, not that the branch fires in practice.
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
      requiresAppRestart: vi.fn(async () => true),
    } as unknown as NativeDevtoolsApi;

    const error = await queryFullHierarchyTree(registryFor(api), DEVICE).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("com.example.app was launched before argent's instrumentation");
    expect(error.message).toContain("restart-app");
    expect(error.message).toContain("Only restart-app (terminate + relaunch)");
    expect(error.message).not.toContain("launch-app, or a flow");
  });
});
