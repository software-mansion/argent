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

/**
 * A pinned target. `probeAnswered` defaults to false - the state a fresh
 * `launch` leaves behind, where a getState timeout is still ridden out as a
 * cold-start stall; pass true for a pin whose probe has already answered once
 * in the run, where the same timeout means the app stopped servicing its main
 * queue.
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
 * path triggers (`appConnectionState` -> `reverifyEnv`). `connected` overrides
 * the connection set to model a dropped pin; `states` overrides per-app state
 * to model a backgrounded pin; `probeFailures` makes an app's own getState
 * throw.
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
      // The real miss path awaits a full reverifyEnv before it diagnoses; the
      // dropped pin this models is a process that died.
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
    // The frontmost check probes the pinned app itself and nothing else - a
    // sibling probe would reintroduce the fan-out failure the pin avoids.
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
    expect(repaired).toEqual([]);
    // An answered probe is recorded ON the target, which every later read of
    // this pin shares - that is what makes a LATER timeout diagnosable as the
    // app going quiet rather than as a cold start.
    expect(target.probeAnswered).toBe(true);
  });

  it("a pinned read of a still-answering backgrounded app refuses to describe an off-screen hierarchy", async () => {
    // The pin bypasses auto-resolve's frontmost guard, so the pinned path must
    // re-check it: connected-but-backgrounded means something (a tap into
    // another app, home) left the app, and its hierarchy is not what's on
    // screen.
    //
    // The narrow half of that: an app that ANSWERS the probe while
    // backgrounded, i.e. something keeps its main queue serviced past the
    // switch away - a background mode, a `beginBackgroundTask`, an attached
    // debugger, or the sub-second grace before iOS suspends it. Measured on
    // device across the same flow: an app holding a `beginBackgroundTask`
    // reaches this refusal and ends the run in ~7s, while a plain UIKit app
    // that iOS suspends never answers at all and takes ~46s to surface a bare
    // hierarchy timeout instead - the common path, covered by "a pinned read
    // whose probe answered earlier refuses a later timeout instead of reading".
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
    // is as lenient as auto-resolve over one app (an `inactive` app, or a
    // lingering foreground-inactive scene, still reads), so it says so and
    // names the escape hatch for a flow whose subject IS another app.
    expect(message).toContain("Transitional states are NOT refused here");
    expect(message).toContain("clears the pin");
    expect(getFailureSignal(err)?.error_code).toBe(
      FAILURE_CODES.NATIVE_TARGET_SINGLE_APP_NOT_FOREGROUND
    );
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([]);
    expect(repaired).toEqual([]);
  });

  it("a pinned read under a system permission dialog still reads the app", async () => {
    // What a system dialog (location, notifications, photos) over the app under
    // test answers: `inactive`, with the app's own scene still attached and
    // foreground-inactive. The app IS what is on screen - the alert is drawn by
    // another process in its own window - so a flow asserting around it, or
    // just reading between two taps, must not be refused.
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
    // The substance: the guard let the read through, and it probed only the
    // pinned app to decide that - no fan-out over the poisoned sibling.
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
    expect(repaired).toEqual([]);
    expect(target.probeAnswered).toBe(true);
  });

  it("a pinned read of an inactive app with no attached scene still reads it", async () => {
    // `inactive` with every count at zero: no scene attached yet (an app still
    // mid-launch), or an injected framework old enough to omit the scene fields
    // entirely, which getAppState defaults to 0. `applicationState` alone
    // decides here, and it is the disjunct nothing else in this file pins.
    // Verified against `chooseFrontmostConnectedApp` (native-target-app.ts) over
    // this one-element array: no strong candidate, exactly one weak one, so
    // auto-resolve targets it too - the pinned path deliberately matches that
    // rather than being stricter.
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
    // The other accepted state: `applicationState` has already flipped to
    // `background` while a scene is still foreground-inactive - the tail of a
    // transition (a dismissing sheet, an app-switcher swipe the user abandons),
    // where the app's window is on screen even though the process-level state
    // says otherwise. `background` alone is therefore not the verdict; a
    // lingering foreground scene outvotes it. Verified against
    // `chooseFrontmostConnectedApp` (native-target-app.ts) over this
    // one-element array: `foregroundInactiveSceneCount > 0` makes it the single
    // weak candidate, so auto-resolve reads it too. Only `background` or
    // `unknown` with no foreground scene at all is refused - see "a pinned read
    // of a still-answering backgrounded app refuses to describe an off-screen
    // hierarchy".
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
    // start (first Hermes parse, asset decode) can pin past the RPC timeout. An
    // unanswerable probe is not an answer of "backgrounded", and the pin names
    // the app this run launched, so the read goes ahead instead of failing the
    // step. This is the only window where that holds: the cold-start stall can
    // only precede the pin's first ANSWERED probe, which is exactly what
    // `probeAnswered: false` says about this target.
    const { api, probed, queried } = poisonedApi([APP, POISONER], {}, { [APP]: rpcTimeout() });
    const target = pin(APP);
    expect(target.probeAnswered).toBe(false);
    const { tree } = await queryFullHierarchyTree(registryFor(api), IOS_DEVICE, target);
    expect(tree.children.length).toBeGreaterThan(0);
    expect(probed).toEqual([APP]);
    expect(queried).toEqual([APP]);
    // A ridden-out probe is not an answer, so it must not arm the refusal for
    // the next read - the app may still be starting up.
    expect(target.probeAnswered).toBe(false);
  });

  it("a pinned read whose probe answered earlier refuses a later timeout instead of reading", async () => {
    // Same RPC timeout, opposite verdict: this pin already had a probe answer,
    // so the main queue WAS being serviced and has stopped - usually the
    // suspension iOS applies once a flow leaves the app, and in-app work that
    // blocks the main thread is indistinguishable from here. The hierarchy read
    // would dispatch onto that same unserviced queue behind the abandoned
    // probe, so it is not a second chance, only a second timeout.
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
    // The escape hatch for a flow whose subject genuinely IS the other app is a
    // `launch:` step - NOT the raw `tool:` step the answered-state refusal
    // offers. Demoting the pin sends reads back to auto-resolve, whose
    // Promise.all fan-out this same still-connected, still-silent app sinks;
    // the arbiter then targets it again and pays the 15s getFullHierarchy, i.e.
    // exactly the generic timeout this refusal exists to avoid.
    expect(message).toContain("give the flow a `launch:` step for that app");
    expect(message).toContain("a raw `tool:` step does not work here");
    expect(message).not.toContain("clears the pin");
    expect(message).not.toContain("returns reads to frontmost auto-resolve");
    // The timeout's own classification, kept because no app state was observed
    // here - the flow-level diagnosis rides in the message, and the stage
    // separates it from a bare transport timeout.
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_RPC_TIMEOUT);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_tree_pinned_target");
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(probed).toEqual([APP]);
    // The substance of the refusal: the 15s getFullHierarchy that would have
    // timed out on the same queue is never spent.
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
    // The recovery must be the one that recovers ALL three named causes. On
    // iOS launch-app is `simctl launch`, which only foregrounds a live process
    // whose socket dropped - the next read fails identically. restart-app
    // terminates first, and a flow `launch` step routes through it.
    expect(message).toContain("restart it (restart-app, or a flow `launch` step)");
    expect(message).not.toMatch(/relaunch it \(launch-app/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_CONNECTED);
    // A dead pin is re-read every 300ms poll; appConnectionState's miss path
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
    // Refusing here instead of at `launch` only helps if the message carries
    // the coordinate remedy the flow can still act on.
    expect(message).toContain(
      "`tap: { x: 0.5, y: 0.35 }` takes a point directly and reads no tree"
    );
    // The native-* dead-end warning addresses a native-* tool caller; this
    // reader is writing flow YAML, where none of those tools is a step.
    expect(message).not.toContain(NON_INJECTABLE_NATIVE_WARNING);
    expect(message).not.toMatch(/native-describe-screen|native-find-views/);
    expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
    expect(getFailureSignal(err)?.failure_stage).toBe("flow_tree_pinned_target");
    // The substance of the refusal: no RPC was touched at all.
    expect(probed).toEqual([]);
    expect(queried).toEqual([]);
    expect(repaired).toEqual([]);
  });

  it("refuses a system-app pin that is not connected, rather than sending the flow to restart it", async () => {
    // The other arrival: treeSourceGate deliberately withholds its verdict for
    // a com.apple.* bundle id, so a `launch:` naming one passes after the full
    // wait even when nothing ever connected - and the pin lands with no
    // connection behind it. Which of the two happens is runtime-dependent (see
    // isInjectableBundleId), so both are covered. What pins the
    // ORDER of the two gates: run the isConnected check first and this state
    // reports a dropped connection and tells the author to restart the app,
    // rebuilding the unbounded restart -> retry loop the policy gate exists to
    // end.
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
