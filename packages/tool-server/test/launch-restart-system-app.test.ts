import { describe, it, expect, vi, beforeEach } from "vitest";

// launch-app / restart-app must keep working for Apple system apps: launching
// or restarting com.apple.* is legitimate — the app just never injects. They
// stay safe from the terminal NATIVE_DEVTOOLS_NOT_INJECTABLE throw only
// because all four iOS call sites use the 2-arg precheckNativeDevtools
// overload (no bundleId). Unlike launch-restart-tvos.test.ts, the REAL
// precheck runs here — these tests pin the tool boundary so a call site
// "improved" to pass params.bundleId (3-arg) starts failing loudly instead of
// shipping a launch-app that throws on Settings/Safari. A plain udid
// dispatches the local iOS sites (platforms/ios.ts); a `remote:`-prefixed
// udid dispatches the ios-remote sites (platforms/shared.ts) — all four are
// covered.

const execFileMock = vi.fn(
  (
    _cmd: string,
    _args: readonly string[],
    opts: unknown,
    cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
  ) => {
    const callback = typeof opts === "function" ? opts : cb!;
    callback(null, { stdout: "", stderr: "" });
  }
);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...a: unknown[]) => (execFileMock as any)(...a) };
});

vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
}));

import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const REMOTE_UDID = `remote:${IOS_UDID}`;
const SYSTEM_APP = "com.apple.Preferences";

// Minimal api satisfying what the real 2-arg precheck consults
// (getInitFailure + ensureEnvReady); the rest must stay untouched.
function makeNativeApi(): NativeDevtoolsApi {
  return {
    isEnvSetup: () => true,
    socketPath: "/tmp/test.sock",
    ensureEnvReady: async () => {},
    reverifyEnv: async () => {},
    getInitFailure: () => null,
    isConnected: () => false,
    isAppRunning: async () => false,
    listConnectedBundleIds: () => [],
    requiresAppRestart: async () => false,
    activateNetworkInspection: () => {},
    getNetworkLog: () => [],
    clearNetworkLog: () => {},
    getAppState: async () => {
      throw new Error("not implemented");
    },
    detectFrontmostBundleId: async () => null,
    queryViewHierarchy: async () => ({}),
  } as NativeDevtoolsApi;
}

function makeRegistry() {
  return { resolveService: vi.fn(async () => makeNativeApi() as unknown) } as any;
}

beforeEach(() => {
  execFileMock.mockClear();
  // The local branch requires xcrun, the remote branch sim-remote; prime both
  // so neither probes the host toolchain (Linux CI has neither).
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun", "sim-remote"]);
});

describe("launch-app / restart-app — Apple system apps stay launchable (real precheck)", () => {
  it("launch-app launches com.apple.* without the non-injectable terminal throw", async () => {
    const tool = createLaunchAppTool(makeRegistry());

    await expect(tool.execute!({}, { udid: IOS_UDID, bundleId: SYSTEM_APP })).resolves.toEqual({
      launched: true,
      bundleId: SYSTEM_APP,
    });
  });

  it("restart-app restarts com.apple.* without the non-injectable terminal throw", async () => {
    const tool = createRestartAppTool(makeRegistry());

    await expect(tool.execute!({}, { udid: IOS_UDID, bundleId: SYSTEM_APP })).resolves.toEqual({
      restarted: true,
      bundleId: SYSTEM_APP,
    });
  });

  it("launch-app (ios-remote) launches com.apple.* without the terminal throw", async () => {
    // The remote branch reads services.nativeDevtools instead of resolving
    // lazily; the shared handler (platforms/shared.ts) runs the same real
    // 2-arg precheck.
    const tool = createLaunchAppTool(makeRegistry());

    await expect(
      tool.execute!(
        { nativeDevtools: makeNativeApi() },
        { udid: REMOTE_UDID, bundleId: SYSTEM_APP }
      )
    ).resolves.toEqual({ launched: true, bundleId: SYSTEM_APP });
  });

  it("restart-app (ios-remote) restarts com.apple.* without the terminal throw", async () => {
    const tool = createRestartAppTool(makeRegistry());

    await expect(
      tool.execute!(
        { nativeDevtools: makeNativeApi() },
        { udid: REMOTE_UDID, bundleId: SYSTEM_APP }
      )
    ).resolves.toEqual({ restarted: true, bundleId: SYSTEM_APP });
  });
});
