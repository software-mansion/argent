import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAILURE_CODES,
  getFailureSignal,
  withFailureSignal,
  type FailureSignal,
} from "@argent/registry";
import { prepareLaunch, terminateForWarmLaunch } from "../../src/utils/ios-launch-time/workflow";
import { installApp, listIosPhysicalDevices } from "../../src/utils/ios-device/devicectl";
import { listIosSimulators } from "../../src/utils/ios-devices";

// Pins the failure signal of each prepareLaunch step. xcodebuild and xcrun are
// shell scripts on PATH, steered by FAKE_* variables; devicectl discovery and
// install are stubbed.

vi.mock("../../src/utils/ios-device/devicectl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-device/devicectl")>()),
  listIosPhysicalDevices: vi.fn(async () => []),
  ensureDeviceReady: vi.fn(async () => undefined),
  installApp: vi.fn(async () => undefined),
  launchApp: vi.fn(async () => undefined),
}));
vi.mock("../../src/utils/ios-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-devices")>()),
  listIosSimulators: vi.fn(async () => []),
}));
vi.mock("../../src/utils/ios-device-sets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-device-sets")>()),
  simctlPrefix: () => ["simctl"],
}));
vi.mock("../../src/utils/ios-device/runner-signing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-device/runner-signing")>()),
  resolveRunnerSigningConfig: vi.fn(async () => {
    throw new Error("no runner team");
  }),
}));

const XCODEBUILD = `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    -version) echo "Xcode 27.0"; exit 0 ;;
    -list)
      if [ -n "$FAKE_LIST_EXIT" ]; then echo "xcodebuild: error: The project is damaged." >&2; exit "$FAKE_LIST_EXIT"; fi
      echo '{"project":{"schemes":["App"]}}'; exit 0 ;;
    -showBuildSettings) cat "$FAKE_DIR/settings.json"; exit 0 ;;
    build)
      if [ -n "$FAKE_BUILD_SLEEP" ]; then sleep "$FAKE_BUILD_SLEEP"; fi
      if [ -n "$FAKE_BUILD_OUTPUT" ]; then echo "$FAKE_BUILD_OUTPUT"; exit 65; fi
      mkdir -p "$FAKE_DIR/products/App.app"; exit 0 ;;
  esac
done
exit 0
`;

const XCRUN = `#!/bin/sh
case "$1 $2" in
  "simctl install")
    if [ -n "$FAKE_SIMCTL_INSTALL_EXIT" ]; then echo "An error was encountered processing the command" >&2; exit "$FAKE_SIMCTL_INSTALL_EXIT"; fi ;;
  "devicectl device")
    if [ -n "$FAKE_DEVICECTL_EXIT" ]; then echo "ERROR: The device is not connected." >&2; exit "$FAKE_DEVICECTL_EXIT"; fi
    echo '{"result":{"runningProcesses":[]}}' ;;
esac
exit 0
`;

const FAKE_VARS = [
  "FAKE_DIR",
  "FAKE_LIST_EXIT",
  "FAKE_BUILD_OUTPUT",
  "FAKE_BUILD_SLEEP",
  "FAKE_SIMCTL_INSTALL_EXIT",
  "FAKE_DEVICECTL_EXIT",
];

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalPath = process.env.PATH;
let fake = "";
let workspace = "";

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { ...platform, value });
}

async function writeSettings(platformName: "iphonesimulator" | "iphoneos") {
  await writeFile(
    join(fake, "settings.json"),
    JSON.stringify([
      {
        target: "App",
        buildSettings: {
          WRAPPER_EXTENSION: "app",
          PRODUCT_TYPE: "com.apple.product-type.application",
          PLATFORM_NAME: platformName,
          CONFIGURATION: "Release",
          PRODUCT_BUNDLE_IDENTIFIER: "com.example.app",
          TARGET_BUILD_DIR: join(fake, "products"),
          FULL_PRODUCT_NAME: "App.app",
          EXECUTABLE_NAME: "App",
          DEVELOPMENT_TEAM: "TEAM123456",
        },
      },
    ])
  );
}

function useSimulator() {
  vi.mocked(listIosSimulators).mockResolvedValue([
    {
      udid: "SIM-1",
      name: "iPhone 16",
      state: "Booted",
      runtime: "iOS 26.0",
      runtimeKind: "mobile",
    },
  ]);
}

function useIphone(transportType = "wired") {
  vi.mocked(listIosPhysicalDevices).mockResolvedValue([
    {
      udid: "PHONE-1",
      name: "iPhone",
      model: null,
      osVersion: null,
      developerModeEnabled: true,
      pairingState: "paired",
      transportType,
      tunnelState: "connected",
    },
  ]);
}

async function failure(work: Promise<unknown>): Promise<{ error: Error; signal: FailureSignal }> {
  const error = (await work.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e
  )) as Error;
  return { error, signal: getFailureSignal(error)! };
}

const simulatorRequest = () => ({ workspacePath: workspace, allowSimulator: true });

beforeEach(async () => {
  fake = await mkdtemp(join(tmpdir(), "argent-launch-fake-"));
  workspace = await mkdtemp(join(tmpdir(), "argent-launch-ws-"));
  await mkdir(join(workspace, "App.xcodeproj"));
  await mkdir(join(fake, "bin"));
  await writeFile(join(fake, "bin", "xcodebuild"), XCODEBUILD);
  await writeFile(join(fake, "bin", "xcrun"), XCRUN);
  await chmod(join(fake, "bin", "xcodebuild"), 0o755);
  await chmod(join(fake, "bin", "xcrun"), 0o755);
  await writeSettings("iphonesimulator");
  process.env.PATH = `${join(fake, "bin")}:${originalPath}`;
  process.env.FAKE_DIR = fake;
  setPlatform("darwin");
  vi.mocked(listIosPhysicalDevices).mockResolvedValue([]);
  vi.mocked(listIosSimulators).mockResolvedValue([]);
  vi.mocked(installApp).mockResolvedValue(undefined);
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  process.env.PATH = originalPath;
  for (const name of FAKE_VARS) delete process.env[name];
  await rm(fake, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe("prepareLaunch failure signals", () => {
  it("reports a host other than macOS as unsupported", async () => {
    setPlatform("linux");
    const { error, signal } = await failure(prepareLaunch(simulatorRequest()));
    expect(error.message).toBe("iOS launch measurement requires macOS and Xcode.");
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_UNSUPPORTED_HOST,
      failure_stage: "launch_analysis_host_platform",
      error_kind: "unsupported",
    });
  });

  it("reports a missing workspace as invalid input", async () => {
    const { error, signal } = await failure(
      prepareLaunch({ workspacePath: join(workspace, "missing") })
    );
    expect(error.message).toContain("workspace_path is not a directory");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "launch_analysis_workspace_path",
      failure_area: "tool_server",
      error_kind: "not_found",
    });
  });

  it("reports an xcode_container outside the workspace or missing as invalid input", async () => {
    useSimulator();
    const outside = await failure(
      prepareLaunch({ ...simulatorRequest(), xcodeContainer: "../Other.xcodeproj" })
    );
    expect(outside.signal).toMatchObject({
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      failure_stage: "launch_analysis_xcode_container",
      error_kind: "validation",
    });
    const missing = await failure(
      prepareLaunch({ ...simulatorRequest(), xcodeContainer: "Missing.xcodeproj" })
    );
    expect(missing.signal).toMatchObject({
      error_code: FAILURE_CODES.TOOL_INPUT_INVALID,
      error_kind: "not_found",
    });
  });

  it("reports a missing iPhone as an unavailable device", async () => {
    const { error, signal } = await failure(prepareLaunch({ workspacePath: workspace }));
    expect(error.message).toContain("No selected connected iPhone is available");
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_DEVICE_UNAVAILABLE,
      failure_stage: "launch_analysis_select_device",
      error_kind: "not_found",
    });
  });

  it("reports an iPhone off the cable as an unavailable device", async () => {
    useIphone("localNetwork");
    const { signal } = await failure(
      prepareLaunch({ workspacePath: workspace, deviceId: "PHONE-1" })
    );
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_DEVICE_UNAVAILABLE,
      error_kind: "unsupported",
    });
  });

  it("reports a workspace without an Xcode project as unresolved", async () => {
    useSimulator();
    await rm(join(workspace, "App.xcodeproj"), { recursive: true });
    const { signal } = await failure(prepareLaunch(simulatorRequest()));
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_PROJECT_UNRESOLVED,
      failure_stage: "launch_analysis_resolve_container",
      error_kind: "not_found",
    });
  });

  it("reports a failed xcodebuild -list with its exit code", async () => {
    useSimulator();
    process.env.FAKE_LIST_EXIT = "74";
    const { error, signal } = await failure(prepareLaunch(simulatorRequest()));
    expect(error.message).toContain("xcodebuild -list -json -project");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_PROJECT_UNRESOLVED,
      failure_stage: "launch_analysis_resolve_scheme",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xcodebuild",
      failure_exit_code: 74,
    });
  });

  it("reports an unknown scheme as unresolved", async () => {
    useSimulator();
    const { signal } = await failure(prepareLaunch({ ...simulatorRequest(), scheme: "Other" }));
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_PROJECT_UNRESOLVED,
      failure_stage: "launch_analysis_resolve_scheme",
      error_kind: "not_found",
    });
  });

  it("reports a failed app build with the xcodebuild exit code", async () => {
    useSimulator();
    process.env.FAKE_BUILD_OUTPUT = "main.m:1: error: expected expression";
    const { error, signal } = await failure(prepareLaunch(simulatorRequest()));
    expect(error.message).toMatch(/^Release build failed for the app's original bundle ID/);
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_BUILD_FAILED,
      failure_stage: "launch_analysis_build",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xcodebuild",
      failure_exit_code: 65,
    });
  });

  it("reports a signing failure of an iPhone build apart from other build failures", async () => {
    useIphone();
    await writeSettings("iphoneos");
    process.env.FAKE_BUILD_OUTPUT =
      "error: No profiles for 'com.example.app' were found: Xcode couldn't find any iOS App Development provisioning profiles.";
    const { error, signal } = await failure(
      prepareLaunch({ workspacePath: workspace, deviceId: "PHONE-1" })
    );
    expect(error.message).toContain("If signing failed");
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_SIGNING_FAILED,
      failure_stage: "launch_analysis_build",
      failure_command: "xcodebuild",
      failure_exit_code: 65,
    });
  });

  it("reports the free-profile cap at install with the devicectl exit code", async () => {
    useIphone();
    await writeSettings("iphoneos");
    const stderr =
      "This device has reached the maximum number of installed apps using a free developer profile: {(\n" +
      '    "5W6H93822S.com.argent.runner.t5w6h93822s.uitests.xctrunner"\n)}';
    // The devicectl wrapper's own signal stays below the launch tool's.
    const installError = withFailureSignal(
      new Error("Failed to install app: ERROR: Unable to Install “App”", {
        cause: Object.assign(new Error("Command failed"), { code: 1, stderr }),
      }),
      {
        error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
        failure_stage: "ios_devicectl_command",
        failure_area: "tool_server",
        error_kind: "subprocess",
      }
    );
    vi.mocked(installApp).mockRejectedValue(installError);
    const { error, signal } = await failure(
      prepareLaunch({ workspacePath: workspace, deviceId: "PHONE-1" })
    );
    expect(error.message).toContain("no slot for the app com.example.app");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_FREE_PROFILE_LIMIT,
      failure_stage: "launch_analysis_install",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "devicectl",
      failure_exit_code: 1,
    });
  });

  it("reports a failed simctl install with its exit code", async () => {
    useSimulator();
    process.env.FAKE_SIMCTL_INSTALL_EXIT = "2";
    const { error, signal } = await failure(prepareLaunch(simulatorRequest()));
    expect(error.message).toContain("xcrun simctl install SIM-1");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_SIMCTL_FAILED,
      failure_stage: "launch_analysis_simulator_prelaunch",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xcrun_simctl",
      failure_exit_code: 2,
    });
  });

  it("leaves a cancelled build unclassified", async () => {
    useSimulator();
    process.env.FAKE_BUILD_SLEEP = "30";
    const controller = new AbortController();
    const error = prepareLaunch(simulatorRequest(), undefined, controller.signal).catch(
      (e: unknown) => e
    );
    setTimeout(() => controller.abort(), 1_000);
    expect(await error).toMatchObject({ name: "AbortError" });
    expect(getFailureSignal(await error)).toBeNull();
  }, 15_000);
});

describe("terminateForWarmLaunch failure signals", () => {
  const context = (): Parameters<typeof terminateForWarmLaunch>[0] => ({
    runDir: join(workspace, ".argent", "traces", "run"),
    deviceId: "PHONE-1",
    deviceName: "iPhone",
    simulator: false,
    simulatorDeviceSet: null,
    destination: "platform=iOS,id=PHONE-1",
    bundleId: "com.example.app",
    executableName: "App",
    appPath: "/dd/App.app",
    scheme: "App",
    container: join(workspace, "App.xcodeproj"),
    teamId: null,
    warning: null,
  });

  it("reports a failed devicectl process query with its exit code", async () => {
    process.env.FAKE_DEVICECTL_EXIT = "1";
    const { signal } = await failure(terminateForWarmLaunch(context()));
    expect(signal).toEqual({
      error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
      failure_stage: "launch_analysis_warm_terminate",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "devicectl",
      failure_exit_code: 1,
    });
  });

  it("reports an app that is not running before the warm launch", async () => {
    const { error, signal } = await failure(terminateForWarmLaunch(context()));
    expect(error.message).toBe(
      "Could not verify that com.example.app was running before warm-launch capture."
    );
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.IOS_DEVICECTL_COMMAND_FAILED,
      error_kind: "not_found",
      failure_command: "devicectl",
    });
  });
});
