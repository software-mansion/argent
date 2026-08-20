import { describe, expect, it, vi } from "vitest";
import { FailureError, FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  buildAppStateMessage,
  isInjectableBundleId,
  NON_INJECTABLE_NATIVE_WARNING,
  NON_INJECTABLE_RECOVERY,
  precheckNativeDevtools,
  MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
  type NativeDevtoolsApi,
  type NativeDevtoolsAppState,
  type NativeDevtoolsInitFailure,
} from "../src/blueprints/native-devtools";
// Both tools gate `execute()` behind `ensureDeps(["xcrun"])`, but the
// restart-guidance / init_failed logic under test never shells out to xcrun.
// The real probe makes this pass only on a host with Xcode (dev macOS) and
// fail on the Linux CI runner with `missing: [xcrun]`. Stub the gate to a
// no-op so the test exercises the logic it's about, not the host's toolchain.
// Keep the rest of the module (DependencyMissingError, cache reset) intact.
vi.mock("../src/utils/check-deps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/check-deps")>();
  return {
    ...actual,
    ensureDeps: vi.fn(async () => {}),
    ensureDep: vi.fn(async () => {}),
  };
});

import { flowLaunchGateReason } from "../src/tools/flows/flow-run";
import { nativeDevtoolsStatusTool } from "../src/tools/native-devtools/native-devtools-status";
import { nativeDescribeScreenTool } from "../src/tools/native-devtools/native-describe-screen";
import { nativeFindViewsTool } from "../src/tools/native-devtools/native-find-views";
import { nativeFullHierarchyTool } from "../src/tools/native-devtools/native-full-hierarchy";
import { nativeNetworkLogsTool } from "../src/tools/native-devtools/native-network-logs";
import { nativeViewAtPointTool } from "../src/tools/native-devtools/native-view-at-point";
import { nativeUserInteractableViewAtPointTool } from "../src/tools/native-devtools/native-user-interactable-view-at-point";

function makeNativeApi(options: {
  envSetup?: boolean;
  connected?: boolean;
  appRunning?: boolean;
  initFailure?: NativeDevtoolsInitFailure | null;
  state?: NativeDevtoolsAppState;
}): {
  api: NativeDevtoolsApi;
  ensureEnvReady: ReturnType<typeof vi.fn>;
  reverifyEnv: ReturnType<typeof vi.fn>;
  isAppRunning: ReturnType<typeof vi.fn>;
} {
  let envSetup = options.envSetup ?? false;
  const ensureEnvReady = vi.fn(async () => {
    envSetup = true;
  });
  const reverifyEnv = vi.fn(async () => {
    envSetup = true;
  });
  const isAppRunning = vi.fn(async () => options.appRunning ?? false);
  const relaunchAdvised = new Set<string>();

  return {
    api: {
      isEnvSetup: () => envSetup,
      socketPath: "/tmp/mock.sock",
      ensureEnvReady,
      reverifyEnv,
      getInitFailure: () => options.initFailure ?? null,
      isConnected: () => options.connected ?? false,
      isAppRunning,
      listConnectedBundleIds: () => [],
      noteRelaunchAdvice: (bundleId: string) => {
        relaunchAdvised.add(bundleId);
      },
      wasAdvisedToRelaunch: (bundleId: string) => relaunchAdvised.has(bundleId),
      appConnectionState: async () => {
        if (options.connected) return "connected";
        // Mirrors the real API: the unconnected path re-applies the launchd env
        // before it judges the process, so callers can still pin that repair.
        await reverifyEnv();
        return options.state ?? (options.appRunning ? "stale_process" : "not_running");
      },
      activateNetworkInspection: () => {},
      getNetworkLog: () => [],
      clearNetworkLog: () => {},
      getAppState: async () => {
        throw new Error("not implemented");
      },
      detectFrontmostBundleId: async () => null,
      queryViewHierarchy: async () => ({}),
    },
    ensureEnvReady,
    reverifyEnv,
    isAppRunning,
  };
}

describe("native-devtools-status tool", () => {
  it("reports a running uninjected app as needing restart", async () => {
    const { api, ensureEnvReady } = makeNativeApi({ appRunning: true, connected: false });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.example.app" }
      )
    ).resolves.toEqual({
      envSetup: true,
      appRunning: true,
      connected: false,
      requiresRestart: true,
      state: "stale_process",
      message: expect.stringContaining("restart-app") as string,
      nextLaunchWillBeInjected: true,
      injectable: true,
    });

    expect(ensureEnvReady).toHaveBeenCalledOnce();
  });

  it("re-applies the env when the app is not connected (repairs a stale latch after a sim reboot)", async () => {
    // envSetup:false models the cleared launchd state after an out-of-band
    // reboot; reverifyEnv must run and bring it back to true.
    const { api, reverifyEnv } = makeNativeApi({
      appRunning: true,
      connected: false,
      envSetup: false,
    });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.example.app" }
      )
    ).resolves.toEqual({
      envSetup: true,
      appRunning: true,
      connected: false,
      requiresRestart: true,
      state: "stale_process",
      message: expect.stringContaining("restart-app") as string,
      nextLaunchWillBeInjected: true,
      injectable: true,
    });

    expect(reverifyEnv).toHaveBeenCalledOnce();
  });

  it("does not re-apply the env when the app is already connected", async () => {
    const { api, reverifyEnv } = makeNativeApi({ appRunning: true, connected: true });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.example.app" }
      )
    ).resolves.toEqual({
      envSetup: true,
      appRunning: true,
      connected: true,
      requiresRestart: false,
      state: "connected",
      nextLaunchWillBeInjected: true,
      injectable: true,
    });

    expect(reverifyEnv).not.toHaveBeenCalled();
  });

  it("reports a stopped app as launch-ready without requiring restart", async () => {
    const { api } = makeNativeApi({ appRunning: false, connected: false });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.example.app" }
      )
    ).resolves.toEqual({
      envSetup: true,
      appRunning: false,
      connected: false,
      requiresRestart: false,
      state: "not_running",
      message: expect.stringContaining("launch-app") as string,
      nextLaunchWillBeInjected: true,
      injectable: true,
    });
  });

  it("reports a com.apple.* system app as a terminal, non-injectable state", async () => {
    // Apple system apps can never load the dylib. Even with the app running and
    // env set up, status must report injectable:false and neither require a
    // restart nor promise the next launch will be injected — otherwise an agent
    // loops restart-app → retry forever.
    const { api, reverifyEnv } = makeNativeApi({
      appRunning: true,
      connected: false,
      envSetup: true,
    });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.apple.Preferences" }
      )
    ).resolves.toEqual({
      envSetup: true,
      appRunning: true,
      connected: false,
      requiresRestart: false,
      nextLaunchWillBeInjected: false,
      injectable: false,
    });

    // A non-injectable app is terminal — there is nothing to repair, so the
    // stale-latch reverify path must not run.
    expect(reverifyEnv).not.toHaveBeenCalled();
  });

  it("reports the terminal non-injectable state even when env init has given up", async () => {
    // The precheck's init_failed block must not mask the statically-knowable
    // terminal signal: its "re-boot the simulator" guidance can never make a
    // system app injectable. Mirrors the same ordering inside
    // precheckNativeDevtools (terminal case before the env plumbing).
    const { api, ensureEnvReady } = makeNativeApi({
      appRunning: true,
      initFailure: {
        attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
        lastError: "ensureEnv timeout",
        givenUp: true,
      },
    });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.apple.Preferences" }
      )
    ).resolves.toEqual({
      envSetup: false,
      appRunning: true,
      connected: false,
      requiresRestart: false,
      nextLaunchWillBeInjected: false,
      injectable: false,
    });

    // No env work is spent on an app that can never inject.
    expect(ensureEnvReady).not.toHaveBeenCalled();
  });

  it("falls back to init_failed when the sim cannot even be probed (dead sim, broken env)", async () => {
    // The terminal branch probes isAppRunning (a simctl spawn); on a shut-down
    // or unreachable sim that rejects — exactly the sims where env init fails
    // too. A raw subprocess throw here would be unstructured; the precheck's
    // init_failed guidance (re-boot the simulator) IS corrective for a dead
    // sim, so it must win when the env is broken.
    const { api } = makeNativeApi({
      initFailure: {
        attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
        lastError: "ensureEnv timeout",
        givenUp: true,
      },
    });
    api.isAppRunning = async () => {
      throw new Error("simctl spawn failed: current state: Shutdown");
    };

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.apple.Preferences" }
      )
    ).resolves.toMatchObject({ status: "init_failed" });
  });

  // The twin of the injectable path's escalation, on the branch that runs no env
  // work of its own: once `ensureEnvReady` latches, a failure recorded since is
  // the only witness left that the sim is gone — and one sim state must not read
  // as a dead sim on one bundle id and a raw `simctl spawn` throw on another.
  it("surfaces a recorded env failure for a non-injectable app on a latched env", async () => {
    const { api } = makeNativeApi({
      envSetup: true,
      initFailure: { attempts: 1, lastError: "Invalid device", givenUp: false },
    });
    api.isAppRunning = async () => {
      throw new Error("simctl spawn failed: Invalid device");
    };

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.apple.Preferences" }
      )
    ).resolves.toMatchObject({ status: "init_failed", attempts: 1 });
  });

  it("rethrows the probe failure for a non-injectable app when the env is healthy", async () => {
    // With a healthy env there is no init_failed to fall back to — a transient
    // isAppRunning failure must surface, not be swallowed into a made-up state.
    const { api } = makeNativeApi({ envSetup: true });
    api.isAppRunning = async () => {
      throw new Error("transient simctl failure");
    };

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "11111111-1111-1111-1111-111111111111", bundleId: "com.apple.Preferences" }
      )
    ).rejects.toThrow("transient simctl failure");
  });
});

describe("isInjectableBundleId", () => {
  it("treats com.apple.* system apps as non-injectable", () => {
    expect(isInjectableBundleId("com.apple.Preferences")).toBe(false);
    expect(isInjectableBundleId("com.apple.mobilesafari")).toBe(false);
    // Matched case-insensitively: iOS treats bundle ids case-insensitively and
    // Apple owns the com.apple namespace in every casing, so a stray mixed-case
    // id must not slip through as injectable and drop the agent into a restart loop.
    expect(isInjectableBundleId("com.Apple.Preferences")).toBe(false);
    expect(isInjectableBundleId("COM.APPLE.PREFERENCES")).toBe(false);
  });

  it("treats third-party apps as injectable", () => {
    expect(isInjectableBundleId("com.example.MyApp")).toBe(true);
    expect(isInjectableBundleId("com.latekvo.pokemon")).toBe(true);
    // Prefix match is exact — a lookalike that only contains the substring is
    // still injectable.
    expect(isInjectableBundleId("com.appleseed.App")).toBe(true);
  });
});

describe("precheckNativeDevtools — non-injectable terminal error", () => {
  const UDID = "33333333-3333-3333-3333-333333333333";

  it("throws NATIVE_DEVTOOLS_NOT_INJECTABLE for a com.apple.* bundle (3-arg)", async () => {
    const { api } = makeNativeApi({ appRunning: true, connected: false });

    await expect(precheckNativeDevtools(api, UDID, "com.apple.Preferences")).rejects.toBeInstanceOf(
      FailureError
    );

    try {
      await precheckNativeDevtools(api, UDID, "com.apple.Preferences");
      throw new Error("expected precheckNativeDevtools to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FailureError);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
    }
  });

  it("does not throw for the same api via the 2-arg overload (status / launch-app / restart-app path)", async () => {
    const { api } = makeNativeApi({ appRunning: true, connected: false });

    await expect(precheckNativeDevtools(api, UDID)).resolves.toBeNull();
  });

  it("throws the terminal error even when env init has given up", async () => {
    // Injectability is a static property of the bundle id — a broken env must
    // not mask the terminal signal behind init_failed's "re-boot the simulator"
    // guidance, which can never make a system app injectable.
    const { api } = makeNativeApi({
      initFailure: {
        attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
        lastError: "ensureEnv timeout",
        givenUp: true,
      },
    });

    try {
      await precheckNativeDevtools(api, UDID, "com.apple.Preferences");
      throw new Error("expected precheckNativeDevtools to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FailureError);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
    }
  });

  it("fires before any env work — ensureEnvReady never runs for a non-injectable bundle", async () => {
    // Same ordering guarantee from the other side: no env-setup work is spent
    // on an app that can never load the dylib, and a transiently failing
    // ensureEnvReady cannot swallow the terminal signal.
    const { api } = makeNativeApi({
      initFailure: { attempts: 1, lastError: "first attempt failed", givenUp: false },
    });
    const ensureEnvReady = vi.fn(async () => {
      throw new Error("transient ensureEnv failure");
    });
    api.ensureEnvReady = ensureEnvReady;

    try {
      await precheckNativeDevtools(api, UDID, "com.apple.Preferences");
      throw new Error("expected precheckNativeDevtools to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FailureError);
      expect(getFailureSignal(err)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
    }
    expect(ensureEnvReady).not.toHaveBeenCalled();
  });
});

describe("non-injectable recovery guidance is consistent and points only at working tools", () => {
  const UDID = "55555555-5555-5555-5555-555555555555";

  it("recommends describe and screenshot but only warns the agent OFF the native-* tools", () => {
    // The recovery must send the agent to tools that actually work on a system
    // app; the view-at-point tools re-run this same precheck and re-throw, so
    // recommending them dead-ends. describe/screenshot are recommended, and the
    // view-at-point tools appear only inside the "do not fall back" warning.
    expect(NON_INJECTABLE_RECOVERY).toMatch(/`describe`/);
    expect(NON_INJECTABLE_RECOVERY).toMatch(/`screenshot`/);
    expect(NON_INJECTABLE_RECOVERY).toContain(NON_INJECTABLE_NATIVE_WARNING);
    expect(NON_INJECTABLE_NATIVE_WARNING).toMatch(
      /Do not fall back to the native-devtools feature tools/
    );
    expect(NON_INJECTABLE_NATIVE_WARNING).toContain("native-view-at-point");
    // The recommendation clause itself never names a native-* tool outside the
    // warning, so nothing points the agent back at a dead-end.
    const recommendationOnly = NON_INJECTABLE_RECOVERY.replace(NON_INJECTABLE_NATIVE_WARNING, "");
    expect(recommendationOnly).not.toContain("native-");
  });

  it("the precheck throw and the status description share the recovery guidance verbatim", async () => {
    // The precheck throw, the status description, and the describe fallback hint
    // used to recommend different tool sets. They now share the dead-end warning
    // verbatim, so no surface can drift into recommending a native-* tool. This
    // test covers the two pre-describe surfaces, which additionally share the
    // full describe/screenshot recommendation; the third surface (the describe
    // fallback hint) is asserted in describe-tool.test.ts.
    expect(nativeDevtoolsStatusTool.description).toContain(NON_INJECTABLE_RECOVERY);

    let message = "";
    try {
      await precheckNativeDevtools(makeNativeApi({}).api, UDID, "com.apple.Preferences");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(NON_INJECTABLE_RECOVERY);
    expect(message).toContain(NON_INJECTABLE_NATIVE_WARNING);
  });
});

describe("native-* feature tools — the non-injectable throw propagates out of execute()", () => {
  // The NATIVE_DEVTOOLS_NOT_INJECTABLE guard lives only in the shared precheck;
  // every 3-arg feature tool relies on that throw propagating straight out of
  // its execute() (none wraps the precheck in a try/catch). The precheck-level
  // unit above proves the precheck throws, but not that each tool surfaces it —
  // a later refactor that swallowed the throw inside a tool would leave that
  // unit green while regressing the terminal behavior. Assert it at every tool
  // boundary so that regression can't slip through.
  const U = "44444444-4444-4444-4444-444444444444";
  const SYSTEM_APP = "com.apple.Preferences";
  // The non-injectable throw fires in the precheck before appRunning/connected/
  // appConnectionState are ever consulted, so the mock's device state is inert
  // here — default it so nothing reads as if the restart logic were exercised.
  const mkApi = () => makeNativeApi({}).api;

  async function expectNotInjectableThrow(run: () => Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await run();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FailureError);
    expect(getFailureSignal(caught)?.error_code).toBe(FAILURE_CODES.NATIVE_DEVTOOLS_NOT_INJECTABLE);
  }

  it("native-describe-screen surfaces NATIVE_DEVTOOLS_NOT_INJECTABLE", () =>
    expectNotInjectableThrow(() =>
      nativeDescribeScreenTool.execute(
        { nativeDevtools: mkApi() },
        { udid: U, bundleId: SYSTEM_APP }
      )
    ));

  it("native-find-views surfaces NATIVE_DEVTOOLS_NOT_INJECTABLE", () =>
    expectNotInjectableThrow(() =>
      nativeFindViewsTool.execute({ nativeDevtools: mkApi() }, { udid: U, bundleId: SYSTEM_APP })
    ));

  it("native-full-hierarchy surfaces NATIVE_DEVTOOLS_NOT_INJECTABLE", () =>
    expectNotInjectableThrow(() =>
      nativeFullHierarchyTool.execute(
        { nativeDevtools: mkApi() },
        { udid: U, bundleId: SYSTEM_APP }
      )
    ));

  it("native-network-logs surfaces NATIVE_DEVTOOLS_NOT_INJECTABLE", () =>
    expectNotInjectableThrow(() =>
      nativeNetworkLogsTool.execute(
        { nativeDevtools: mkApi() },
        { udid: U, bundleId: SYSTEM_APP, limit: 50, clear: false }
      )
    ));

  it("native-view-at-point surfaces NATIVE_DEVTOOLS_NOT_INJECTABLE", () =>
    expectNotInjectableThrow(() =>
      nativeViewAtPointTool.execute(
        { nativeDevtools: mkApi() },
        { udid: U, bundleId: SYSTEM_APP, x: 0, y: 0 }
      )
    ));

  it("native-user-interactable-view-at-point surfaces NATIVE_DEVTOOLS_NOT_INJECTABLE", () =>
    expectNotInjectableThrow(() =>
      nativeUserInteractableViewAtPointTool.execute(
        { nativeDevtools: mkApi() },
        { udid: U, bundleId: SYSTEM_APP, x: 0, y: 0 }
      )
    ));
});

describe("native-devtools tools — init_failed precheck", () => {
  const FAILED_UDID = "22222222-2222-2222-2222-222222222222";

  it("native-describe-screen returns init_failed when the api reports givenUp", async () => {
    const { api } = makeNativeApi({
      initFailure: {
        attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
        lastError: "ensureEnv timeout",
        givenUp: true,
      },
    });

    const result = await nativeDescribeScreenTool.execute(
      { nativeDevtools: api },
      { udid: FAILED_UDID, bundleId: "com.example.app" }
    );
    expect(result).toMatchObject({
      status: "init_failed",
      attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
    });
    if (result.status === "init_failed") {
      expect(result.message).toContain(FAILED_UDID);
      expect(result.message).toContain("ensureEnv timeout");
    }
  });

  it("native-describe-screen proceeds normally below the cap", async () => {
    const { api } = makeNativeApi({
      initFailure: {
        attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS - 1,
        lastError: "transient",
        givenUp: false,
      },
    });
    api.appConnectionState = async () => "stale_process";

    const result = await nativeDescribeScreenTool.execute(
      { nativeDevtools: api },
      { udid: FAILED_UDID, bundleId: "com.example.app" }
    );
    expect(result).toMatchObject({ status: "restart_required" });
  });

  it("native-devtools-status returns init_failed when the api reports givenUp", async () => {
    const { api } = makeNativeApi({
      initFailure: {
        attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
        lastError: "simctl spawn timed out",
        givenUp: true,
      },
    });

    const result = await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: FAILED_UDID, bundleId: "com.example.app" }
    );
    expect(result).toMatchObject({ status: "init_failed" });
  });

  it("converts a transient ensureEnvReady throw into init_failed (fail-fast)", async () => {
    const { api } = makeNativeApi({
      initFailure: {
        attempts: 1,
        lastError: "first attempt failed",
        givenUp: false,
      },
    });
    api.ensureEnvReady = async () => {
      throw new Error("transient ensureEnv failure");
    };

    const result = await nativeDescribeScreenTool.execute(
      { nativeDevtools: api },
      { udid: FAILED_UDID, bundleId: "com.example.app" }
    );
    expect(result).toMatchObject({ status: "init_failed", attempts: 1 });
    if (result.status === "init_failed") {
      expect(result.message).toContain(FAILED_UDID);
    }
  });
});

// A status asserted for every unconnected app would keep "call restart-app"
// literally true forever, and an agent obeying it restarts indefinitely. Each
// measured state has to reach the agent as the action that actually applies.
describe("precheckNativeDevtools maps a measured state to its remedy", () => {
  function precheckWith(state: NativeDevtoolsAppState) {
    const { api } = makeNativeApi({ envSetup: true, appRunning: true, state });
    return precheckNativeDevtools(api, "UDID", "com.example.app");
  }

  it("leads with restart-app for a process that predates the injection", async () => {
    const result = await precheckWith("stale_process");

    expect(result).toMatchObject({ status: "restart_required" });
    const message = (result as { message: string }).message;
    expect(message).toContain("restart-app");
    // The escalation belongs to states we could not measure; naming it here puts
    // "restart the tool-server" in front of an app that just needs a relaunch.
    expect(message).not.toContain("argent server stop");
  });

  it("does not tell a stale_process it is uninjected — one route into it is injected", async () => {
    // `stale_process` is reached both by a process carrying no argent injection
    // and by an injected one older than this service's listener, so "not
    // injected" is false on the second — which is where the `unregistered`
    // remedy lands an agent: a tool-server restart rebinds the same socket path
    // under a fresh `listeningSince`.
    const result = await precheckWith("stale_process");

    const message = (result as { message: string }).message;
    expect(message).not.toContain("not injected");
    expect(message).toContain("cannot reach");
    expect(message).toContain("restart-app");
  });

  it("points a stopped app at launch-app rather than a restart", async () => {
    const result = await precheckWith("not_running");

    expect(result).toMatchObject({ status: "restart_required" });
    expect((result as { message: string }).message).toContain("launch-app");
  });

  it("refuses to call an injected-but-unregistered process a restart_required", async () => {
    // The loop this whole derivation exists to break: the process already
    // launched under exactly the terms restart-app would recreate.
    const result = await precheckWith("unregistered");

    expect(result).toMatchObject({ status: "service_stale" });
    const message = (result as { message: string }).message;
    expect(message).toContain("argent server stop && argent server start --detach");
    expect(message).toContain("Restarting the app cannot change that");
    expect(message).not.toContain("restart-app");
  });

  it("refuses to call a still-connecting process a restart_required", async () => {
    // The other self-perpetuating advice: exec starts the dial, so a relaunch
    // discards the handshake AND resets the age this verdict reads. Not
    // `indeterminate` either — the process WAS inspected.
    const result = await precheckWith("connecting");

    expect(result).toMatchObject({ status: "connect_pending" });
    const message = (result as { message: string }).message;
    expect(message).toContain("Wait a few seconds");
    // The prohibition itself, not just the absence of the hyphenated tool name:
    // "wait a few seconds, then relaunch the app and retry" satisfies every
    // other assertion here while prescribing the one action that resets the age
    // this verdict reads. The sibling `unregistered` case above pins its
    // prohibition the same way.
    //
    // Matched with its colon, so it is the UNQUALIFIED form: this state is the
    // one where not even a single relaunch is right — it discards a handshake
    // that is already in flight — and "Do NOT restart the app more than once"
    // permits exactly that while still containing the bare phrase.
    expect(message).toContain("Do NOT restart the app:");
    // And the reason, so the prohibition cannot be left standing without the
    // fact that makes it true.
    expect(message).toContain("a relaunch discards the one in progress");
    expect(message).not.toContain("restart-app");
    expect(message).not.toContain("could not be inspected");
  });

  it("keeps the loop warning for a process it could not inspect", async () => {
    // ios-remote and an unreadable process table land here: restart-app is
    // still the right first move, but nothing measured says it will work, so
    // the way out of the loop has to travel with it.
    const result = await precheckWith("indeterminate");

    expect(result).toMatchObject({ status: "restart_required" });
    const message = (result as { message: string }).message;
    expect(message).toContain("restart-app");
    expect(message).toContain("argent server stop && argent server start --detach");
    expect(message).toContain("do not keep restarting the app");
  });

  // `argent server start` defaults to the foreground and never returns, so the
  // bare pair hangs whoever runs it. Every surface prescribing the tool-server
  // restart must pass --detach.
  it("prescribes a tool-server restart that actually returns", async () => {
    for (const state of ["unregistered", "indeterminate"] as const) {
      const message = (await precheckWith(state)) as { message: string };
      expect(message.message, state).toContain("argent server start --detach");
    }
  });

  // Any expression that admits `unregistered` or `connecting` — including the
  // obvious `appRunning && !connected` — leaves the boolean saying "restart the
  // app" beside a message saying a restart cannot help, and the description
  // tells agents to branch on the boolean.
  it("never asks for a restart of an app a restart provably cannot fix", async () => {
    for (const state of ["unregistered", "connecting"] as const) {
      const { api } = makeNativeApi({ envSetup: true, appRunning: true, state });

      const result = (await nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "UDID", bundleId: "com.example.app" }
      )) as { requiresRestart: boolean; state: string };

      expect(result.requiresRestart, `${state} must not require a restart`).toBe(false);
      expect(result.state).toBe(state);
    }
  });

  // A sim that dies mid-call makes the measurement reject. Without the guard the
  // raw subprocess error escapes execute() instead of the structured answer.
  it("degrades a rejected measurement instead of letting it escape the tool", async () => {
    const { api } = makeNativeApi({ envSetup: true, appRunning: true });
    api.appConnectionState = async () => {
      throw new Error("Invalid device: UDID");
    };

    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as { state?: string; message?: string };

    expect(result.state).toBe("indeterminate");
    expect(result.message).toContain("do not keep restarting the app");
  });

  // `connected` has to come off the same measurement as `state`, not a second
  // `isConnected()` read: a connection landing between the two would pair
  // `connected: true` with a state saying the service never registered it.
  it("reads connected from the one measurement, not a second probe", async () => {
    const { api } = makeNativeApi({ envSetup: true, appRunning: true, state: "unregistered" });
    api.isConnected = () => true; // the map moved on after the measurement began

    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as { connected: boolean; state: string };

    expect(result.connected).toBe(false);
    expect(result.state).toBe("unregistered");
  });

  // The precheck is the path all six native-* feature tools take. A rejection
  // here (the env re-apply, on a sim that went away) must not reach the agent as
  // a raw subprocess error — and must never be swallowed as "connected", which
  // would let all six proceed to query a connection that does not exist.
  it("degrades a rejected measurement rather than letting it escape or pass", async () => {
    const { api } = makeNativeApi({ envSetup: true, appRunning: true });
    api.appConnectionState = async () => {
      throw new Error("Invalid device: UDID");
    };

    const result = await precheckNativeDevtools(api, "UDID", "com.example.app");

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ status: "restart_required" });
    expect((result as { message: string }).message).toContain("do not keep restarting the app");
  });

  // When that same rejection came with a recorded env failure, the sim itself is
  // gone — which is init_failed's case, not a connection diagnosis.
  it("reports a dead sim as init_failed rather than an unmeasured connection", async () => {
    const { api } = makeNativeApi({ envSetup: true, appRunning: true });
    api.getInitFailure = () => ({ attempts: 2, lastError: "Invalid device", givenUp: false });
    api.appConnectionState = async () => {
      throw new Error("Invalid device: UDID");
    };

    const result = await precheckNativeDevtools(api, "UDID", "com.example.app");

    expect(result).toMatchObject({ status: "init_failed", attempts: 2 });
  });

  it("passes a connected app straight through", async () => {
    await expect(precheckWith("connected")).resolves.toBeNull();
  });

  it("reads running-ness out of the state instead of a second device probe", async () => {
    // `appConnectionState` already runs `launchctl list`, and re-verifies the
    // env first — so a separate `isAppRunning` is both an extra round-trip and a
    // snapshot taken seconds apart, which is how `appRunning: true` could land
    // beside `state: "not_running"`. Only `indeterminate` may pay for a probe.
    for (const state of [
      "connected",
      "not_running",
      "stale_process",
      "unregistered",
      "connecting",
    ] as const) {
      const { api, isAppRunning } = makeNativeApi({ envSetup: true, connected: false, state });

      const result = (await nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "UDID", bundleId: "com.example.app" }
      )) as { appRunning: boolean; state: string };

      expect(isAppRunning, `${state} must not re-probe the device`).not.toHaveBeenCalled();
      expect(result.state).toBe(state);
      expect(result.appRunning).toBe(state !== "not_running");
    }

    const { api, isAppRunning } = makeNativeApi({
      envSetup: true,
      connected: false,
      appRunning: true,
      state: "indeterminate",
    });
    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as { appRunning: boolean; requiresRestart: boolean };

    expect(isAppRunning).toHaveBeenCalledTimes(1);
    expect(result.appRunning).toBe(true);
    expect(result.requiresRestart).toBe(true);
  });

  // Without this pin, collapsing the mapping back to a single status leaves
  // every precheck-level test green while the agent silently gets restart-app
  // guidance again.
  it("carries service_stale out through every native-* tool", async () => {
    const tools = [
      nativeDescribeScreenTool,
      nativeFindViewsTool,
      nativeFullHierarchyTool,
      nativeNetworkLogsTool,
      nativeViewAtPointTool,
      nativeUserInteractableViewAtPointTool,
    ];

    for (const tool of tools) {
      const { api } = makeNativeApi({
        envSetup: true,
        appRunning: true,
        state: "unregistered",
      });

      const result = (await tool.execute(
        { nativeDevtools: api },
        {
          udid: "UDID",
          bundleId: "com.example.app",
          x: 1,
          y: 1,
          className: "UIView",
          limit: 1,
          clear: false,
        }
      )) as { status: string; message: string };

      expect(result.status, `${tool.id} must report service_stale`).toBe("service_stale");
      expect(result.message).toContain("argent server stop && argent server start --detach");
      expect(result.message).not.toContain("restart-app");
    }
  });

  // The booleans cannot say "one restart, then stop". `requiresRestart: true` is
  // the whole of what an `indeterminate` app reports, and the only state a
  // running app reaches on ios-remote — so without the prose the tool hands back
  // the restart loop and nothing else.
  it("hands back the loop escape for the states the booleans cannot express", async () => {
    for (const state of ["indeterminate", "stale_process", "not_running"] as const) {
      const { api } = makeNativeApi({ envSetup: true, appRunning: true, state });

      const result = (await nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "UDID", bundleId: "com.example.app" }
      )) as { message?: string };

      expect(result.message, `${state} must carry its remedy`).toBeDefined();
      expect(result.message).toContain("com.example.app");
    }

    const { api: indeterminate } = makeNativeApi({
      envSetup: true,
      appRunning: true,
      state: "indeterminate",
    });
    const escape = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: indeterminate },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as { message?: string; requiresRestart: boolean };
    expect(escape.requiresRestart).toBe(true);
    expect(escape.message).toContain("do not keep restarting the app");
    expect(escape.message).toContain("argent server stop && argent server start --detach");

    // A connected app has no remedy to carry, so the field must not appear at
    // all — an empty-string or stale message would read as a live problem.
    const { api: healthy } = makeNativeApi({ envSetup: true, connected: true });
    const ok = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: healthy },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as Record<string, unknown>;
    expect(ok).not.toHaveProperty("message");
  });

  // Telling an agent to restart something the same payload says is not running
  // is the contradiction deriving both from one measurement prevents. Only
  // `indeterminate` re-probes, so only it can produce the pair.
  it("does not ask for a restart of an app the probe says is not running", async () => {
    const { api } = makeNativeApi({
      envSetup: true,
      appRunning: false,
      state: "indeterminate",
    });

    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as { appRunning: boolean; requiresRestart: boolean };

    expect(result.appRunning).toBe(false);
    expect(result.requiresRestart).toBe(false);
    // `message` is the field the description tells agents to prefer, so it has
    // to agree too: the `indeterminate` text opens "Call restart-app then
    // retry", which contradicts `appRunning: false` outright.
    const withMessage = result as unknown as { state: string; message: string };
    expect(withMessage.state).toBe("not_running");
    expect(withMessage.message).toContain("launch-app");
    expect(withMessage.message).not.toContain("could not be inspected");
  });

  // The dead-sim escalation has to fire on the FIRST failure, not the third.
  // Re-running the precheck would report nothing — `ensureEnvReady` succeeded at
  // the top of the call and latches — so reading the failure `reverifyEnv` just
  // recorded is what turns a shut-down simulator into structured guidance
  // instead of a raw `Command failed: xcrun simctl spawn …`.
  it("surfaces init_failed on a dead sim before the service has given up", async () => {
    const { api } = makeNativeApi({ envSetup: true, state: "indeterminate" });
    api.getInitFailure = () => ({ attempts: 1, lastError: "Invalid device", givenUp: false });
    api.isAppRunning = vi.fn(async () => {
      throw new Error("Invalid device: UDID");
    });

    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as { status?: string; message?: string; attempts?: number };

    expect(result.status).toBe("init_failed");
    expect(result.attempts).toBe(1);
    expect(result.message).toContain("Invalid device");
  });

  // These are the two fields an agent reads to decide a launch is worth it, and
  // `isEnvSetup()` is a latch that never clears — so on a simulator whose
  // launchd env was wiped it keeps answering yes, and the agent relaunches into
  // an uninjected process forever. A failure the measurement's re-apply recorded
  // is the one thing that contradicts the latch.
  it("stops promising an injected launch once the env re-apply has failed", async () => {
    const { api } = makeNativeApi({ envSetup: true, appRunning: true, state: "stale_process" });
    api.getInitFailure = () => ({ attempts: 1, lastError: "Invalid device", givenUp: false });

    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as { envSetup: boolean; nextLaunchWillBeInjected: boolean };

    expect(result.envSetup).toBe(false);
    expect(result.nextLaunchWillBeInjected).toBe(false);
  });

  // The other half of that reading, and the reason it is conditional. The
  // recorded failure only contradicts the latch where something re-applied the
  // env to record it — `appConnectionState` does that for an app it finds
  // UNCONNECTED. A connected one answers off the connections map first, so the
  // record beside it is whatever an earlier call for another bundle left, and
  // nothing re-tests it while this app stays connected: the reading would be
  // wrong for as long as the app is up, against a process that is demonstrably
  // injected.
  it("keeps reporting the env a live connection proves was in place", async () => {
    const { api, reverifyEnv } = makeNativeApi({ envSetup: true, connected: true });
    api.getInitFailure = () => ({ attempts: 1, lastError: "Invalid device", givenUp: false });

    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as { envSetup: boolean; connected: boolean; nextLaunchWillBeInjected: boolean };

    // The premise: nothing on this path re-applied the env, so the failure it
    // would have consulted is stale by construction.
    expect(reverifyEnv).not.toHaveBeenCalled();
    expect(result.connected).toBe(true);
    expect(result.envSetup).toBe(true);
    expect(result.nextLaunchWillBeInjected).toBe(true);
  });

  // Same rule on the terminal branch, which runs no env work at all — and a
  // system app CAN be connected there (#453 saw one runtime refuse the dylib,
  // an E2E run another accept it), so the same contradiction is reachable.
  it("keeps reporting a working env for a connected non-injectable app", async () => {
    const { api } = makeNativeApi({ envSetup: true, connected: true, appRunning: true });
    api.getInitFailure = () => ({ attempts: 1, lastError: "Invalid device", givenUp: false });

    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.apple.Preferences" }
    )) as { envSetup: boolean; connected: boolean; injectable: boolean };

    expect(result.injectable).toBe(false);
    expect(result.connected).toBe(true);
    expect(result.envSetup).toBe(true);
  });

  // Same reading on the branch that runs no env work of its own: a system app
  // on a sim whose env is broken must not report the env as in place either.
  it("stops reporting a working env for a non-injectable app once it has failed", async () => {
    const { api } = makeNativeApi({ envSetup: true, appRunning: true });
    api.getInitFailure = () => ({ attempts: 1, lastError: "Invalid device", givenUp: false });

    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.apple.Preferences" }
    )) as { envSetup: boolean };

    expect(result.envSetup).toBe(false);
  });

  // A sim that dies mid-call is healthy at every earlier read: the entry
  // precheck saw a working service and `getInitFailure` was still null on the
  // way in. Hoisting the read out of the catch reports that stale null and lets
  // the raw subprocess error out.
  it("reads the recorded failure after the probe, not before it", async () => {
    const { api } = makeNativeApi({ envSetup: true, state: "indeterminate" });
    let died = false;
    api.getInitFailure = () =>
      died
        ? { attempts: MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS, lastError: "sim gone", givenUp: true }
        : null;
    api.isAppRunning = vi.fn(async () => {
      died = true;
      throw new Error("Invalid device: UDID");
    });

    const result = (await nativeDevtoolsStatusTool.execute(
      { nativeDevtools: api },
      { udid: "UDID", bundleId: "com.example.app" }
    )) as { status?: string; message?: string };

    expect(result.status).toBe("init_failed");
    expect(result.message).toContain("sim gone");
  });

  // The other half of that branch: with no recorded failure the env is healthy,
  // so the probe's own error is the honest answer. Degrading it would report a
  // reading the tool never took.
  it("lets the probe's error out when the env recorded no failure", async () => {
    const { api } = makeNativeApi({ envSetup: true, state: "indeterminate" });
    api.getInitFailure = () => null;
    api.isAppRunning = vi.fn(async () => {
      throw new Error("Invalid device: UDID");
    });

    await expect(
      nativeDevtoolsStatusTool.execute(
        { nativeDevtools: api },
        { udid: "UDID", bundleId: "com.example.app" }
      )
    ).rejects.toThrow("Invalid device: UDID");
  });
});

// Descriptions are what an agent reads before ever calling, so one that names
// restart_required while staying silent about service_stale rebuilds the loop in
// the more prominent place, whatever the runtime message says.
describe("native-* tool descriptions document every precheck outcome", () => {
  const tools = [
    nativeDescribeScreenTool,
    nativeFindViewsTool,
    nativeFullHierarchyTool,
    nativeNetworkLogsTool,
    nativeViewAtPointTool,
    nativeUserInteractableViewAtPointTool,
  ];

  it("names service_stale and its tool-server remedy alongside restart_required", () => {
    for (const tool of tools) {
      expect(tool.description, `${tool.id} must mention restart_required`).toContain(
        "restart_required"
      );
      expect(tool.description, `${tool.id} must mention service_stale`).toContain("service_stale");
      expect(tool.description, `${tool.id} must mention connect_pending`).toContain(
        "connect_pending"
      );
      // `init_failed` and `injection_failed` are the two members whose remedy is
      // neither a restart nor a wait — an agent with no arm for the first
      // retries a simulator that needs re-booting, and one with no arm for the
      // second keeps restarting an app whose dylib dyld never loads.
      expect(tool.description, `${tool.id} must mention init_failed`).toContain("init_failed");
      expect(tool.description, `${tool.id} must mention injection_failed`).toContain(
        "injection_failed"
      );
      expect(tool.description, `${tool.id} must name the tool-server remedy`).toContain(
        "argent server stop && argent server start --detach"
      );
    }
  });

  // All six throw the identical terminal NATIVE_DEVTOOLS_NOT_INJECTABLE error
  // for a com.apple.* bundle id, and it is the one outcome an agent can act on
  // BEFORE spending a call, off `tools/list`. Half of them describing a terminal
  // arm and half not is what makes an agent believe the silent ones might work.
  it("names the terminal system-app rejection on every tool that performs it", () => {
    for (const tool of tools) {
      expect(tool.description, `${tool.id} must name the system-app rejection`).toMatch(
        /Apple system app is rejected outright/
      );
      expect(tool.description, `${tool.id} must mark it terminal`).toMatch(/never retry it/);
    }
  });

  /**
   * The one `If state is <state>:` line out of the description.
   *
   * A whole-description `toContain` is not a pin on any of them: the guidance
   * lines echo each other closely enough that deleting one outright leaves its
   * assertions satisfied by a sibling — "do NOT restart the app again" appears
   * verbatim in the `indeterminate` line too — and the field list and the
   * `injectable: false` paragraph between them supply most of the remaining
   * words, down to "describe" inside `native-describe-screen`.
   */
  function guidanceLine(state: NativeDevtoolsAppState): string {
    const prefix = `If state is ${state}:`;
    const line = nativeDevtoolsStatusTool
      .description!.split("\n")
      .find((l) => l.startsWith(prefix));
    expect(line, `description has no "${prefix}" line`).toBeTypeOf("string");
    return line!;
  }

  it("tells native-devtools-status readers to wait out a connecting app", () => {
    expect(guidanceLine("connecting")).toContain("do NOT restart the app");
  });

  it("tells native-devtools-status readers not to restart an unregistered app", () => {
    expect(guidanceLine("unregistered")).toContain("do NOT restart the app again");
  });

  // Every remedy in the set is individually correct and together they close into
  // a ring: the tool-server restart this state prescribes rebinds the listener,
  // so the same never-dialing process reads `stale_process` (it now predates the
  // listener) -> restart-app -> `connecting` -> `unregistered` again, unbounded.
  // Nothing measured separates the first landing from the second, so both
  // surfaces have to hand the reader the test — as `not_running` and
  // `indeterminate` already do. Without it this PR lengthens the loop it fixes.
  it("gives an unregistered app a way out of the remedy cycle on its second landing", () => {
    const message = buildAppStateMessage("com.example.app", "unregistered");
    const line = guidanceLine("unregistered");

    // Pinned as each surface's own conditional clause rather than a shared
    // /already|again/: the description line opens "If state is unregistered: do
    // NOT restart the app again", so a loose pattern matches the wrapper the
    // escape sits in and survives the escape being deleted from it.
    expect(message).toContain("If you have already restarted the tool-server for this app");
    expect(line).toContain("If it reads unregistered again after that restart");

    for (const [name, text] of [
      ["message", message],
      ["description", line],
    ] as const) {
      // Conditional, so "stop" is not the last word: a reader who has spent both
      // remedies needs somewhere to go.
      expect(text, `${name} names no terminal fallback`).toMatch(
        /treat native devtools as unavailable/i
      );
      // A tool that reads the screen WITHOUT injection. Pointing back at a
      // native-* tool re-enters the same precheck, which is the cycle again with
      // an extra hop — and `native-describe-screen` contains "describe", so the
      // tool name has to be matched on its own.
      expect(text, `${name} names no injection-free reader`).toMatch(/\bscreenshot\b/);
      expect(text, `${name} falls back to a tool behind the same precheck`).not.toMatch(
        /native-(describe-screen|find-views|full-hierarchy|network-logs|view-at-point)/
      );
    }
  });

  // `indeterminate` gives the agent `requiresRestart: true` and nothing else, so
  // the description is where "restart once, then stop" has to be stated. It is
  // also the only unconnected state a running app reaches on a remote simulator.
  it("bounds the restart advice for a process it could not inspect", () => {
    // Over the whole description neither assertion says anything about this
    // line: the prefix is all the first one needs, and the `unregistered` line
    // supplies the command verbatim. So the bound this test is named for — the
    // one stop-condition on the description side for the only unconnected state
    // a running app reaches on ios-remote — could be deleted outright.
    const line = guidanceLine("indeterminate");
    expect(line).toContain("do NOT restart the app again");
    expect(line).toContain("argent server stop && argent server start --detach");
  });

  // `indeterminate` sets `requiresRestart: true`, so it matches the boolean
  // rule as well as its own `If state is` line — and an agent that acts on the
  // earlier, more general rule never reaches the later one. That earlier rule
  // is where the bound has to be stated, and on a remote simulator it is the
  // ordinary path rather than a rare one: no app process can be inspected
  // there, so `indeterminate` is the only unconnected state a running app can
  // reach. Verbatim for the reason the stop-conditions below are: the failure
  // is a softened or deleted bound, which any pattern over the opening clause
  // reads straight past.
  it("bounds the requiresRestart rule rather than leaving it open", () => {
    const line = nativeDevtoolsStatusTool
      .description!.split("\n")
      .find((l) => l.startsWith("If requiresRestart is true:"));
    expect(line, "description has no requiresRestart rule").toBeTypeOf("string");
    expect(line!).toBe(
      "If requiresRestart is true: call restart-app once, then proceed with the native feature. " +
        "Read state before acting on a second such reading — indeterminate reaches this rule too, " +
        "and its line below bounds it at that one restart."
    );
  });

  // Rename a state in one place and the prose describes names the tool never
  // emits — which no runtime assertion catches, because both sides still agree
  // with themselves. Exhaustive by construction: a record fails to compile when
  // a state joins the union unlisted, where a hand-written array silently omits.
  const ALL_STATES: Record<NativeDevtoolsAppState, true> = {
    connected: true,
    not_running: true,
    stale_process: true,
    unregistered: true,
    connecting: true,
    indeterminate: true,
  };

  it("spells every emitted state exactly as the description names it", () => {
    const states = Object.keys(ALL_STATES) as NativeDevtoolsAppState[];
    for (const state of states) {
      expect(nativeDevtoolsStatusTool.description, `description must name ${state}`).toContain(
        `"${state}"`
      );
    }
  });

  // `argent server start` defaults to the foreground and never returns, so an
  // agent that runs it as written is gone. Checked per occurrence, not per blob:
  // a surface holding two satisfies a whole-blob `toContain` with one still
  // bare.
  it("never prescribes a tool-server restart the agent cannot return from", () => {
    const BARE_START = /argent server start(?! --detach)/;
    // A surface with no text at all would vacuously satisfy the check below.
    const described = (name: string, text: string | undefined): [string, string] => {
      expect(text, `${name} has no text to check`).toBeTypeOf("string");
      return [name, text!];
    };
    const surfaces: [string, string][] = [
      described("native-devtools-status description", nativeDevtoolsStatusTool.description),
      ...tools.map((t) => described(`${t.id} description`, t.description)),
      ...(Object.keys(ALL_STATES) as NativeDevtoolsAppState[])
        .filter((s): s is Exclude<NativeDevtoolsAppState, "connected"> => s !== "connected")
        .map((s): [string, string] => [`${s} message`, buildAppStateMessage("com.example.app", s)]),
    ];

    for (const [name, text] of surfaces) {
      expect(text, `${name} prescribes a foreground tool-server start`).not.toMatch(BARE_START);
    }
    // The regex only fires on text that mentions the command at all, so prove
    // the surfaces that must mention it do — otherwise deleting the guidance
    // outright passes as "no bare start".
    expect(buildAppStateMessage("com.example.app", "unregistered")).toContain(
      "argent server start"
    );
    expect(nativeDevtoolsStatusTool.description).toContain("argent server start");
  });

  // One agent reads the tool description AND the message the same call returns.
  // The descriptions must be plain literals (extract-tools.mjs reads them
  // statically), so the wording is copied eight ways and nothing but this pins
  // the copies together — which is how six of them kept telling the reader to
  // wait "a second or two" after the connect budget outgrew it and the
  // other two were updated.
  it("agrees with the message on how long a connecting app is worth waiting for", () => {
    const surfaces: [string, string][] = [
      ["connecting message", buildAppStateMessage("com.example.app", "connecting")],
      ["native-devtools-status description", guidanceLine("connecting")],
      ...tools.map((t): [string, string] => [`${t.id} description`, t.description!]),
    ];
    for (const [name, text] of surfaces) {
      expect(text, `${name} has no wait guidance to check`).toMatch(/wait a few seconds/i);
      // The wording the budget outgrew. Pinned as its own assertion so the
      // failure names the drift rather than a missing phrase.
      expect(text, `${name} still quotes the pre-budget wait`).not.toMatch(/second or two/i);
    }
    // The six carry their own phrasing of the prohibition, so they need their
    // own pin — and it has to reject a qualified one for the same reason the
    // message's does: the first relaunch is already the one that discards the
    // handshake, so "do not restart it more than once" is wrong advice that
    // still contains "do not restart it".
    for (const tool of tools) {
      expect(tool.description!, `${tool.id} qualifies the connecting prohibition`).toContain(
        "do not restart it, wait"
      );
    }
  });

  // Same split surface, same hazard: round 2 gave `unregistered` a landing that
  // terminates, and the six tool descriptions route `service_stale` — the status
  // that state maps to — with their own copy of the remedy.
  it("stops every service_stale surface from prescribing an unbounded tool-server restart", () => {
    for (const tool of tools) {
      const routing = tool
        .description!.split("\n")
        .find((l) => l.includes("If status is service_stale:"));
      expect(routing, `${tool.id} does not route service_stale`).toBeTypeOf("string");
      expect(
        routing!,
        `${tool.id} prescribes a tool-server restart with no second landing`
      ).toMatch(/if the same status comes back|stop restarting/i);
    }
  });

  /**
   * The remedy prose an agent obeys to decide whether to STOP, pinned verbatim.
   *
   * Every other assertion in this file matches an opening clause, and that has
   * repeatedly proved to constrain nothing: the claim can be negated by a
   * sentence appended after the part that matched ("go ahead and relaunch … keep
   * relaunching until it connects"), qualified inside it ("do NOT restart the app
   * MORE THAN ONCE"), or scoped away ("restart the tool-server AGAIN and keep
   * retrying until it clears") — each of which reopens the unbounded loop this
   * whole change exists to close, with every pattern still green.
   *
   * A pattern cannot fix that, because the defect is always in the words it did
   * not look at. So these strings are duplicated here on purpose, exactly as
   * NON_INJECTABLE_RECOVERY is: rewording one has to fail, be re-read, and be
   * re-approved rather than absorbed. Edit both together.
   */
  const CONNECTING_PROHIBITION =
    "Do NOT restart the app: launching it is what starts the connection, so a relaunch " +
    "discards the one in progress and returns you to this same state.";
  const UNREGISTERED_ESCAPE =
    "If you have already restarted the tool-server for this app and it reads this way again, " +
    "stop: the process is loading argent's dylib but never dialing, which no further restart on " +
    "either side fixes. Treat native devtools as unavailable — read the screen with describe or " +
    "screenshot and drive it by coordinate.";
  const INDETERMINATE_ESCALATION =
    "If it is still not connected after that restart, the native-devtools service is stale rather " +
    "than the app being uninjected — do not keep restarting the app; restart the tool-server " +
    "(`argent server stop && argent server start --detach`) and retry.";

  /**
   * An instruction to retry without bound, in any of the ways these surfaces
   * could phrase one.
   *
   * The pins below all constrain a SLICE of a surface — a named line, a clause
   * between two markers, the final sentence — and every round of review has
   * found the same defect in whatever slice was left over: a second guidance
   * line for the same state, a clause appended past the last marker, a
   * permitting sentence before the pinned tail. Pinning more slices only moves
   * the gap, so this asks the one question that does not depend on where the
   * text sits: does this surface, anywhere, tell an agent to keep going?
   *
   * A clause that FORBIDS one is the point of these messages, so it is the
   * un-negated ones that fail.
   */
  const UNBOUNDED_RETRY =
    /keep [\w-]+ing|more than once|again and again|a couple more|until (it|connected)\b|ignore the stop/i;
  // Deliberately not a bare `stop`: "ignore the stop-conditions above and keep
  // calling restart-app" contains the word while saying the opposite, so the
  // escape hatch would have covered for the negation it exists to allow.
  const FORBIDDEN =
    /\bdo not\b|\bdo NOT\b|\bnever\b|\bcannot\b|\bno further\b|\bat most\b|\bstop (restarting|:)/i;

  /** Split on sentence and clause boundaries, so polarity is judged locally. */
  function clausesOf(text: string): string[] {
    return text
      .split(/(?<=[.;:])\s+|\s+—\s+|\n/)
      .map((c) => c.trim())
      .filter(Boolean);
  }

  it("never tells an agent to keep retrying, on any surface that carries a remedy", () => {
    const surfaces: [string, string][] = [
      ...(Object.keys(ALL_STATES) as NativeDevtoolsAppState[])
        .filter((s): s is Exclude<NativeDevtoolsAppState, "connected"> => s !== "connected")
        .flatMap((s): [string, string][] => [
          [`${s} message`, buildAppStateMessage("com.example.app", s)],
          // The flow gate rewrites every state for a reader who has just
          // launched, so it is a second copy of the same remedies on a surface
          // none of the verbatim pins reach.
          [`${s} flow-gate reason`, flowLaunchGateReason("com.example.app", s)],
        ]),
      ["native-devtools-status description", nativeDevtoolsStatusTool.description!],
      ...tools.map((t): [string, string] => [`${t.id} description`, t.description!]),
    ];

    for (const [name, text] of surfaces) {
      for (const clause of clausesOf(text)) {
        if (!UNBOUNDED_RETRY.test(clause)) continue;
        expect(FORBIDDEN.test(clause), `${name} permits an unbounded retry: "${clause}"`).toBe(
          true
        );
      }
    }
  });

  it("gives each state exactly one guidance line to obey", () => {
    // A verbatim `toBe` on the first matching line says nothing about a second
    // one appended later, which an agent reads just as readily.
    const lines = nativeDevtoolsStatusTool.description!.split("\n");
    for (const state of Object.keys(ALL_STATES) as NativeDevtoolsAppState[]) {
      const matches = lines.filter((l) => l.startsWith(`If state is ${state}:`));
      expect(matches.length, `description routes ${state} ${matches.length} times`).toBeLessThan(2);
    }
  });

  // The six feature tools' arm is pinned verbatim below, but native-devtools-status
  // carries its own wording and is the surface the flow-recovery ladder sends an
  // author to (argent-create-flow/references/reliability-and-recovery.md step 3).
  // Unpinned, the arm can be dropped while that doc keeps promising it — and the
  // prohibition it has to carry is the tool-server one, since this description
  // prescribes exactly that restart four lines above for `state: unregistered`.
  it("routes injection_failed on native-devtools-status, forbidding both restarts", () => {
    const line = nativeDevtoolsStatusTool
      .description!.split("\n")
      .find((l) => l.startsWith('Returns { status: "injection_failed"'));
    expect(line, "description has no injection_failed line").toBeTypeOf("string");
    expect(line).toBe(
      'Returns { status: "injection_failed", message } instead once this app has been told to restart, has done so, and the fresh process still never connected — the dylib reaches the process but nothing ever dials. This is a TERMINAL state: do NOT restart the app again and do NOT restart the tool-server, read the message for the likely cause and use `describe` or `screenshot` instead.'
    );
  });

  it("routes exactly the five precheck statuses on every native-* tool", () => {
    // The clause pins below bound each slice by the next clause or the line's
    // end, so a SIXTH clause is what would be unconstrained on all six at once.
    for (const tool of tools) {
      const count = tool.description!.match(/If status is /g)?.length ?? 0;
      expect(count, `${tool.id} routes ${count} statuses`).toBe(5);
    }
  });

  it.each([
    ["connecting", CONNECTING_PROHIBITION],
    ["unregistered", UNREGISTERED_ESCAPE],
    ["indeterminate", INDETERMINATE_ESCALATION],
    [
      "not_running",
      "If that launch fails rather than starting the app, the bundle id is not installed on this " +
        "device — this state cannot tell the two apart; install it and no relaunch will be needed.",
    ],
    ["stale_process", "A fresh process picks up the current one: call restart-app then retry."],
  ] as const)("ends the %s message on its stop-condition, verbatim", (state, tail) => {
    // `endsWith`, not `toContain`: the failure mode is a permitting sentence
    // AFTER the stop-condition, which any containment check reads straight past.
    const message = buildAppStateMessage("com.example.app", state);
    expect(message.trimEnd().endsWith(tail), `${state} message does not end on its remedy`).toBe(
      true
    );
  });

  it.each([
    [
      "connecting",
      "If state is connecting: do NOT restart the app — launching it is what starts the connection, so a relaunch discards the one in progress and returns this same state. Wait a few seconds and repeat this call.",
    ],
    [
      "unregistered",
      "If state is unregistered: do NOT restart the app again — it already launched under the terms a restart would recreate. Restart the tool-server (`argent server stop && argent server start --detach`), then retry. If it reads unregistered again after that restart, stop: the process loads argent's dylib but never dials, and no further restart on either side changes it — treat native devtools as unavailable, then use `describe` or `screenshot` and drive by coordinate.",
    ],
    [
      "indeterminate",
      "If state is indeterminate: the process could not be inspected, so restart-app is worth one attempt. If this call still reports it after that restart, do NOT restart the app again — the service is stale rather than the app uninjected, so restart the tool-server (`argent server stop && argent server start --detach`) and retry. Remote simulators can never inspect the process, so this is the only unconnected state a running app reaches there.",
    ],
  ] as const)("routes %s in the description exactly as written", (state, line) => {
    expect(guidanceLine(state)).toBe(line);
  });

  it.each([
    [
      "connect_pending",
      "If status is connect_pending: the app is injected and still connecting — do not restart it, wait a few seconds and retry.",
    ],
    [
      "service_stale",
      "If status is service_stale: the app is already injected, so restarting it cannot help — restart the tool-server (`argent server stop && argent server start --detach`) and retry. If the same status comes back after that restart, stop restarting: follow the message, which names the terminal fallback.",
    ],
    [
      "injection_failed",
      "If status is injection_failed: the app was told to restart, did, and the fresh process still never connected — the dylib reaches the process but nothing ever dials, so this is TERMINAL. Do NOT restart the app again and do NOT restart the tool-server; read the message for the likely cause and use the standard `describe` tool or `screenshot` instead.",
    ],
  ])("routes %s identically on all six native-* tools", (status, clause) => {
    for (const tool of tools) {
      const start = tool.description!.indexOf(`If status is ${status}:`);
      expect(start, `${tool.id} does not route ${status}`).toBeGreaterThanOrEqual(0);
      // The routing clauses share one line, and the last one has no clause after
      // it — bound by the line's end too, or its pin would swallow the sentences
      // below and no verbatim match could hold.
      const rest = tool.description!.slice(start);
      const next = rest.slice(1).search(/If status is |\n/);
      expect(rest.slice(0, next === -1 ? undefined : next + 1).trim(), tool.id).toBe(clause);
    }
  });

  // Whether the dylib loads into an Apple system app is not settled — #453
  // recorded `connected: false` on iOS 26.5, an E2E run `connected: true` on
  // 18.5 — and one agent reads every surface below, so hedging one while its
  // twin says "can never" is what misleads. The DECISION (terminal, do not
  // retry) is unchanged; only the certainty claimed for it has to agree.
  it("does not claim injection is impossible on any agent-facing surface", () => {
    // Fails loudly on an absent description rather than letting the regex below
    // pass over `undefined`, which would satisfy a negative match vacuously.
    const described = (name: string, text: string | undefined): [string, string] => {
      expect(text, `${name} has no text, so this check would be vacuous`).toBeTypeOf("string");
      return [name, text!];
    };
    const surfaces: [string, string][] = [
      described("native-devtools-status description", nativeDevtoolsStatusTool.description),
      ...tools.map((t) => described(`${t.id} description`, t.description)),
      described("non-injectable recovery", NON_INJECTABLE_RECOVERY),
    ];

    for (const [name, text] of surfaces) {
      expect(text, `${name} asserts injection is impossible`).not.toMatch(
        /can never (be injected|load|inject)/
      );
    }
    // Softening the claim must not soften the behaviour, or the restart loop
    // #453 reported comes straight back.
    expect(nativeDevtoolsStatusTool.description).toMatch(/Do NOT restart\/retry/);
  });

  // `not_running` is the absence of a `UIKitApplication:<id>` row, which an
  // uninstalled bundle id lacks too. Prescribing only launch-app makes it a loop
  // of its own there: `simctl launch` refuses, and the state's single remedy is
  // spent. Naming the second reading gives that agent somewhere to go.
  it("admits that not_running cannot see whether the app is installed", () => {
    const message = buildAppStateMessage("com.nonexistent.TotallyFake", "not_running");

    expect(message).toContain("launch-app");
    expect(message).toMatch(/not installed/);
    // The claim has to be scoped to this state's evidence, not asserted as a
    // measurement it never took.
    expect(message).toMatch(/cannot tell the two apart/);
  });
});
