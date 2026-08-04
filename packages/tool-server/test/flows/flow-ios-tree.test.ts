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
    expect(error.message).toContain("background or terminate the other connected apps");
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
    // Correct remedy: foreground it; it is already instrumented.
    expect(error.message).toContain("Bring that app to the foreground");
    expect(error.message).toContain("already instrumented");
    // Not the impossible advice, and not the misleading relaunch-for-instrumentation
    // narrative meant for the no-connected-app case.
    expect(error.message).not.toContain("Provide bundleId explicitly");
    expect(error.message).not.toContain("guarantees instrumentation");
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
