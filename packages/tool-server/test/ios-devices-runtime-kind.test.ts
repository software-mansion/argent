import { describe, it, expect, vi, beforeEach } from "vitest";

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
  getSimulatorRuntimeKind,
  getCachedSimulatorRuntimeKind,
  __resetSimulatorRuntimeKindCacheForTesting,
} from "../src/utils/ios-devices";

const TV_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const PHONE_UDID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

// Shape a `simctl list devices --json` payload: one tvOS device and one iOS
// device, so both a "tv" and a "mobile" verdict can be resolved from one probe.
function mockSimctl(): void {
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "xcrun" && args[0] === "simctl" && args[1] === "list") {
      return {
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.tvOS-18-0": [
              {
                udid: TV_UDID,
                name: "Apple TV",
                state: "Booted",
                deviceTypeIdentifier:
                  "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation",
                isAvailable: true,
              },
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
              {
                udid: PHONE_UDID,
                name: "iPhone 16",
                state: "Booted",
                deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
                isAvailable: true,
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  __resetSimulatorRuntimeKindCacheForTesting();
});

describe("getCachedSimulatorRuntimeKind — synchronous cache-only read", () => {
  it("returns undefined for a UDID that has never been probed", () => {
    // No async resolution has warmed the cache → the hot-path reader stays coarse
    // and never triggers a simctl call.
    mockSimctl();
    expect(getCachedSimulatorRuntimeKind(TV_UDID)).toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns 'tv' after an async probe warms the cache, without any simctl call", async () => {
    mockSimctl();
    expect(await getSimulatorRuntimeKind(TV_UDID)).toBe("tv");
    const callsBefore = execFileMock.mock.calls.length;
    expect(getCachedSimulatorRuntimeKind(TV_UDID)).toBe("tv");
    // The synchronous read must not shell out.
    expect(execFileMock.mock.calls.length).toBe(callsBefore);
  });

  it("returns 'mobile' for a warmed iPhone simulator UDID", async () => {
    mockSimctl();
    expect(await getSimulatorRuntimeKind(PHONE_UDID)).toBe("mobile");
    expect(getCachedSimulatorRuntimeKind(PHONE_UDID)).toBe("mobile");
  });

  it("stays undefined for an unknown UDID even after another device warms the cache", async () => {
    mockSimctl();
    await getSimulatorRuntimeKind(TV_UDID);
    expect(getCachedSimulatorRuntimeKind("CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC")).toBeUndefined();
  });
});
