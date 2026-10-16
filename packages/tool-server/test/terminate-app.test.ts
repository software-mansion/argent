import { beforeEach, describe, expect, it, vi } from "vitest";

type Cb = (err: Error | null, out: { stdout: string; stderr: string }) => void;
let execFailure: { message: string; stderr: string } | null = null;
const execFileMock = vi.fn((_cmd: string, _args: readonly string[], opts: unknown, cb?: Cb) => {
  const callback = (typeof opts === "function" ? opts : cb!) as Cb;
  if (!execFailure) return callback(null, { stdout: "", stderr: "" });
  const err = Object.assign(new Error(execFailure.message), { stderr: execFailure.stderr });
  callback(err, { stdout: "", stderr: execFailure.stderr });
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => (execFileMock as any)(...args) };
});

const shellCalls: string[] = [];
vi.mock("../src/utils/adb", async (importActual) => ({
  ...(await importActual<typeof import("../src/utils/adb")>()),
  adbShell: vi.fn(async (_serial: string, cmd: string) => {
    shellCalls.push(cmd);
    return "";
  }),
}));

const vegaCalls: string[][] = [];
let vegaStderr: string | null = null;
vi.mock("../src/utils/vega-cli", async (importActual) => ({
  ...(await importActual<typeof import("../src/utils/vega-cli")>()),
  vegaDevice: vi.fn(async (_serial: string, args: string[]) => {
    vegaCalls.push(args);
    if (vegaStderr) {
      // Shaped like runVega's rejection.
      const argv = ["device", ...args, "-d", "emulator-5554"];
      throw new Error(formatSubprocessFailure("vega", argv, { stderr: vegaStderr }));
    }
    return { stdout: "", stderr: "" };
  }),
}));

import { terminateAppTool } from "../src/tools/terminate-app";
import { formatSubprocessFailure } from "../src/utils/subprocess-error";
import { UnsupportedOperationError } from "../src/utils/capability";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const BUNDLE_ID = "com.example.app";
// Real `xcrun simctl terminate` stderr for an app that is not running or not installed.
const NOTHING_TO_TERMINATE =
  "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):\n" +
  "Simulator device failed to terminate com.example.app.\n" +
  "found nothing to terminate\nUnderlying error (domain=NSPOSIXErrorDomain, code=3):\n" +
  '\tThe request to terminate "com.example.app" failed. found nothing to terminate';

// Real vega CLI stderr for an app that is not installed.
const VEGA_NOT_INSTALLED =
  "Vega operation FAILED due to an irrecoverable error: Failed: App could not be determined\n" +
  "Additional logs can be found at /home/user/vega/sdk/vega-sdk/main/0.23.8358/logs";
// Real stderr when the device is not reachable.
const VEGA_DEVICE_NOT_FOUND =
  "Vega operation FAILED due to an irrecoverable error: Device not found: Cannot find an " +
  "instance of Vega Virtual Device, launch the virtual device and try again.\n" +
  "Additional logs can be found at /home/user/vega/sdk/vega-sdk/main/0.23.8358/logs";
const VEGA_SERIAL = "amazon-4a27df03c9777152";

const run = (udid: string) => terminateAppTool.execute!({}, { udid, bundleId: BUNDLE_ID });

beforeEach(() => {
  execFailure = null;
  vegaStderr = null;
  execFileMock.mockClear();
  shellCalls.length = 0;
  vegaCalls.length = 0;
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun", "sim-remote", "adb", "vega"]);
});

describe("terminate-app", () => {
  it("is hidden from MCP", () => {
    expect(terminateAppTool.hideFromMcp).toBe(true);
  });

  it("force-stops an Android app without relaunching it", async () => {
    await expect(run("emulator-5554")).resolves.toEqual({ terminated: true, bundleId: BUNDLE_ID });
    expect(shellCalls).toEqual([`am force-stop '${BUNDLE_ID}'`]);
  });

  it("runs simctl terminate on an iOS simulator without relaunching it", async () => {
    await expect(run(IOS_UDID)).resolves.toEqual({ terminated: true, bundleId: BUNDLE_ID });
    expect(execFileMock.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
      ["xcrun", ["simctl", "terminate", IOS_UDID, BUNDLE_ID]],
    ]);
  });

  it("runs simctl terminate over sim-remote with the remote: prefix stripped", async () => {
    await expect(run(`remote:${IOS_UDID}`)).resolves.toEqual({
      terminated: true,
      bundleId: BUNDLE_ID,
    });
    expect(execFileMock.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
      ["sim-remote", ["simctl", "terminate", IOS_UDID, BUNDLE_ID]],
    ]);
  });

  it.each([
    ["iOS", IOS_UDID],
    ["ios-remote", `remote:${IOS_UDID}`],
  ])("reports terminated: false on %s when there is nothing to terminate", async (_name, udid) => {
    execFailure = {
      message: "Command failed: xcrun simctl terminate",
      stderr: NOTHING_TO_TERMINATE,
    };
    await expect(run(udid)).resolves.toEqual({ terminated: false, bundleId: BUNDLE_ID });
  });

  it("runs vega terminate-app on a Vega Virtual Device", async () => {
    await expect(run(VEGA_SERIAL)).resolves.toEqual({
      terminated: true,
      bundleId: BUNDLE_ID,
    });
    expect(vegaCalls).toEqual([["terminate-app", "-a", BUNDLE_ID]]);
  });

  it("reports terminated: true on Vega when the app is not installed", async () => {
    vegaStderr = VEGA_NOT_INSTALLED;
    await expect(run(VEGA_SERIAL)).resolves.toEqual({ terminated: true, bundleId: BUNDLE_ID });
    expect(vegaCalls).toEqual([["terminate-app", "-a", BUNDLE_ID]]);
  });

  it("propagates other vega CLI failures", async () => {
    vegaStderr = VEGA_DEVICE_NOT_FOUND;
    await expect(run(VEGA_SERIAL)).rejects.toThrow(/Device not found/);
  });

  it.each([
    ["a physical iPhone", "00008110-000000000000001E"],
    ["a Chromium app", "chromium-cdp-9222"],
  ])("rejects %s as unsupported", async (_name, udid) => {
    await expect(run(udid)).rejects.toBeInstanceOf(UnsupportedOperationError);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("propagates other simctl failures", async () => {
    execFailure = {
      message: "Command failed: xcrun simctl terminate",
      stderr:
        "An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=405):\n" +
        "Unable to lookup in current state: Shutdown",
    };
    await expect(run(IOS_UDID)).rejects.toThrow(/Command failed/);
  });
});
