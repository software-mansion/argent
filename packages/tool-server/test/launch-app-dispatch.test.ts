import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the child_process boundary so we don't actually shell out to xcrun / adb.
const execFileMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: (
      cmd: string,
      args: readonly string[],
      opts: unknown,
      cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ) => {
      // promisify(execFile) calls it as `execFile(cmd, args, opts, cb)` — cb is the last arg.
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { launchAppTool } from "../src/tools/simulator/launch-app";

const iosUdid = "11111111-2222-3333-4444-555555555555";
const androidSerial = "emulator-5554";
const iosNativeApi = { ensureEnvReady: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  execFileMock.mockReset().mockReturnValue({ stdout: "", stderr: "" });
  iosNativeApi.ensureEnvReady.mockClear().mockResolvedValue(undefined);
});

describe("launch-app.services — platform-dependent ServiceRef", () => {
  it("requests the nativeDevtools service for iOS udids", () => {
    expect(launchAppTool.services({ udid: iosUdid, bundleId: "com.example" })).toEqual({
      nativeDevtools: `NativeDevtools:${iosUdid}`,
    });
  });

  it("requests no services for Android serials — avoids spawning the iOS-only NativeDevtools service", () => {
    // This is critical: NativeDevtools depends on xcrun simctl APIs and will
    // blow up on non-UUID udids. A stray nativeDevtools request for an
    // Android serial would break every Android launch.
    expect(launchAppTool.services({ udid: androidSerial, bundleId: "com.example" })).toEqual({});
  });
});

describe("launch-app.execute — iOS path (unchanged behavior)", () => {
  it("prepares native devtools then calls `xcrun simctl launch`", async () => {
    await launchAppTool.execute!(
      { nativeDevtools: iosNativeApi },
      { udid: iosUdid, bundleId: "com.apple.Preferences" }
    );

    expect(iosNativeApi.ensureEnvReady).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", iosUdid, "com.apple.Preferences"],
      undefined
    );
  });

  it("ensureEnvReady is awaited *before* launch (injection must be in place pre-spawn)", async () => {
    const order: string[] = [];
    iosNativeApi.ensureEnvReady.mockImplementation(async () => {
      order.push("ensureEnvReady");
    });
    execFileMock.mockImplementation(() => {
      order.push("xcrun");
      return { stdout: "", stderr: "" };
    });

    await launchAppTool.execute!(
      { nativeDevtools: iosNativeApi },
      { udid: iosUdid, bundleId: "com.apple.Preferences" }
    );

    expect(order).toEqual(["ensureEnvReady", "xcrun"]);
  });

  it("ignores an `activity` arg on iOS (Android-only parameter)", async () => {
    await launchAppTool.execute!(
      { nativeDevtools: iosNativeApi },
      { udid: iosUdid, bundleId: "com.apple.Preferences", activity: ".Root" }
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", iosUdid, "com.apple.Preferences"],
      undefined
    );
  });
});

describe("launch-app.execute — Android path", () => {
  it("defaults to `monkey` LAUNCHER intent when no activity is provided", async () => {
    await launchAppTool.execute!({}, { udid: androidSerial, bundleId: "com.android.settings" });
    expect(execFileMock).toHaveBeenCalledWith(
      "adb",
      [
        "-s",
        androidSerial,
        "shell",
        "monkey -p com.android.settings -c android.intent.category.LAUNCHER 1",
      ],
      expect.any(Object)
    );
    // Critically, NO xcrun call — running iOS tooling for an Android device is
    // the exact class of regression this test guards against.
    expect(execFileMock).not.toHaveBeenCalledWith("xcrun", expect.anything(), expect.anything());
  });

  it("uses `am start -W -n pkg/.Activity` when activity starts with a dot", async () => {
    await launchAppTool.execute!(
      {},
      { udid: androidSerial, bundleId: "com.example.app", activity: ".MainActivity" }
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "adb",
      ["-s", androidSerial, "shell", "am start -W -n com.example.app/.MainActivity"],
      expect.any(Object)
    );
  });

  it("passes pre-qualified `pkg/.Activity` strings through unchanged", async () => {
    await launchAppTool.execute!(
      {},
      {
        udid: androidSerial,
        bundleId: "com.example.app",
        activity: "com.example.app/com.example.app.MainActivity",
      }
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "adb",
      ["-s", androidSerial, "shell", "am start -W -n com.example.app/com.example.app.MainActivity"],
      expect.any(Object)
    );
  });

  it("throws when am start reports an error (no Activity found)", async () => {
    execFileMock.mockReturnValue({
      stdout: "Error: Activity class {com.foo/.Bar} does not exist.",
      stderr: "",
    });
    await expect(
      launchAppTool.execute!({}, { udid: androidSerial, bundleId: "com.foo", activity: ".Bar" })
    ).rejects.toThrow(/am start failed/);
  });

  it("throws when monkey can't find a launcher activity", async () => {
    execFileMock.mockReturnValue({
      stdout: "** No activities found to run, monkey aborted.",
      stderr: "",
    });
    await expect(
      launchAppTool.execute!({}, { udid: androidSerial, bundleId: "com.not.installed" })
    ).rejects.toThrow(/monkey launch failed/);
  });
});
