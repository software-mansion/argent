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
    expect(error.message).toContain(
      "Flow selector steps auto-target and cannot provide a bundleId"
    );
    expect(error.message).toContain("to the foreground with launch-app");
    expect(error.message).toContain("terminate the other connected apps");
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
    expect(error.message).toContain("terminate any other connected app");
    expect(error.message).not.toContain("restart-app");
  });

  it("names restart-app (not launch-app) when the target loaded before instrumentation", async () => {
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
