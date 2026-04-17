import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Registry } from "@argent/registry";

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
      const callback = typeof opts === "function" ? opts : cb!;
      const options = typeof opts === "function" ? undefined : opts;
      const result = execFileMock(cmd, args, options);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

import { createLaunchAppTool } from "../src/tools/simulator/launch-app";
import { __resetClassifyCacheForTests, warmDeviceCache } from "../src/utils/platform-detect";

const iosUdid = "11111111-2222-3333-4444-555555555555";
const androidSerial = "emulator-5554";

const iosNativeApi = { ensureEnvReady: vi.fn().mockResolvedValue(undefined) };
const resolveService = vi.fn(async () => iosNativeApi);
const registry = { resolveService } as unknown as Registry;

beforeEach(() => {
  execFileMock.mockReset().mockReturnValue({ stdout: "", stderr: "" });
  iosNativeApi.ensureEnvReady.mockClear().mockResolvedValue(undefined);
  resolveService.mockClear().mockResolvedValue(iosNativeApi);
  __resetClassifyCacheForTests();
  // Pre-populate the classify cache so tests don't shell out for xcrun / adb
  // list lookups (those paths are covered separately in classify-device.test.ts).
  warmDeviceCache([
    { udid: iosUdid, platform: "ios" },
    { udid: androidSerial, platform: "android" },
  ]);
});

describe("launch-app.services — no pre-declared services (factory form)", () => {
  it("declares no services; platform-specific service resolution is deferred to execute", () => {
    // We moved NativeDevtools resolution into execute so the platform check
    // can be async (list-based classifyDevice). If a future change re-adds a
    // service request here, the udid-shape it would use is an iOS-only URN
    // that would fail for Android devices.
    const tool = createLaunchAppTool(registry);
    expect(tool.services({ udid: iosUdid, bundleId: "com.example" })).toEqual({});
    expect(tool.services({ udid: androidSerial, bundleId: "com.example" })).toEqual({});
  });
});

describe("launch-app.execute — iOS path (behavior preserved through factory refactor)", () => {
  it("prepares native devtools then calls `xcrun simctl launch`", async () => {
    const tool = createLaunchAppTool(registry);
    await tool.execute!({}, { udid: iosUdid, bundleId: "com.apple.Preferences" });

    expect(resolveService).toHaveBeenCalledWith(`NativeDevtools:${iosUdid}`);
    expect(iosNativeApi.ensureEnvReady).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "launch", iosUdid, "com.apple.Preferences"],
      undefined
    );
  });

  it("ensureEnvReady awaits *before* launch (injection must be in place pre-spawn)", async () => {
    const order: string[] = [];
    iosNativeApi.ensureEnvReady.mockImplementation(async () => {
      order.push("ensureEnvReady");
    });
    execFileMock.mockImplementation(() => {
      order.push("xcrun");
      return { stdout: "", stderr: "" };
    });

    const tool = createLaunchAppTool(registry);
    await tool.execute!({}, { udid: iosUdid, bundleId: "com.apple.Preferences" });
    expect(order).toEqual(["ensureEnvReady", "xcrun"]);
  });

  it("ignores an `activity` arg on iOS (Android-only parameter)", async () => {
    const tool = createLaunchAppTool(registry);
    await tool.execute!(
      {},
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
    const tool = createLaunchAppTool(registry);
    await tool.execute!({}, { udid: androidSerial, bundleId: "com.android.settings" });
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
    // NativeDevtools (iOS-only) must NOT be resolved on the Android path —
    // its factory would blow up trying to launchctl into a non-existent sim.
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("uses `am start -W -n pkg/.Activity` when activity starts with a dot", async () => {
    const tool = createLaunchAppTool(registry);
    await tool.execute!(
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
    const tool = createLaunchAppTool(registry);
    await tool.execute!(
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
    const tool = createLaunchAppTool(registry);
    await expect(
      tool.execute!({}, { udid: androidSerial, bundleId: "com.foo", activity: ".Bar" })
    ).rejects.toThrow(/am start failed/);
  });

  it("throws when monkey can't find a launcher activity", async () => {
    execFileMock.mockReturnValue({
      stdout: "** No activities found to run, monkey aborted.",
      stderr: "",
    });
    const tool = createLaunchAppTool(registry);
    await expect(
      tool.execute!({}, { udid: androidSerial, bundleId: "com.not.installed" })
    ).rejects.toThrow(/monkey launch failed/);
  });
});
