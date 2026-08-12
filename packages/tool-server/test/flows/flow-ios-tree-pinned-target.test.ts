import { describe, it, expect } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
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
 * times out; records state probes, hierarchy reads, and env-repair calls
 * (requiresAppRestart / reverifyEnv). `connected` overrides the connection set
 * to model a dropped pin.
 */
function poisonedApi(connected: string[] = [APP, POISONER]) {
  const probed: string[] = [];
  const queried: string[] = [];
  const repaired: string[] = [];
  const api = {
    listConnectedBundleIds: () => [...connected],
    isConnected: (id: string) => connected.includes(id),
    getAppState: async (id: string) => {
      probed.push(id);
      if (id === POISONER) {
        throw new Error("ViewInspector RPC timed out: Application.getState");
      }
      return appState(id);
    },
    requiresAppRestart: async (id: string) => {
      repaired.push(`requiresAppRestart:${id}`);
      if (connected.includes(id)) return false;
      // The real miss path runs a full reverifyEnv before returning true.
      repaired.push("reverifyEnv");
      return true;
    },
    reverifyEnv: async () => {
      repaired.push("reverifyEnv");
    },
    queryViewHierarchy: async (id: string) => {
      queried.push(id);
      return { windows: [windowSpanning()] };
    },
  } as unknown as NativeDevtoolsApi;
  return { api, probed, queried, repaired };
}

function registryFor(api: NativeDevtoolsApi): Registry {
  return {
    resolveService: async () => api,
  } as unknown as Registry;
}

describe("queryFullHierarchyTree - pinned target vs poisoned auto-resolve", () => {
  it("a pinned read skips the getState fan-out and reads the pinned app", async () => {
    const { api, probed, queried, repaired } = poisonedApi();
    const { tree, source } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, APP);
    expect(source).toBe("native-devtools");
    expect(tree.children.length).toBeGreaterThan(0);
    expect(probed).toEqual([]);
    expect(queried).toEqual([APP]);
    expect(repaired).toEqual([]);
  });

  it("a pinned read of a dropped connection names the drop and runs no env repair", async () => {
    // The pin was connected at launch; the app then crashed / was killed and
    // its socket close removed it from the connection set.
    const { api, queried, repaired } = poisonedApi([POISONER]);
    const err: unknown = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, APP).then(
      () => {
        throw new Error("expected the dropped-pin read to throw");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`${APP} lost its devtools connection after launch`);
    // Not the stale-instrumentation diagnosis - the launch gate proved the
    // instrumentation loaded, so blaming it would point away from the crash.
    expect(message).not.toMatch(/instrumentation loaded/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED);
    // A dead pin is re-read every 300ms poll; requiresAppRestart's miss path
    // would run a full reverifyEnv per poll and latch the device's give-up
    // after three failures, so the pinned path must never invoke either.
    expect(repaired).toEqual([]);
    expect(queried).toEqual([]);
  });

  it("an unpinned read still fans out and is sunk by the poisoned sibling", async () => {
    const { api, probed } = poisonedApi();
    await expect(queryFullHierarchyTree(registryFor(api), IOS_DEVICE)).rejects.toThrow(
      /RPC timed out/i
    );
    expect(probed).toContain(POISONER);
  });
});
