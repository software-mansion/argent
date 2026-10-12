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

import { terminateAppTool } from "../src/tools/terminate-app";
import { __primeDepCacheForTests, __resetDepCacheForTests } from "../src/utils/check-deps";

const IOS_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const BUNDLE_ID = "com.example.app";
// Real `xcrun simctl terminate` stderr for an app that is not running or not installed.
const NOTHING_TO_TERMINATE =
  "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):\n" +
  "Simulator device failed to terminate com.example.app.\n" +
  "found nothing to terminate\nUnderlying error (domain=NSPOSIXErrorDomain, code=3):\n" +
  '\tThe request to terminate "com.example.app" failed. found nothing to terminate';

const run = (udid: string) => terminateAppTool.execute!({}, { udid, bundleId: BUNDLE_ID });

beforeEach(() => {
  execFailure = null;
  execFileMock.mockClear();
  shellCalls.length = 0;
  __resetDepCacheForTests();
  __primeDepCacheForTests(["xcrun", "sim-remote", "adb"]);
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

  it.each([
    ["iOS", IOS_UDID],
    ["ios-remote", `remote:${IOS_UDID}`],
  ])("succeeds on %s when there is nothing to terminate", async (_name, udid) => {
    execFailure = {
      message: "Command failed: xcrun simctl terminate",
      stderr: NOTHING_TO_TERMINATE,
    };
    await expect(run(udid)).resolves.toEqual({ terminated: true, bundleId: BUNDLE_ID });
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
