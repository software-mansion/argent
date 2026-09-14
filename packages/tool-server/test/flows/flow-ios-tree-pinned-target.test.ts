import { describe, it, expect } from "vitest";
import { FAILURE_CODES, FailureError, getFailureSignal } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";
import {
  NON_INJECTABLE_NATIVE_WARNING,
  type NativeAppState,
  type NativeDevtoolsApi,
  type NativeDevtoolsAppState,
} from "../../src/blueprints/native-devtools";
import type { FlowTreeTarget } from "../../src/tools/flows/flow-actions";
import { queryFullHierarchyTree } from "../../src/tools/flows/flow-ios-tree";

// Simulator-wide injection means background system processes also connect, and
// a suspended one never answers getState - auto-resolve Promise.alls getState
// over every connection, so one such sibling fails every read while the app
// under test is healthy. A pinned read probes ONLY the pinned app, never a
// sibling; an unpinned one (the second describe) still lets auto-resolve
// decide, consulting the target solely as a timeout arbiter.

const IOS_DEVICE = {
  id: "00000000-0000-0000-0000-0000000000ab",
  platform: "ios",
} as unknown as DeviceInfo;

const APP = "com.example.app";
const POISONER = "com.apple.mobilecal";
const OTHER = "com.example.other";

/**
 * A pinned target. `probeAnswered` defaults to false - the state a fresh
 * `launch` leaves behind, where a getState timeout is still ridden out as a
 * cold-start stall.
 */
const pin = (bundleId: string, probeAnswered = false): FlowTreeTarget => ({
  bundleId,
  pinned: true,
  probeAnswered,
});
const hint = (bundleId: string): FlowTreeTarget => ({
  bundleId,
  pinned: false,
  probeAnswered: false,
});

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
 * times out; records state probes, hierarchy reads, and the env repair a miss
 * path triggers (`appConnectionState` -> `reverifyEnv`).
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
    appConnectionState: async (id: string): Promise<NativeDevtoolsAppState> => {
      repaired.push(`appConnectionState:${id}`);
      if (connected.includes(id)) return "connected";
      // The real miss path awaits a full reverifyEnv before it diagnoses.
      repaired.push("reverifyEnv");
      return "not_running";
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
    const target = pin(APP);
    const { tree, source } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, target);
    expect(source).toBe("native-devtools");
    expect(tree.children.length).toBeGreaterThan(0);
    // A sibling probe would reintroduce the fan-out failure the pin avoids.
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
    expect(repaired).toEqual([]);
    expect(target.probeAnswered).toBe(true);
  });

  it("a pinned read of a still-answering backgrounded app refuses to describe an off-screen hierarchy", async () => {
    // The narrow half of the backgrounded case: an app that still ANSWERS the
    // probe, i.e. something keeps its main queue serviced past the switch away
    // (a background mode, a `beginBackgroundTask`, the grace before iOS
    // suspends it). The common half - an app that never answers - is covered by
    // "a pinned read whose probe answered earlier refuses a later timeout".
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
    expect(message).toContain(`${APP} (the launched app) has no foreground presence at all`);
    expect(message).toContain("applicationState=background");
    // The message must not advertise a refusal the guard does not deliver: it
    // is as lenient as auto-resolve over one app, so it says so.
    expect(message).toContain("Transitional states are NOT refused here");
    expect(message).toContain("give the flow a `launch:` step for that app");
    expect(message).toContain("demotes the pin and returns reads to frontmost auto-resolve");
    expect(message).not.toContain("clears the pin");
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND
    );
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([]);
    expect(repaired).toEqual([]);
  });

  it("a pinned read under a system permission dialog still reads the app", async () => {
    // What a system dialog (location, notifications, photos) over the app under
    // test answers. The app IS what is on screen - the alert is drawn by
    // another process in its own window - so the read must not be refused.
    const underAlert: NativeAppState = {
      ...appState(APP),
      applicationState: "inactive",
      foregroundActiveSceneCount: 0,
      foregroundInactiveSceneCount: 1,
      isFrontmostCandidate: false,
    };
    const { api, probed, queried, repaired } = poisonedApi([APP, POISONER], { [APP]: underAlert });
    const target = pin(APP);
    const { tree, source } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, target);
    expect(source).toBe("native-devtools");
    expect(tree.children.length).toBeGreaterThan(0);
    // The guard let the read through, probing only the pinned app to decide.
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
    expect(repaired).toEqual([]);
    expect(target.probeAnswered).toBe(true);
  });

  it("a pinned read of an inactive app with no attached scene still reads it", async () => {
    // `inactive` with every count at zero: no scene attached yet, or an
    // injected framework old enough to omit the scene fields. Accepted because
    // `chooseFrontmostConnectedApp` accepts it over the same one-element array
    // - the pinned path matches auto-resolve rather than being stricter.
    const inactive: NativeAppState = {
      ...appState(APP),
      applicationState: "inactive",
      foregroundActiveSceneCount: 0,
      isFrontmostCandidate: false,
    };
    const { api, probed, queried, repaired } = poisonedApi([APP, POISONER], { [APP]: inactive });
    const target = pin(APP);
    const { tree, source } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, target);
    expect(source).toBe("native-devtools");
    expect(tree.children.length).toBeGreaterThan(0);
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
    expect(repaired).toEqual([]);
    expect(target.probeAnswered).toBe(true);
  });

  it("a pinned read of a background app still holding a foreground-inactive scene reads it", async () => {
    // `background` while a scene is still foreground-inactive - the tail of a
    // transition, where the app's window is on screen even though the
    // process-level state says otherwise. A lingering foreground scene outvotes
    // `background`; only no foreground scene at all is refused.
    const lingeringScene: NativeAppState = {
      ...appState(APP),
      applicationState: "background",
      foregroundActiveSceneCount: 0,
      foregroundInactiveSceneCount: 1,
      isFrontmostCandidate: false,
    };
    const { api, probed, queried, repaired } = poisonedApi([APP, POISONER], {
      [APP]: lingeringScene,
    });
    const { tree } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, pin(APP));
    expect(tree.children.length).toBeGreaterThan(0);
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
    expect(repaired).toEqual([]);
  });

  it("a pinned read rides out a frontmost probe the stalled main thread cannot answer, on the FIRST read", async () => {
    // Application.getState hops onto the app's main thread, which a heavy cold
    // start can pin past the RPC timeout. An unanswerable probe is not an
    // answer of "backgrounded", so the read goes ahead - and the stall can only
    // precede the pin's first ANSWERED probe.
    const { api, probed, queried } = poisonedApi([APP, POISONER], {}, { [APP]: rpcTimeout() });
    const target = pin(APP);
    expect(target.probeAnswered).toBe(false);
    const { tree } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, target);
    expect(tree.children.length).toBeGreaterThan(0);
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
    // A ridden-out probe is not an answer, so it must not arm the refusal.
    expect(target.probeAnswered).toBe(false);
  });

  it("a pinned read whose probe answered earlier refuses a later timeout instead of reading", async () => {
    // Same RPC timeout, opposite verdict: this pin already had a probe answer,
    // so the main queue WAS being serviced and has stopped. The hierarchy read
    // would dispatch onto that same unserviced queue - not a second chance,
    // only a second timeout.
    const { api, probed, queried } = poisonedApi([APP, POISONER], {}, { [APP]: rpcTimeout() });
    const err: unknown = await queryFullHierarchyTree(
      registryFor(api),
      IOS_DEVICE,
      pin(APP, true)
    ).then(
      () => {
        throw new Error("expected the suspended-pin read to throw");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`${APP} (the launched app) stopped answering Application.getState`);
    expect(message).toContain("an earlier one in this run answered");
    // The escape hatch must be one that re-targets reads. A foreground-NEUTRAL
    // `tool:` step is not: it demotes the pin back to a fan-out this same
    // silent app sinks.
    expect(message).toContain("give the flow a `launch:` step for that app");
    expect(message).toContain(
      "`tool: launch-app` or `tool: restart-app` naming that app works too"
    );
    expect(message).toContain("how a recorded flow switches apps");
    expect(message).toContain("A foreground-NEUTRAL raw `tool:` step does not work here");
    expect(message).not.toContain("clears the pin");
    expect(message).not.toContain("returns reads to frontmost auto-resolve");
    // The timeout's own classification: no app state was observed here.
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_tree_pinned_target");
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(probed).toEqual([APP]);
    // The 15s getFullHierarchy on the same queue is never spent.
    expect(queried).toEqual([]);
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
    // The app crashed or was killed after launch, and the socket close removed
    // it from the connection set.
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
    // Not the stale-instrumentation diagnosis: the launch gate proved the
    // instrumentation loaded.
    expect(message).not.toMatch(/instrumentation loaded/);
    // On iOS launch-app is `simctl launch`, which only foregrounds a live
    // process - the next read fails identically. restart-app terminates first.
    expect(message).toContain("restart it (restart-app, or a flow `launch` step)");
    expect(message).not.toMatch(/relaunch it \(launch-app/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED);
    // A dead pin is re-read every 300ms poll, and appConnectionState's miss
    // path would run a full reverifyEnv each time.
    expect(repaired).toEqual([]);
    expect(queried).toEqual([]);
  });

  it("a pinned read of an Apple system app is refused before any RPC is spent", async () => {
    // A flow `launch:` can name a system app - nothing upstream refuses one -
    // so the pin lands here, and the refusal must be terminal and free rather
    // than a 5s probe plus a 15s hierarchy timeout surfacing as "RPC timed
    // out".
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
    // Refusing here only helps if the message carries the coordinate remedy.
    expect(message).toContain(
      "`tap: { x: 0.5, y: 0.35 }` takes a point directly and reads no tree"
    );
    // This reader is writing flow YAML, where no native-* tool is a step.
    expect(message).not.toContain(NON_INJECTABLE_NATIVE_WARNING);
    expect(message).not.toMatch(/native-describe-screen|native-find-views/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_tree_pinned_target");
    // No RPC was touched at all.
    expect(probed).toEqual([]);
    expect(queried).toEqual([]);
    expect(repaired).toEqual([]);
  });

  it("refuses a system-app pin that is not connected, rather than sending the flow to restart it", async () => {
    // The same pin with no connection behind it - treeSourceGate withholds its
    // verdict for a com.apple.* id, so a `launch:` naming one passes even when
    // nothing connected. This pins the ORDER of the two gates: check
    // isConnected first and the author is told to restart the app, rebuilding
    // the loop the policy gate exists to end.
    const { api, probed, queried, repaired } = poisonedApi([APP]);
    const err: unknown = await queryFullHierarchyTree(
      registryFor(api),
      IOS_DEVICE,
      pin(POISONER)
    ).then(
      () => {
        throw new Error("expected the disconnected system-app pin to be refused");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`${POISONER} is an Apple system app`);
    expect(message).toContain("no relaunch or retry changes this verdict");
    expect(message).not.toMatch(/lost its devtools connection|restart it/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
    expect(probed).toEqual([]);
    expect(queried).toEqual([]);
    expect(repaired).toEqual([]);
  });

  it("refuses a system-app pin in any casing, even while it is connected", async () => {
    // Bundle ids are case-insensitive on iOS.
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
    // sibling sinks it - but the launched app is still connected, so it decides
    // the target.
    const { api, probed, queried } = poisonedApi();
    const { tree, source } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, hint(APP));
    expect(source).toBe("native-devtools");
    expect(tree.children.length).toBeGreaterThan(0);
    expect(probed).toContain(POISONER); // the fan-out really did run
    expect(queried).toEqual([APP]);
  });

  it("refuses a hint that answers the arbiter's probe from the background", async () => {
    // Without its own probe the arbiter would hand the read back to an app the
    // pinned guard had just refused - its gates are all upstream of here.
    const backgrounded: NativeAppState = {
      ...appState(APP),
      applicationState: "background",
      foregroundActiveSceneCount: 0,
      backgroundSceneCount: 1,
      isFrontmostCandidate: false,
    };
    const { api, probed, queried } = poisonedApi([APP, POISONER], { [APP]: backgrounded });
    const target = hint(APP);
    const err: unknown = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, target).then(
      () => {
        throw new Error("expected the backgrounded-hint read to be refused");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`${APP} (the launched app) has no foreground presence at all`);
    expect(message).toContain("applicationState=background");
    // The diagnosis names both halves: the timed-out fan-out, and a fallback
    // that answered from the background.
    expect(message).toContain("auto-resolve's probe of every connection timed out");
    expect(message).toContain("give the flow a `launch:` step for that app");
    // A state WAS observed here, unlike the silent-hint rethrow below.
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND
    );
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_tree_unpinned_hint");
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(probed).toContain(POISONER); // the fan-out really did run
    // The backgrounded hint is never read.
    expect(queried).toEqual([]);
    // A demoted target never re-pins, so the discriminator stays unarmed.
    expect(target.probeAnswered).toBe(false);
  });

  it("rethrows the fan-out timeout when the hint cannot answer the arbiter's probe", async () => {
    // The hint's own main thread is silent - it may be the wedge itself - so
    // there is nothing to vouch for and the fan-out's timeout stands.
    const { api, probed, queried } = poisonedApi([APP, POISONER], {}, { [APP]: rpcTimeout() });
    const err: unknown = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, hint(APP)).then(
      () => {
        throw new Error("expected the silent-hint read to rethrow the fan-out timeout");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/RPC timed out/i);
    // The ORIGINAL fan-out error, not a new refusal: no foreground verdict is
    // claimed for a state never observed.
    expect(getFailureSignal(err)?.failure_stage).toBe("native_devtools_rpc_request");
    expect(probed).toEqual([APP, POISONER, APP]); // the fan-out, then the arbiter's own probe
    expect(queried).toEqual([]);
  });

  it("propagates an arbiter probe failure that is not a timeout", async () => {
    // Only a stall lets the fan-out's timeout stand; anything the probe
    // actually reports is a failure the read must not paper over.
    const queried: string[] = [];
    let hintProbes = 0;
    const api = {
      listConnectedBundleIds: () => [APP, POISONER],
      isConnected: () => true,
      getAppState: async (id: string) => {
        if (id === POISONER) throw rpcTimeout();
        // The first call is the fan-out's, sunk by the sibling; the second is
        // the arbiter's own probe.
        hintProbes += 1;
        if (hintProbes > 1) {
          throw new FailureError("boom", {
            error_code: FAILURE_CODES.NATIVE_DEVTOOLS_RPC_ERROR,
            failure_stage: "native_devtools_rpc_response",
            failure_area: "tool_server",
            error_kind: "subprocess",
          });
        }
        return appState(id);
      },
      queryViewHierarchy: async (id: string) => {
        queried.push(id);
        return { windows: [windowSpanning()] };
      },
    } as unknown as NativeDevtoolsApi;
    await expect(queryFullHierarchyTree(registryFor(api), IOS_DEVICE, hint(APP))).rejects.toThrow(
      /boom/
    );
    expect(hintProbes).toBe(2);
    expect(queried).toEqual([]);
  });

  it("refuses a com.apple.* hint with the terminal policy verdict instead of arbitrating toward it", async () => {
    // A raw `tool:` step after `launch: com.apple.*` demotes the pin to this
    // hint, and the system app's own wedged getState sinks the fan-out - so
    // without a gate the arbiter re-targets the very id the pinned gate
    // refuses.
    const { api, probed, queried } = poisonedApi();
    const err: unknown = await queryFullHierarchyTree(
      registryFor(api),
      IOS_DEVICE,
      hint(POISONER)
    ).then(
      () => {
        throw new Error("expected the system-app hint to be refused");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(`${POISONER} is an Apple system app`);
    expect(message).toContain("never a valid flow target");
    // Whether a `tool:` step ran must not soften the refusal.
    expect(message).toContain(
      "`tap: { x: 0.5, y: 0.35 }` takes a point directly and reads no tree"
    );
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
    // Its own stage: this one refuses after a fan-out the hint could not
    // rescue, and the preserved cause carries it.
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_tree_unpinned_hint");
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(probed).toContain(POISONER); // the fan-out really did run
    // The system app is never read.
    expect(queried).toEqual([]);
  });

  it("refuses a disconnected com.apple.* hint before consulting the connections list", async () => {
    // Ordering twin of the pinned case: check connections first and this state
    // rethrows the raw fan-out timeout, hiding the terminal verdict behind an
    // error that invites a retry.
    const { api, queried } = poisonedApi([APP, OTHER], {}, { [OTHER]: rpcTimeout() });
    const err: unknown = await queryFullHierarchyTree(
      registryFor(api),
      IOS_DEVICE,
      hint(POISONER)
    ).then(
      () => {
        throw new Error("expected the disconnected system-app hint to be refused");
      },
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(`${POISONER} is an Apple system app`);
    expect((err as Error).message).not.toMatch(/RPC timed out/i);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
    expect(queried).toEqual([]);
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
    // Resolution ANSWERS here, so the hint must not override the guard.
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
    // Resolution answers with the frontmost app, and the hint - which a tool
    // step may well have made stale - must not shadow it.
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
