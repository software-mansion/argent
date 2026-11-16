import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAILURE_CODES, getFailureSignal, type FailureSignal } from "@argent/registry";
import { prepareLaunch, terminateForWarmLaunch } from "../../src/utils/ios-launch-time/workflow";
import {
  installedAppUrl,
  launchApp,
  listIosPhysicalDevices,
} from "../../src/utils/ios-device/devicectl";
import { listIosSimulators } from "../../src/utils/ios-devices";

// Pins the failure signal of each prepareLaunch step. xcrun is a shell script
// on PATH, steered by FAKE_* variables; devicectl discovery, the
// app lookup and the launch on an iPhone are stubbed.

vi.mock("../../src/utils/ios-device/devicectl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/ios-device/devicectl")>()),
  listIosPhysicalDevices: vi.fn(async () => []),
  ensureDeviceReady: vi.fn(async () => undefined),
  installedAppUrl: vi.fn(async () => null),
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
vi.mock("../../src/utils/react-profiler/debug/dump", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/react-profiler/debug/dump")>()),
  getDebugDir: async () => debugDir,
}));

const XCRUN = `#!/bin/sh
case "$1 $2" in
  "simctl bootstatus")
    if [ -n "$FAKE_BOOT_SLEEP" ]; then sleep "$FAKE_BOOT_SLEEP"; fi ;;
  "simctl get_app_container")
    if [ -n "$FAKE_APP_MISSING" ]; then
      echo "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):" >&2
      echo "No such file or directory" >&2
      exit 2
    fi
    echo "$FAKE_DIR/My App.app" ;;
  "simctl launch")
    if [ -n "$FAKE_SIMCTL_LAUNCH_EXIT" ]; then echo "An error was encountered processing the command" >&2; exit "$FAKE_SIMCTL_LAUNCH_EXIT"; fi ;;
  "devicectl device")
    if [ -n "$FAKE_DEVICECTL_EXIT" ]; then echo "ERROR: The device is not connected." >&2; exit "$FAKE_DEVICECTL_EXIT"; fi
    echo '{"result":{"runningProcesses":[]}}' ;;
esac
exit 0
`;

const FAKE_VARS = [
  "FAKE_DIR",
  "FAKE_BOOT_SLEEP",
  "FAKE_APP_MISSING",
  "FAKE_SIMCTL_LAUNCH_EXIT",
  "FAKE_DEVICECTL_EXIT",
];

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalPath = process.env.PATH;
let fake = "";
let debugDir = "";

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { ...platform, value });
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

const BUNDLE_ID = "com.example.app";
const simulatorRequest = () => ({ bundleId: BUNDLE_ID, allowSimulator: true });
const iphoneRequest = () => ({ bundleId: BUNDLE_ID, deviceId: "PHONE-1" });

beforeEach(async () => {
  fake = await mkdtemp(join(tmpdir(), "argent-launch-fake-"));
  debugDir = await mkdtemp(join(tmpdir(), "argent-launch-debug-"));
  await mkdir(join(fake, "bin"));
  await writeFile(join(fake, "bin", "xcrun"), XCRUN);
  await chmod(join(fake, "bin", "xcrun"), 0o755);
  process.env.PATH = `${join(fake, "bin")}:${originalPath}`;
  process.env.FAKE_DIR = fake;
  setPlatform("darwin");
  vi.mocked(listIosPhysicalDevices).mockResolvedValue([]);
  vi.mocked(listIosSimulators).mockResolvedValue([]);
  vi.mocked(installedAppUrl).mockResolvedValue(null);
  vi.mocked(launchApp).mockClear();
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  process.env.PATH = originalPath;
  for (const name of FAKE_VARS) delete process.env[name];
  await rm(fake, { recursive: true, force: true });
  await rm(debugDir, { recursive: true, force: true });
});

describe("prepareLaunch", () => {
  it("finds the installed app on a simulator and saves the run beside the other traces", async () => {
    useSimulator();
    const context = await prepareLaunch(simulatorRequest());
    expect(context).toMatchObject({
      deviceId: "SIM-1",
      simulator: true,
      bundleId: BUNDLE_ID,
      appPath: join(fake, "My App.app"),
    });
    expect(context.runDir.startsWith(join(debugDir, "launch-analysis-"))).toBe(true);
    const manifest = JSON.parse(await readFile(join(context.runDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ bundleId: BUNDLE_ID, appPath: join(fake, "My App.app") });
  });

  it("reads the installed app's URL on an iPhone and launches it once", async () => {
    useIphone();
    const url = "file:///private/var/containers/Bundle/Application/X/App.app/";
    vi.mocked(installedAppUrl).mockResolvedValue(url);
    const context = await prepareLaunch(iphoneRequest());
    expect(installedAppUrl).toHaveBeenCalledWith("PHONE-1", BUNDLE_ID);
    expect(context).toMatchObject({ simulator: false, appPath: url });
    expect(launchApp).toHaveBeenCalledWith("PHONE-1", BUNDLE_ID, { terminateExisting: true });
  });
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

  it("reports a missing iPhone as an unavailable device", async () => {
    const { error, signal } = await failure(prepareLaunch({ bundleId: BUNDLE_ID }));
    expect(error.message).toContain("No selected connected iPhone is available");
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_DEVICE_UNAVAILABLE,
      failure_stage: "launch_analysis_select_device",
      error_kind: "not_found",
    });
  });

  it("reports an iPhone off the cable as an unavailable device", async () => {
    useIphone("localNetwork");
    const { signal } = await failure(prepareLaunch(iphoneRequest()));
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_DEVICE_UNAVAILABLE,
      error_kind: "unsupported",
    });
  });

  it("reports an app missing from the simulator, with the steps to install it", async () => {
    useSimulator();
    process.env.FAKE_APP_MISSING = "1";
    const { error, signal } = await failure(prepareLaunch(simulatorRequest()));
    expect(error.message).toBe(
      "com.example.app is not installed on the simulator SIM-1. This tool does not build or " +
        "install the app: build it in Release with the project's own build flow, install it on " +
        "this simulator, then retry."
    );
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_APP_NOT_INSTALLED,
      failure_stage: "launch_analysis_find_app",
      failure_area: "tool_server",
      error_kind: "not_found",
    });
    expect(await readdir(debugDir)).toEqual([]);
  });

  it("reports an app missing from the iPhone before it launches anything", async () => {
    useIphone();
    const { error, signal } = await failure(prepareLaunch(iphoneRequest()));
    expect(error.message).toContain("com.example.app is not installed on the iPhone PHONE-1.");
    expect(signal).toMatchObject({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_APP_NOT_INSTALLED,
      failure_stage: "launch_analysis_find_app",
    });
    expect(launchApp).not.toHaveBeenCalled();
  });

  it("reports a failed simctl launch with its exit code", async () => {
    useSimulator();
    process.env.FAKE_SIMCTL_LAUNCH_EXIT = "4";
    const { error, signal } = await failure(prepareLaunch(simulatorRequest()));
    expect(error.message).toContain("xcrun simctl launch SIM-1 com.example.app");
    expect(signal).toEqual({
      error_code: FAILURE_CODES.LAUNCH_ANALYSIS_SIMCTL_FAILED,
      failure_stage: "launch_analysis_simulator_prelaunch",
      failure_area: "tool_server",
      error_kind: "subprocess",
      failure_command: "xcrun_simctl",
      failure_exit_code: 4,
    });
  });

  it("leaves a cancelled boot wait unclassified", async () => {
    useSimulator();
    process.env.FAKE_BOOT_SLEEP = "30";
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
    runDir: join(debugDir, "run"),
    deviceId: "PHONE-1",
    deviceName: "iPhone",
    simulator: false,
    simulatorDeviceSet: null,
    destination: "platform=iOS,id=PHONE-1",
    bundleId: "com.example.app",
    appPath: "file:///private/var/containers/Bundle/Application/X/App.app/",
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
