import { describe, it, expect } from "vitest";
import type { DeviceInfo, Registry } from "@argent/registry";
import type { NativeAppState, NativeDevtoolsApi } from "../../src/blueprints/native-devtools";
import { queryFullHierarchyTree } from "../../src/tools/flows/flow-ios-tree";

// Simulator-wide injection means background system processes also connect,
// and a suspended one never answers getState - auto-resolve Promise.alls
// getState over every connection, so one such sibling fails every read while
// the app under test is healthy. A pinned read must never touch that fan-out.

const IOS_DEVICE = {
  id: "00000000-0000-0000-0000-0000000000ab",
  platform: "ios",
} as unknown as DeviceInfo;

const APP = "com.example.app";
const POISONER = "com.apple.mobilecal";

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

/**
 * The healthy app under test plus a poisoned sibling whose getState only ever
 * times out; records state probes and hierarchy reads.
 */
function poisonedApi() {
  const probed: string[] = [];
  const queried: string[] = [];
  const api = {
    listConnectedBundleIds: () => [APP, POISONER],
    getAppState: async (id: string) => {
      probed.push(id);
      if (id === POISONER) {
        throw new Error("ViewInspector RPC timed out: Application.getState");
      }
      return appState(id);
    },
    requiresAppRestart: async () => false,
    queryViewHierarchy: async (id: string) => {
      queried.push(id);
      return { windows: [windowSpanning()] };
    },
  } as unknown as NativeDevtoolsApi;
  return { api, probed, queried };
}

function registryFor(api: NativeDevtoolsApi): Registry {
  return {
    resolveService: async () => api,
  } as unknown as Registry;
}

describe("queryFullHierarchyTree - pinned target vs poisoned auto-resolve", () => {
  it("a pinned read skips the getState fan-out and reads the pinned app", async () => {
    const { api, probed, queried } = poisonedApi();
    const { tree, source } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, APP);
    expect(source).toBe("native-devtools");
    expect(tree.children.length).toBeGreaterThan(0);
    expect(probed).toEqual([]);
    expect(queried).toEqual([APP]);
  });

  it("an unpinned read still fans out and is sunk by the poisoned sibling", async () => {
    const { api, probed } = poisonedApi();
    await expect(queryFullHierarchyTree(registryFor(api), IOS_DEVICE)).rejects.toThrow(
      /RPC timed out/i
    );
    expect(probed).toContain(POISONER);
  });
});
