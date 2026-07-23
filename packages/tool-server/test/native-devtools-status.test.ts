import { describe, expect, it, vi } from "vitest";
import { FailureError, FAILURE_CODES, getFailureSignal } from "@argent/registry";
import {
  isInjectableBundleId,
  NON_INJECTABLE_NATIVE_WARNING,
  NON_INJECTABLE_RECOVERY,
  precheckNativeDevtools,
  MAX_NATIVE_DEVTOOLS_INIT_ATTEMPTS,
  type NativeDevtoolsApi,
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
}): {
  api: NativeDevtoolsApi;
  ensureEnvReady: ReturnType<typeof vi.fn>;
  reverifyEnv: ReturnType<typeof vi.fn>;
} {
  let envSetup = options.envSetup ?? false;
  const ensureEnvReady = vi.fn(async () => {
    envSetup = true;
  });
  const reverifyEnv = vi.fn(async () => {
    envSetup = true;
  });

  return {
    api: {
      isEnvSetup: () => envSetup,
      socketPath: "/tmp/mock.sock",
      ensureEnvReady,
      reverifyEnv,
      getInitFailure: () => options.initFailure ?? null,
      isConnected: () => options.connected ?? false,
      isAppRunning: async () => options.appRunning ?? false,
      listConnectedBundleIds: () => [],
      requiresAppRestart: async () => {
        throw new Error("native-devtools-status should compute restart guidance directly");
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
  // requiresAppRestart are ever consulted, so the mock's device state is inert
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
    api.requiresAppRestart = async () => true;

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

// `requiresAppRestart` reports true for every unconnected app and keeps no count
// of how often it has already said so. When a connection never registers, the
// "call restart-app" advice stays true forever and an agent obeying it restarts
// the app indefinitely, so the message has to name the way out of that loop.
describe("precheckNativeDevtools restart guidance", () => {
  function apiRequiringRestart(): NativeDevtoolsApi {
    const { api } = makeNativeApi({ envSetup: true, appRunning: true });
    api.requiresAppRestart = async () => true;
    return api;
  }

  it("still leads with restart-app, which is the usual and sufficient fix", async () => {
    const result = await precheckNativeDevtools(apiRequiringRestart(), "UDID", "com.example.app");

    expect(result).toMatchObject({ status: "restart_required" });
    expect((result as { message: string }).message).toContain("Call restart-app then retry.");
  });

  it("names the tool-server restart so a stale service is not an unbounded app-restart loop", async () => {
    const result = await precheckNativeDevtools(apiRequiringRestart(), "UDID", "com.example.app");

    const message = (result as { message: string }).message;
    expect(message).toContain("argent server stop && argent server start");
    expect(message).toContain("do not keep restarting the app");
  });
});
