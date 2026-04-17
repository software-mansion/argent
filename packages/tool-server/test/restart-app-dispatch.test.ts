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

import { createRestartAppTool } from "../src/tools/simulator/restart-app";
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
  warmDeviceCache([
    { udid: iosUdid, platform: "ios" },
    { udid: androidSerial, platform: "android" },
  ]);
});

describe("restart-app.services — no pre-declared services (factory form)", () => {
  it("declares no services; platform-specific service resolution is deferred to execute", () => {
    const tool = createRestartAppTool(registry);
    expect(tool.services({ udid: iosUdid, bundleId: "com.foo" })).toEqual({});
    expect(tool.services({ udid: androidSerial, bundleId: "com.foo" })).toEqual({});
  });
});

describe("restart-app.execute — iOS (behaviour preserved)", () => {
  it("terminates then launches via simctl, refreshing native-devtools between", async () => {
    const tool = createRestartAppTool(registry);
    await tool.execute!({}, { udid: iosUdid, bundleId: "com.apple.Preferences" });

    expect(resolveService).toHaveBeenCalledWith(`NativeDevtools:${iosUdid}`);
    expect(iosNativeApi.ensureEnvReady).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "simctl",
      "terminate",
      iosUdid,
      "com.apple.Preferences",
    ]);
    expect(execFileMock.mock.calls[1]![1]).toEqual([
      "simctl",
      "launch",
      iosUdid,
      "com.apple.Preferences",
    ]);
  });

  it("swallows a terminate failure — app may already be stopped, launch must still run", async () => {
    let n = 0;
    execFileMock.mockImplementation(() => {
      n += 1;
      if (n === 1) return new Error("App is not running");
      return { stdout: "", stderr: "" };
    });

    const tool = createRestartAppTool(registry);
    const result = await tool.execute!({}, { udid: iosUdid, bundleId: "com.apple.Preferences" });
    expect(result).toEqual({ restarted: true, bundleId: "com.apple.Preferences" });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});

describe("restart-app.execute — Android", () => {
  it("force-stops then monkey-launches — no xcrun, no NativeDevtools resolve", async () => {
    const tool = createRestartAppTool(registry);
    await tool.execute!({}, { udid: androidSerial, bundleId: "com.android.settings" });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]![1]).toEqual([
      "-s",
      androidSerial,
      "shell",
      "am force-stop com.android.settings",
    ]);
    expect(execFileMock.mock.calls[1]![1]).toEqual([
      "-s",
      androidSerial,
      "shell",
      "monkey -p com.android.settings -c android.intent.category.LAUNCHER 1",
    ]);
    expect(execFileMock).not.toHaveBeenCalledWith("xcrun", expect.anything(), expect.anything());
    expect(resolveService).not.toHaveBeenCalled();
  });

  it("throws when monkey cannot find an activity to relaunch", async () => {
    let n = 0;
    execFileMock.mockImplementation(() => {
      n += 1;
      if (n === 2) {
        return {
          stdout: "** No activities found to run, monkey aborted.",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    });

    const tool = createRestartAppTool(registry);
    await expect(
      tool.execute!({}, { udid: androidSerial, bundleId: "com.not.installed" })
    ).rejects.toThrow(/relaunch failed/);
  });
});
