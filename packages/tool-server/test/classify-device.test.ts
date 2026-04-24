import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock execFile so we can pretend xcrun / adb are present or absent per test.
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

import {
  classifyDevice,
  warmDeviceCache,
  __resetClassifyCacheForTests,
} from "../src/utils/platform-detect";

const iosUuid = "11111111-2222-3333-4444-555555555555";
const androidSerial = "emulator-5554";

function simctlJsonWith(udids: string[]): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": udids.map((udid, i) => ({
        udid,
        name: `Sim ${i}`,
        state: "Shutdown",
        deviceTypeIdentifier: "...",
        isAvailable: true,
      })),
    },
  });
}

function adbDevicesWith(serials: string[]): string {
  return ["List of devices attached", ...serials.map((s) => `${s}\tdevice`), ""].join("\n");
}

beforeEach(() => {
  execFileMock.mockReset();
  __resetClassifyCacheForTests();
});

afterEach(() => {
  __resetClassifyCacheForTests();
});

describe("classifyDevice — list-based truth", () => {
  it("returns `ios` when simctl lists the udid (authoritative, not shape-based)", async () => {
    // The id has Android-serial shape (`emulator-XXXX`) but simctl claims it.
    // Authoritative source wins over shape so the dispatch is right even for
    // Apple's future id formats we don't know about.
    const surprising = "emulator-9999";
    execFileMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "xcrun" && args[0] === "simctl") {
        return { stdout: simctlJsonWith([surprising]), stderr: "" };
      }
      if (cmd === "adb") {
        return { stdout: adbDevicesWith([]), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    expect(await classifyDevice(surprising)).toBe("ios");
  });

  it("returns `android` when adb lists the udid", async () => {
    execFileMock.mockImplementation((cmd: string) => {
      if (cmd === "xcrun") return { stdout: simctlJsonWith([]), stderr: "" };
      if (cmd === "adb") return { stdout: adbDevicesWith([androidSerial]), stderr: "" };
      return { stdout: "", stderr: "" };
    });

    expect(await classifyDevice(androidSerial)).toBe("android");
  });

  it("falls back to shape when neither tool is installed — UUID → iOS", async () => {
    // No xcrun, no adb. The device isn't booted either way, but we still want
    // a reasonable guess so the caller's subsequent launch attempt can fail
    // with its own message instead of ours.
    execFileMock.mockImplementation(() => new Error("command not found"));
    expect(await classifyDevice(iosUuid)).toBe("ios");
  });

  it("falls back to shape when neither tool is installed — non-UUID → android", async () => {
    execFileMock.mockImplementation(() => new Error("command not found"));
    expect(await classifyDevice("emulator-5554")).toBe("android");
  });

  it("drops the iOS-17 short form from the shape fallback — it is physical-device-only", async () => {
    // Physical iOS devices can't be driven by simctl, so classifying an
    // 8-16 form as iOS would just route the caller into an opaque simctl
    // "Invalid device" error. Treating it as android-unknown lets the
    // Android code path surface its own "device not found" error instead.
    execFileMock.mockImplementation(() => new Error("command not found"));
    const shortForm = "00008030-001C25120C22802E";
    expect(await classifyDevice(shortForm)).toBe("android");
  });
});

describe("classifyDevice — caching", () => {
  it("hits the cache on the second call; does not re-shell", async () => {
    let calls = 0;
    execFileMock.mockImplementation((cmd: string) => {
      calls += 1;
      if (cmd === "xcrun") return { stdout: simctlJsonWith([iosUuid]), stderr: "" };
      if (cmd === "adb") return { stdout: adbDevicesWith([]), stderr: "" };
      return { stdout: "", stderr: "" };
    });

    expect(await classifyDevice(iosUuid)).toBe("ios");
    const callsAfterFirst = calls;
    expect(await classifyDevice(iosUuid)).toBe("ios");
    expect(calls).toBe(callsAfterFirst); // cache hit — no new shell-outs
  });

  it("warmDeviceCache populates the cache so the first tool call is O(1)", async () => {
    // This is the contract list-devices relies on: after it runs, every
    // interaction tool for a listed udid should classify instantly.
    warmDeviceCache([
      { udid: iosUuid, platform: "ios" },
      { udid: androidSerial, platform: "android" },
    ]);
    expect(await classifyDevice(iosUuid)).toBe("ios");
    expect(await classifyDevice(androidSerial)).toBe("android");
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
