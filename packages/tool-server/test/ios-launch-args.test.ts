import { beforeEach, describe, expect, it, vi } from "vitest";

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
  return { ...actual, execFile: (...args: unknown[]) => (execFileMock as any)(...args) };
});

vi.mock("../src/utils/ios-devices", () => ({
  isTvOsSimulator: vi.fn(async () => false),
}));

import type { NativeDevtoolsApi } from "../src/blueprints/native-devtools";
import { createLaunchAppTool } from "../src/tools/launch-app";
import { createRestartAppTool } from "../src/tools/restart-app";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const REMOTE_UDID = `remote:${IOS_UDID}`;
const BUNDLE_ID = "dev.example.app";
const LAUNCH_ARGS = ["-EXDevMenuIsOnboardingFinished", "1", "-EXDevMenuShowsAtLaunch", "0"];

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
    appConnectionState: async () => "connected",
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

function expectLaunchCall(command: "xcrun" | "sim-remote") {
  const call = execFileMock.mock.calls.find(
    ([executable, args]) =>
      executable === command && Array.isArray(args) && args[0] === "simctl" && args[1] === "launch"
  );

  expect(call?.slice(0, 2)).toEqual([
    command,
    ["simctl", "launch", IOS_UDID, BUNDLE_ID, ...LAUNCH_ARGS],
  ]);
}

beforeEach(() => {
  execFileMock.mockClear();
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun", "sim-remote"]);
});

describe("iOS launch arguments", () => {
  it("launch-app forwards arguments to local simctl launch", async () => {
    const tool = createLaunchAppTool(makeRegistry());

    await tool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, launchArgs: LAUNCH_ARGS });

    expectLaunchCall("xcrun");
  });

  it("restart-app forwards arguments to local simctl launch", async () => {
    const tool = createRestartAppTool(makeRegistry());

    await tool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, launchArgs: LAUNCH_ARGS });

    expectLaunchCall("xcrun");
  });

  it("launch-app forwards arguments to remote simctl launch", async () => {
    const tool = createLaunchAppTool(makeRegistry());

    await tool.execute!(
      { nativeDevtools: makeNativeApi() },
      { udid: REMOTE_UDID, bundleId: BUNDLE_ID, launchArgs: LAUNCH_ARGS }
    );

    expectLaunchCall("sim-remote");
  });

  it("restart-app forwards arguments to remote simctl launch", async () => {
    const tool = createRestartAppTool(makeRegistry());

    await tool.execute!(
      { nativeDevtools: makeNativeApi() },
      { udid: REMOTE_UDID, bundleId: BUNDLE_ID, launchArgs: LAUNCH_ARGS }
    );

    expectLaunchCall("sim-remote");
  });
});
