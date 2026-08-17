import { describe, it, expect } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  NON_INJECTABLE_NATIVE_WARNING,
  type NativeAppState,
  type NativeDevtoolsApi,
} from "../../src/blueprints/native-devtools";
import type { FlowTreeTarget } from "../../src/tools/flows/flow-actions";
import { queryFullHierarchyTree } from "../../src/tools/flows/flow-ios-tree";

// Simulator-wide injection means background system processes also connect,
// and a suspended one never answers getState - auto-resolve Promise.alls
// getState over every connection, so one such sibling fails every read while
// the app under test is healthy. A pinned read probes ONLY the pinned app
// (to prove it is still frontmost), never a sibling.
//
// The second describe covers the other confidence level: an UNPINNED target
// (what a foreground-neutral `tool:` step leaves behind). Auto-resolution
// still decides, and the target is consulted solely as a TIMEOUT ARBITER -
// only when the fan-out times out AND the target's connection is still up.
// Every answered resolution, including the deliberate "single app but
// backgrounded" error, wins over it, so no foreground guard is ever bypassed.

const IOS_DEVICE = {
  id: "00000000-0000-0000-0000-0000000000ab",
  platform: "ios",
} as unknown as DeviceInfo;

const APP = "com.example.app";
const POISONER = "com.apple.mobilecal";
const OTHER = "com.example.other";

const pin = (bundleId: string): FlowTreeTarget => ({ bundleId, pinned: true });
const hint = (bundleId: string): FlowTreeTarget => ({ bundleId, pinned: false });

/** What the wedged sibling's `Application.getState` really rejects with. */
function rpcTimeout(): FailureError {
  return new FailureError("ViewInspector RPC timed out: Application.getState", {
    error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT,
    failure_stage: "native_devtools_rpc_request",
    failure_area: "tool_server",
    error_kind: "timeout",
  });
}

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
 * to model a dropped pin; `states` overrides per-app state to model a
 * backgrounded pin; `probeFailures` makes an app's own getState throw.
 */
function poisonedApi(
  connected: string[] = [APP, POISONER],
  states: Record<string, NativeAppState> = {},
  probeFailures: Record<string, Error> = {}
) {
  const probed: string[] = [];
  const queried: string[] = [];
  const repaired: string[] = [];
  const api = {
    listConnectedBundleIds: () => [...connected],
    isConnected: (id: string) => connected.includes(id),
    getAppState: async (id: string) => {
      probed.push(id);
      if (probeFailures[id]) {
        throw probeFailures[id];
      }
      if (id === POISONER) {
        throw rpcTimeout();
      }
      return states[id] ?? appState(id);
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
  it("a pinned read probes only the pinned app - the poisoned sibling is never touched", async () => {
    const { api, probed, queried, repaired } = poisonedApi();
    const { tree, source } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, pin(APP));
    expect(source).toBe("native-devtools");
    expect(tree.children.length).toBeGreaterThan(0);
    // The frontmost check probes the pinned app itself and nothing else - a
    // sibling probe would reintroduce the fan-out failure the pin avoids.
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
    expect(repaired).toEqual([]);
  });

  it("a pinned read of a backgrounded app refuses to describe an off-screen hierarchy", async () => {
    // The pin bypasses auto-resolve's frontmost guard, so the pinned path must
    // re-check it: connected-but-backgrounded means something (a tap into
    // another app, home) left the app, and its hierarchy is not what's on
    // screen.
    const backgrounded: NativeAppState = {
      bundleId: APP,
      applicationState: "background",
      foregroundActiveSceneCount: 0,
      foregroundInactiveSceneCount: 0,
      backgroundSceneCount: 1,
      unattachedSceneCount: 0,
      isFrontmostCandidate: false,
    };
    const { api, probed, queried, repaired } = poisonedApi([APP, POISONER], {
      [APP]: backgrounded,
    });
    const err: unknown = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, pin(APP)).then(
      () => {
        throw new Error("expected the backgrounded-pin read to throw");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`${APP} (the launched app) is not foreground-like`);
    expect(message).toContain("applicationState=background");
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND
    );
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([]);
    expect(repaired).toEqual([]);
  });

  it("a pinned read rides out a frontmost probe the stalled main thread cannot answer", async () => {
    // Application.getState hops onto the app's main thread, which a heavy cold
    // start (first Hermes parse, asset decode) can pin past the RPC timeout. An
    // unanswerable probe is not an answer of "backgrounded", and the pin names
    // the app this run launched, so the read goes ahead instead of failing the
    // step.
    const { api, probed, queried } = poisonedApi([APP, POISONER], {}, { [APP]: rpcTimeout() });
    const { tree } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, pin(APP));
    expect(tree.children.length).toBeGreaterThan(0);
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
  });

  it("a pinned read propagates a frontmost probe failure that is not a timeout", async () => {
    // Only a stall is ridden out; anything the probe actually reports is a
    // failure the read must not paper over.
    const { api, queried } = poisonedApi(
      [APP, POISONER],
      {},
      {
        [APP]: new FailureError("boom", {
          error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_ERROR,
          failure_stage: "native_devtools_rpc_response",
          failure_area: "tool_server",
          error_kind: "subprocess",
        }),
      }
    );
    await expect(queryFullHierarchyTree(registryFor(api), IOS_DEVICE, pin(APP))).rejects.toThrow(
      /boom/
    );
    expect(queried).toEqual([]);
  });

  it("a pinned read of a dropped connection names the drop and runs no env repair", async () => {
    // The pin was connected at launch; the app then crashed / was killed and
    // its socket close removed it from the connection set.
    const { api, queried, repaired } = poisonedApi([POISONER]);
    const err: unknown = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, pin(APP)).then(
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

  it("a pinned read of an Apple system app is refused before any RPC is spent", async () => {
    // A flow `launch:` can name a system app: restart-app runs the 2-arg
    // precheck (no bundleId, no throw) and the launch gate only waits for
    // isConnected, which simulator-wide injection lets a background system
    // process satisfy - so the pin lands here. The refusal must be terminal
    // and free, not a 5s getState probe plus a 15s getFullHierarchy timeout
    // surfacing as "RPC timed out".
    const { api, probed, queried, repaired } = poisonedApi([POISONER]);
    const err: unknown = await queryFullHierarchyTree(
      registryFor(api),
      IOS_DEVICE,
      pin(POISONER)
    ).then(
      () => {
        throw new Error("expected the system-app pin to be refused");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`${POISONER} is an Apple system app`);
    expect(message).toContain("never a valid flow target");
    expect(message).toContain(NON_INJECTABLE_NATIVE_WARNING);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_tree_pinned_target");
    // The substance of the refusal: no RPC was touched at all.
    expect(probed).toEqual([]);
    expect(queried).toEqual([]);
    expect(repaired).toEqual([]);
  });

  it("refuses a system-app pin in any casing, even while it is connected", async () => {
    // Bundle ids are case-insensitive on iOS, and connected-and-healthy is
    // exactly the state the isConnected gate would wave through.
    const RECASED = "COM.Apple.Preferences";
    const { api, probed, queried } = poisonedApi([APP, RECASED]);
    await expect(
      queryFullHierarchyTree(registryFor(api), IOS_DEVICE, pin(RECASED))
    ).rejects.toThrow(/is an Apple system app/);
    expect(probed).toEqual([]);
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

describe("queryFullHierarchyTree - an unpinned target arbitrates a timed-out fan-out", () => {
  it("reads the hinted app when the fan-out times out and the hint is connected", async () => {
    // The pin is gone (a `tool:` step ran), so the fan-out runs and the wedged
    // sibling sinks it - but the launched app is still connected and no step
    // since could have changed the foreground, so it decides the target.
    const { api, probed, queried } = poisonedApi();
    const { tree, source } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, hint(APP));
    expect(source).toBe("native-devtools");
    expect(tree.children.length).toBeGreaterThan(0);
    expect(probed).toContain(POISONER); // the fan-out really did run
    expect(queried).toEqual([APP]);
  });

  it("rethrows the timeout when the hinted app is no longer connected", async () => {
    // The hint names an app that has since dropped its connection; targeting
    // it would query a process that cannot answer.
    const { api, queried } = poisonedApi([POISONER, OTHER]);
    await expect(queryFullHierarchyTree(registryFor(api), IOS_DEVICE, hint(APP))).rejects.toThrow(
      /RPC timed out/i
    );
    expect(queried).toEqual([]);
  });

  it("does not use the hint to bypass an answered backgrounded-app guard", async () => {
    // Resolution ANSWERS here (single connected app, backgrounded -> the
    // deliberate error). The hint must not override a guard that fired.
    const backgrounded: NativeAppState = {
      ...appState(APP),
      applicationState: "background",
      foregroundActiveSceneCount: 0,
      backgroundSceneCount: 1,
      isFrontmostCandidate: false,
    };
    const { api, queried } = poisonedApi([APP], { [APP]: backgrounded });
    await expect(queryFullHierarchyTree(registryFor(api), IOS_DEVICE, hint(APP))).rejects.toThrow(
      /not foreground-like/
    );
    expect(queried).toEqual([]);
  });

  it("rethrows a non-timeout resolution failure even with a connected hint", async () => {
    // Only a stall is arbitrated; anything the fan-out actually reports is a
    // failure the read must not paper over.
    const { api, queried } = poisonedApi(
      [APP, POISONER],
      {},
      {
        [POISONER]: new FailureError("boom", {
          error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_ERROR,
          failure_stage: "native_devtools_rpc_response",
          failure_area: "tool_server",
          error_kind: "subprocess",
        }),
      }
    );
    await expect(queryFullHierarchyTree(registryFor(api), IOS_DEVICE, hint(APP))).rejects.toThrow(
      /boom/
    );
    expect(queried).toEqual([]);
  });

  it("prefers the resolved frontmost app over a stale hint when resolution answers", async () => {
    // Two healthy apps, no wedged sibling: resolution answers with the
    // frontmost one, and the hint - which a tool step may well have made stale
    // - must not shadow it.
    const backgroundedApp: NativeAppState = {
      ...appState(APP),
      applicationState: "background",
      foregroundActiveSceneCount: 0,
      backgroundSceneCount: 1,
      isFrontmostCandidate: false,
    };
    const { api, queried } = poisonedApi([APP, OTHER], { [APP]: backgroundedApp });
    await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, hint(APP));
    expect(queried).toEqual([OTHER]);
  });
});
