import { describe, it, expect } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import { queryFullHierarchyTree } from "../../src/tools/flows/flow-ios-tree";

// A getFullHierarchy read that returns no windows is the signal of an untrusted
// read — a non-injectable target (an Apple system app the frontmost resolver
// still picked), a backgrounded app, or a window that has not attached yet.
// The flow tree source must THROW there rather than hand back an empty tree:
// an empty tree is the one thing a `hidden`/absent check accepts as satisfied,
// so degrading to it turns a non-injectable target into a false green pass.

const IOS_DEVICE = {
  id: "00000000-0000-0000-0000-0000000000ab",
  platform: "ios",
} as unknown as DeviceInfo;

const APP = "com.example.app";

function appState(bundleId: string): NativeAppState {
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

/**
 * Minimal NativeDevtoolsApi: one connected, foreground app; `queryViewHierarchy`
 * returns whatever `hierarchy` yields (called with the resolved bundleId).
 */
function nativeApi(hierarchy: () => unknown, bundleId = APP): NativeDevtoolsApi {
  return {
    listConnectedBundleIds: () => [bundleId],
    getAppState: async (id: string) => appState(id),
    requiresAppRestart: async () => false,
    queryViewHierarchy: async () => hierarchy(),
  } as unknown as NativeDevtoolsApi;
}

function registryFor(api: NativeDevtoolsApi): Registry {
  return {
    resolveService: async () => api,
  } as unknown as Registry;
}

function windowSpanning() {
  return {
    className: "UIWindow",
    frame: { x: 0, y: 0, width: 400, height: 800 },
    windowFrame: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      {
        className: "RCTView",
        identifier: "root",
        windowFrame: { x: 0, y: 0, width: 400, height: 800 },
        children: [],
      },
    ],
  };
}

describe("queryFullHierarchyTree — untrusted (no windows) reads", () => {
  it("throws when the target returns an empty windows array", async () => {
    const registry = registryFor(nativeApi(() => ({ windows: [] })));
    await expect(queryFullHierarchyTree(registry, IOS_DEVICE)).rejects.toThrow(
      /returned no windows for com\.example\.app/i
    );
  });

  it("throws when the payload carries no windows field at all", async () => {
    const registry = registryFor(nativeApi(() => ({})));
    await expect(queryFullHierarchyTree(registry, IOS_DEVICE)).rejects.toThrow(/no windows/i);
  });

  it("returns a tree when windows are present", async () => {
    const registry = registryFor(nativeApi(() => ({ windows: [windowSpanning()] })));
    const { tree, source } = await queryFullHierarchyTree(registry, IOS_DEVICE);
    expect(source).toBe("native-devtools");
    expect(tree.children.length).toBeGreaterThan(0);
  });

  it("still throws on an explicit getFullHierarchy error (unchanged)", async () => {
    const registry = registryFor(nativeApi(() => ({ error: "hierarchy walk failed" })));
    await expect(queryFullHierarchyTree(registry, IOS_DEVICE)).rejects.toThrow(
      /getFullHierarchy failed.*hierarchy walk failed/i
    );
  });
});
