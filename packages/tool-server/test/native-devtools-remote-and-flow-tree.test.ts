import { describe, it, expect, vi } from "vitest";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";

// Two consumers of the measured state: the full-hierarchy path flows resolve
// selectors against, and the ios-remote host's `inspectRunningApp`. Both decide
// what an agent is told to do next, and on ios-remote the running/indeterminate
// split is the ONLY distinction available — it drives `requiresRestart` and
// `describe`'s `should_restart`.

const remote = vi.hoisted(() => ({ stdout: "", calls: 0, fail: false }));

vi.mock("@argent/native-devtools-ios", () => ({
  bootstrapDylibPath: () => "/fake/dylibs/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTcp: () => "/fake/dylibs/tcp/libArgentInjectionBootstrap.dylib",
  bootstrapDylibPathTvos: () => "/fake/dylibs/tvos/libArgentInjectionBootstrap.dylib",
  tcpInjectionDylibs: () => [],
  axServiceBinaryPath: () => "/fake/ax-service",
  axServiceBinaryPathTcp: () => "/fake/ax-service-tcp",
}));

vi.mock("../src/utils/sim-remote", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/sim-remote")>()),
  simctlSpawn: vi.fn(async () => {
    remote.calls += 1;
    if (remote.fail) throw new Error("tunnel down");
    return { stdout: remote.stdout, stderr: "" };
  }),
}));

import { remoteIosHost } from "../src/utils/ios-host";
import { queryFullHierarchyTree } from "../src/tools/flows/flow-ios-tree";
import type { DeviceInfo, Registry } from "@argent/registry";

const UDID = "AAAAAAAA-1111-2222-3333-444444444444";
const BUNDLE = "com.example.app";
const DEVICE: DeviceInfo = { id: UDID, platform: "ios", kind: "simulator" };
// The launched app as the runner hands it over once a raw `tool:` step has
// spent the pin.
const UNPINNED = { bundleId: BUNDLE, pinned: false, probeAnswered: false };

describe("remoteIosHost.inspectRunningApp", () => {
  it("reports running-ness from the orchestrator and leaves the process unknown", async () => {
    remote.stdout = `4242\t0\tUIKitApplication:${BUNDLE}[dffa][rb-legacy]\n`;
    remote.calls = 0;

    const inspection = await remoteIosHost.inspectRunningApp(UDID, BUNDLE);

    // `running` must come off the real row: assuming true makes every stopped
    // remote app `indeterminate`, answered with a restart of an app that is not
    // there, and assuming false makes every running one `not_running`.
    expect(inspection.running).toBe(true);
    // App processes live on the orchestrator, so the local process table has
    // nothing to say — a fabricated process here would be judged against this
    // listener and reported as a definite verdict.
    expect(inspection.process).toBeNull();
    expect(remote.calls).toBe(1);
  });

  it("reports not running when no row backs the bundle", async () => {
    remote.stdout = `4242\t0\tUIKitApplication:com.other.app[dffa][rb-legacy]\n`;

    await expect(remoteIosHost.inspectRunningApp(UDID, BUNDLE)).resolves.toEqual({
      running: false,
      process: null,
    });
  });
});

describe("queryFullHierarchyTree surfaces the measured diagnosis", () => {
  // Both accessors come off ONE connected set, as the real factory derives them
  // from its `connections` map. Stubbing them independently lets a test assert a
  // pairing the service cannot produce — a listed-but-unconnected app — so a
  // diagnosis reached only that way is reached only by tests. Every unconnected
  // state means an EMPTY set, hence an app auto-targeting cannot name; the id the
  // flow launched is what makes it nameable.
  function registryWith(connected: string[], overrides: Partial<NativeDevtoolsApi> = {}): Registry {
    // Instance-scoped in the real service, so one set per registry here.
    const advised = new Set<string>();
    const api = {
      listConnectedBundleIds: () => connected,
      noteRelaunchAdvice: (bundleId: string) => {
        advised.add(bundleId);
      },
      wasAdvisedToRelaunch: (bundleId: string) => advised.has(bundleId),
      isConnected: (bundleId: string) => connected.includes(bundleId),
      getAppState: async (bundleId: string) => ({
        bundleId,
        applicationState: "active",
        foregroundActiveSceneCount: 1,
        foregroundInactiveSceneCount: 0,
        backgroundSceneCount: 0,
        unattachedSceneCount: 0,
        isFrontmostCandidate: true,
      }),
      appConnectionState: async (bundleId: string) =>
        connected.includes(bundleId) ? "connected" : "unregistered",
      ...overrides,
    } as unknown as NativeDevtoolsApi;
    return { resolveService: async () => api } as unknown as Registry;
  }

  it("raises the state's own remedy rather than a blanket relaunch", async () => {
    // `unregistered` is the case that matters: telling a flow author to relaunch
    // here sends them round a loop the app cannot exit.
    const registry = registryWith([]);

    await expect(queryFullHierarchyTree(registry, DEVICE, UNPINNED)).rejects.toThrow(
      /argent server stop && argent server start --detach/
    );
    await expect(queryFullHierarchyTree(registry, DEVICE, UNPINNED)).rejects.not.toThrow(
      /relaunch it/
    );
  });

  it("keeps the auto-target error when the run never launched an app", async () => {
    // A fragment brings the device to its entry state out of band, so there is
    // no launched id to measure and the auto-target error — which names its own
    // next steps — is the best answer available.
    const registry = registryWith([]);

    await expect(queryFullHierarchyTree(registry, DEVICE)).rejects.toThrow(
      /No native-devtools-connected apps are available for auto-targeting/
    );
  });

  it("does not measure when auto-targeting resolved an app", async () => {
    // The measurement is for the app the flow launched, not a second-guess of a
    // resolution that succeeded. The stub serves a real window because an empty
    // `windows` is its own error and would end the call before the assertion.
    const appConnectionState = vi.fn(async () => "connected" as const);
    const registry = registryWith([BUNDLE], {
      appConnectionState,
      queryViewHierarchy: async () => ({
        windows: [
          {
            className: "UIWindow",
            frame: { x: 0, y: 0, width: 400, height: 800 },
            windowFrame: { x: 0, y: 0, width: 400, height: 800 },
            children: [],
          },
        ],
      }),
    } as unknown as Partial<NativeDevtoolsApi>);

    await queryFullHierarchyTree(registry, DEVICE, UNPINNED);

    expect(appConnectionState).not.toHaveBeenCalled();
  });

  it("degrades a rejected measurement instead of leaking the subprocess error", async () => {
    // The measurement re-applies the launchd env before it can answer, so a sim
    // that goes away mid-run rejects here. The other consumers degrade to
    // `indeterminate`; a raw `Command failed: xcrun simctl spawn …` carries none
    // of the diagnosis's guidance.
    const registry = registryWith([], {
      appConnectionState: async () => {
        throw new Error("Command failed: xcrun simctl spawn UDID launchctl setenv");
      },
    });

    await expect(queryFullHierarchyTree(registry, DEVICE, UNPINNED)).rejects.toThrow(
      /could not be inspected/
    );
    await expect(queryFullHierarchyTree(registry, DEVICE, UNPINNED)).rejects.not.toThrow(
      /Command failed/
    );
  });

  // Reachable, though it reads as dead: `appConnectionState` re-reads the live
  // connections map AFTER its env re-apply and process probe — several simctl
  // round-trips past the empty list that routed the call here — precisely so a
  // dial landing in that window is not reported as an app the service never
  // registered. Folding the case away leaves it throwing a sentence that names
  // no app and no remedy.
  it("says the connection arrived mid-read when the measurement finds it connected", async () => {
    const registry = registryWith([], { appConnectionState: async () => "connected" });

    await expect(queryFullHierarchyTree(registry, DEVICE, UNPINNED)).rejects.toThrow(
      /connection arrived mid-read/
    );
    // It must still name the app and an action; the measured states' remedies
    // do not apply, because nothing is wrong with the app.
    await expect(queryFullHierarchyTree(registry, DEVICE, UNPINNED)).rejects.toThrow(
      new RegExp(`${BUNDLE}[\\s\\S]*Retry`)
    );
    await expect(queryFullHierarchyTree(registry, DEVICE, UNPINNED)).rejects.not.toThrow(
      /argent server stop|restart-app/
    );
  });

  it("gives a system app the terminal reason instead of a measured remedy", async () => {
    // The launch gate lets a refused app through so a coordinate-driven flow
    // still runs; selector resolution is where that refusal bites, so this is
    // where it is said - and said terminally, since every measured state's
    // remedy is a retry of something.
    const registry = registryWith([]);

    await expect(
      queryFullHierarchyTree(registry, DEVICE, {
        bundleId: "com.apple.Preferences",
        pinned: false,
        probeAnswered: false,
      })
    ).rejects.toThrow(/Apple system app/);
    await expect(
      queryFullHierarchyTree(registry, DEVICE, {
        bundleId: "com.apple.Preferences",
        pinned: false,
        probeAnswered: false,
      })
    ).rejects.not.toThrow(/argent server stop|restart-app/);
    // The remedy has to name a step form that exists AND reads no tree.
    await expect(
      queryFullHierarchyTree(registry, DEVICE, {
        bundleId: "com.apple.Preferences",
        pinned: false,
        probeAnswered: false,
      })
    ).rejects.toThrow(/tap: \{ x: [\d.]+, y: [\d.]+ \}/);
  });
});
