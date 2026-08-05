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
  // work of its own. Once `ensureEnvReady` has succeeded it latches, so the
  // precheck below stops probing and reports nothing; a failure an injectable
  // app's `reverifyEnv` recorded since then is the only witness left that the
  // sim is gone, and the same sim state must not read as a dead sim on one
  // bundle id and a raw `simctl spawn` throw on another.
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
// literally true forever, and an agent obeying it restarts indefinitely. The
// status is derived from the running process, so each state has to reach the
// agent as the action that actually applies to it.
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
    // The escalation belongs to states we could not measure. Naming it here too
    // would put "maybe restart the tool-server" in front of an agent whose app
    // demonstrably just needs relaunching.
    expect(message).not.toContain("argent server stop");
  });

  it("does not tell a stale_process it is uninjected — one route into it is injected", async () => {
    // `stale_process` is reached both by a process carrying no argent injection
    // and by an injected one older than this service's listener. A message
    // asserting "not injected" is false on the second — and the second is where
    // the `unregistered` remedy lands an agent: restarting the tool-server
    // rebinds the same socket path under a fresh `listeningSince`, leaving the
    // untouched process injected against it yet older than it.
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
    // The other self-perpetuating advice: exec is what starts the dial, so a
    // relaunch discards the handshake in flight AND resets the age this verdict
    // is read from — an agent obeying restart-app re-enters this window every
    // time. It is also not `indeterminate`: the process WAS inspected, and it
    // is injected against this endpoint.
    const result = await precheckWith("connecting");

    expect(result).toMatchObject({ status: "connect_pending" });
    const message = (result as { message: string }).message;
    expect(message).toContain("Wait a second or two");
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

  // `argent server start` defaults to foreground (parseStartFlags: detach:false)
  // and ends in a promise that never resolves, so the bare pair hangs whoever
  // runs it. Every surface prescribing the tool-server restart must pass
  // --detach or the remedy is a command the agent cannot return from.
  it("prescribes a tool-server restart that actually returns", async () => {
    for (const state of ["unregistered", "indeterminate"] as const) {
      const message = (await precheckWith(state)) as { message: string };
      expect(message.message, state).toContain("argent server start --detach");
    }
  });

  // The one invariant the whole derivation exists for, at the tool that reports
  // it. Any expression that admits `unregistered` or `connecting` — including
  // the obvious `appRunning && !connected` — leaves the boolean saying "restart
  // the app" beside a message saying a restart cannot help, and the description
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
    // `appConnectionState` already runs `launchctl list`, and it re-verifies the
    // launchd env first — so a separate `isAppRunning` is both an extra simctl
    // round-trip and a snapshot taken seconds apart from the one `state` came
    // from, which is how `appRunning: true` could be reported beside
    // `state: "not_running"`. Five of the six states settle running-ness on
    // their own; only `indeterminate` may pay for its own probe.
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

  // The precheck's mapping only matters if it survives the trip out through a
  // tool. Without this pin, collapsing the mapping back to a single status
  // would leave every precheck-level test green while the agent silently gets
  // restart-app guidance again.
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
  // the whole of what an `indeterminate` app reports, and it is the only state a
  // running app reaches on ios-remote — so without the prose, the tool whose job
  // is to answer "is this ready?" hands back the restart loop and nothing else.
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

  // `requiresRestart` must never contradict `appRunning`: telling an agent to
  // restart something the same payload says is not running is the self-
  // contradiction deriving both from one measurement exists to prevent. Only
  // `indeterminate` re-probes, so it is the only state that can produce the pair.
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
    // retry", which contradicts `appRunning: false` outright. The probe answered
    // the question `indeterminate` left open, so the state resolves to it.
    const withMessage = result as unknown as { state: string; message: string };
    expect(withMessage.state).toBe("not_running");
    expect(withMessage.message).toContain("launch-app");
    expect(withMessage.message).not.toContain("could not be inspected");
  });

  // The dead-sim escalation has to fire on the FIRST failure, not the third.
  // Re-running `precheckNativeDevtools` here would report nothing: reaching this
  // point means it already drove `ensureEnvReady` to success at the top of the
  // call, and that latches, so every later call short-circuits. Reading the
  // failure `reverifyEnv` just recorded is what turns a shut-down simulator into
  // structured guidance instead of a raw `Command failed: xcrun simctl spawn …`.
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

  // `envSetup` and `nextLaunchWillBeInjected` are the two fields an agent reads
  // to decide that launching is worth it. `isEnvSetup()` is a latch that never
  // clears, so on its own it keeps answering yes for a simulator whose launchd
  // env was wiped — and the agent relaunches into an uninjected process, reads
  // "not connected", and relaunches again. The re-apply the measurement
  // performs is what actually tests the env; a failure it recorded is the one
  // thing that contradicts the latch.
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

  // The failure is read in the catch, after the probe — not sampled before it.
  // A sim that dies mid-call is healthy at every earlier read: the entry
  // precheck saw a working service and `getInitFailure` was still null on the
  // way in. Hoisting the read (or reusing the value the entry precheck already
  // saw) reports the stale null and lets the raw subprocess error out.
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

  // The other half of that branch. With no recorded failure the env is healthy,
  // so the probe's own error is the honest answer and must reach the caller —
  // degrading it to some "everything is fine" shape would report a reading the
  // tool never took.
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

// The runtime message is only half the guidance an agent sees: the tool
// descriptions are what it reads before ever calling. A description that names
// restart_required while staying silent about service_stale rebuilds the loop
// in the more prominent place, whatever the message says.
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
      // The fourth member of NativeDevtoolsPrecheckBlock. Every one of these
      // tools returns it verbatim, and it is the only status whose remedy is
      // neither a restart nor a wait — an agent with no arm for it retries a
      // simulator that needs re-booting.
      expect(tool.description, `${tool.id} must mention init_failed`).toContain("init_failed");
      expect(tool.description, `${tool.id} must name the tool-server remedy`).toContain(
        "argent server stop && argent server start --detach"
      );
    }
  });

  // All six throw the identical terminal NATIVE_DEVTOOLS_NOT_INJECTABLE error
  // for a com.apple.* bundle id, but only three said so — and this is the one
  // outcome an agent can act on BEFORE spending a call, by picking a different
  // approach off `tools/list`. Three tools describing the same precheck as
  // having a terminal arm and three not is the shape that makes an agent
  // believe the silent ones might work.
  it("names the terminal system-app rejection on every tool that performs it", () => {
    for (const tool of tools) {
      expect(tool.description, `${tool.id} must name the system-app rejection`).toMatch(
        /Apple system app is rejected outright/
      );
      expect(tool.description, `${tool.id} must mark it terminal`).toMatch(/never retry it/);
    }
  });

  it("tells native-devtools-status readers to wait out a connecting app", () => {
    expect(nativeDevtoolsStatusTool.description).toContain("If state is connecting:");
    expect(nativeDevtoolsStatusTool.description).toContain("do NOT restart the app");
  });

  it("tells native-devtools-status readers not to restart an unregistered app", () => {
    expect(nativeDevtoolsStatusTool.description).toContain("unregistered");
    expect(nativeDevtoolsStatusTool.description).toContain("do NOT restart the app again");
  });

  // `indeterminate` gives the agent `requiresRestart: true` and nothing else, so
  // the description is where "restart once, then stop" has to be stated. It is
  // also the only unconnected state a running app reaches on a remote simulator.
  it("bounds the restart advice for a process it could not inspect", () => {
    expect(nativeDevtoolsStatusTool.description).toContain("If state is indeterminate");
    expect(nativeDevtoolsStatusTool.description).toContain(
      "argent server stop && argent server start --detach"
    );
  });

  // The description is the contract for a value an agent will branch on. Rename
  // a state in one place and the prose starts describing names the tool never
  // emits — which no runtime assertion catches, because both sides still agree
  // with themselves.
  //
  // Exhaustive by construction: this record fails to compile if a state is
  // added to the union without being listed, so a new state cannot ship
  // undocumented the way `connecting` nearly did — a hand-written array
  // silently omits, which is the same drift one level up.
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
  // agent that runs it as written is gone. Every place that prescribes the
  // restart has to carry `--detach` — and it has to be checked per occurrence:
  // a surface holding two of them satisfies a whole-blob `toContain` with one
  // still bare, which is how the second description arm could be stripped on
  // its own with the suite green.
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

  // Whether the dylib loads into an Apple system app is not settled — #453
  // recorded `connected: false` on iOS 26.5, an E2E review `connected: true`
  // with both dylibs mapped on 18.5 — and every surface below is read by the
  // same agent. Hedging one and leaving its twin absolute is what misleads: the
  // flow surfaces say "depends on the runtime" while a tool description said
  // "can never". The DECISION (terminal, do not retry) is unchanged; only the
  // certainty claimed for it has to agree across surfaces.
  it("does not claim injection is impossible on any agent-facing surface", () => {
    // `described` fails loudly on an absent description rather than letting the
    // regex below pass over `undefined` — a surface with no text would satisfy
    // a negative match vacuously.
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

  // `not_running` is derived from the absence of a `UIKitApplication:<id>` row,
  // and a bundle id that was never installed has no row either — so the state
  // cannot tell "installed and stopped" from "not installed". Prescribing only
  // launch-app makes it a loop of its own for the second case: `simctl launch`
  // refuses, and the state's single remedy has already been spent. Naming the
  // second reading is what gives that agent somewhere to go.
  it("admits that not_running cannot see whether the app is installed", () => {
    const message = buildAppStateMessage("com.nonexistent.TotallyFake", "not_running");

    expect(message).toContain("launch-app");
    expect(message).toMatch(/not installed/);
    // The claim has to be scoped to this state's evidence, not asserted as a
    // measurement it never took.
    expect(message).toMatch(/cannot tell the two apart/);
  });
});
