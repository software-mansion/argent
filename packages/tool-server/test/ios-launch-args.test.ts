import { beforeEach, describe, expect, it, vi } from "vitest";

function succeed(
  _cmd: string,
  _args: readonly string[],
  opts: unknown,
  cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
) {
  const callback = typeof opts === "function" ? opts : cb!;
  callback(null, { stdout: "", stderr: "" });
}

const execFileMock = vi.fn(succeed);

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
    armsEnv: true,
    withdrawEnv: async () => {},
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

function simctlCalls(command: "xcrun" | "sim-remote", subcommand: "launch" | "terminate") {
  return execFileMock.mock.calls.filter(
    ([executable, args]) =>
      executable === command &&
      Array.isArray(args) &&
      args[0] === "simctl" &&
      args[1] === subcommand
  );
}

function expectTerminateBeforeLaunch(command: "xcrun" | "sim-remote") {
  const subcommands = execFileMock.mock.calls
    .filter(([executable, args]) => executable === command && args[0] === "simctl")
    .map(([, args]) => args[1]);
  expect(subcommands).toEqual(["terminate", "launch"]);
  expect(simctlCalls(command, "terminate")[0]?.[1]).toEqual([
    "simctl",
    "terminate",
    IOS_UDID,
    BUNDLE_ID,
  ]);
}

beforeEach(() => {
  execFileMock.mockClear();
  execFileMock.mockImplementation(succeed);
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

  it("launch-app terminates a running app before launching with arguments (local)", async () => {
    const tool = createLaunchAppTool(makeRegistry());

    await tool.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, launchArgs: LAUNCH_ARGS });

    expectTerminateBeforeLaunch("xcrun");
  });

  it("launch-app terminates a running app before launching with arguments (remote)", async () => {
    const tool = createLaunchAppTool(makeRegistry());

    await tool.execute!(
      { nativeDevtools: makeNativeApi() },
      { udid: REMOTE_UDID, bundleId: BUNDLE_ID, launchArgs: LAUNCH_ARGS }
    );

    expectTerminateBeforeLaunch("sim-remote");
  });

  it.each([
    ["omitted", undefined],
    ["empty", []],
  ])("launch-app does not terminate when arguments are %s", async (_label, launchArgs) => {
    const local = createLaunchAppTool(makeRegistry());
    await local.execute!({}, { udid: IOS_UDID, bundleId: BUNDLE_ID, launchArgs });
    const remote = createLaunchAppTool(makeRegistry());
    await remote.execute!(
      { nativeDevtools: makeNativeApi() },
      { udid: REMOTE_UDID, bundleId: BUNDLE_ID, launchArgs }
    );

    expect(simctlCalls("xcrun", "terminate")).toHaveLength(0);
    expect(simctlCalls("sim-remote", "terminate")).toHaveLength(0);
    expect(simctlCalls("xcrun", "launch")[0]?.[1]).toEqual([
      "simctl",
      "launch",
      IOS_UDID,
      BUNDLE_ID,
    ]);
    expect(simctlCalls("sim-remote", "launch")[0]?.[1]).toEqual([
      "simctl",
      "launch",
      IOS_UDID,
      BUNDLE_ID,
    ]);
  });

  it.each([
    ["local", IOS_UDID, "xcrun"],
    ["remote", REMOTE_UDID, "sim-remote"],
  ] as const)(
    "launch-app ignores a terminate failure and still launches (%s)",
    async (_label, udid, command) => {
      execFileMock.mockImplementation((cmd, args, opts, cb) => {
        if (args[1] !== "terminate") return succeed(cmd, args, opts, cb);
        const callback = typeof opts === "function" ? opts : cb!;
        callback(new Error("found nothing to terminate"), { stdout: "", stderr: "" });
      });
      const tool = createLaunchAppTool(makeRegistry());

      const result = await tool.execute!(
        { nativeDevtools: makeNativeApi() },
        { udid, bundleId: BUNDLE_ID, launchArgs: LAUNCH_ARGS }
      );

      expect(result).toEqual({ launched: true, bundleId: BUNDLE_ID });
      expectLaunchCall(command);
    }
  );
});
