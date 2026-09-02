import { describe, it, expect, vi, beforeEach } from "vitest";
import { FAILURE_CODES, getFailureSignal } from "@argent/registry";
import type { DeviceInfo, Registry } from "@argent/registry";

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
  cacheSimulatorRuntimeKind,
  __resetSimulatorRuntimeKindCacheForTesting,
} from "../src/utils/ios-devices";
import { makeIosImpl } from "../src/tools/keyboard/platforms/ios";

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

describe("cacheSimulatorRuntimeKind — warm from an out-of-band verdict", () => {
  it("seeds the cache so the synchronous reader refines without any simctl call", () => {
    // The tv-control factory already holds the runtime kind from its own
    // listIosSimulators() call; warming here lets the telemetry reader see `tv`
    // with no further probe (the whole point of the synchronous hot path).
    cacheSimulatorRuntimeKind(TV_UDID, "tv");
    expect(getCachedSimulatorRuntimeKind(TV_UDID)).toBe("tv");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("caches a mobile verdict too (an iPhone that reached a tv path)", () => {
    cacheSimulatorRuntimeKind(PHONE_UDID, "mobile");
    expect(getCachedSimulatorRuntimeKind(PHONE_UDID)).toBe("mobile");
  });

  it("is a no-op for an undefined kind, leaving the entry unwarmed", () => {
    cacheSimulatorRuntimeKind(TV_UDID, undefined);
    expect(getCachedSimulatorRuntimeKind(TV_UDID)).toBeUndefined();
  });
});

describe("getSimulatorRuntimeKind — the third verdict, and what rests on it", () => {
  // `undefined` means "the listing did not say", which is NOT "mobile": the iOS
  // `clear` refuses on it rather than aiming 200 delete keys at a device it
  // could not identify. Every keyboard test mocks this module, and the cases
  // above only ever ask about a KNOWN udid — so a probe that fell back to
  // "mobile" kept the whole suite green, and both new refusals rest on it.
  const UNLISTED_UDID = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC";

  it("answers undefined for a UDID the listing does not carry", async () => {
    mockSimctl();
    expect(await getSimulatorRuntimeKind(UNLISTED_UDID)).toBeUndefined();
  });

  it("answers undefined when xcrun itself fails", async () => {
    // A missing xcrun, or a listing that misses its 10s budget under host load.
    execFileMock.mockImplementation(() => new Error("xcrun: command not found"));
    expect(await getSimulatorRuntimeKind(TV_UDID)).toBeUndefined();
  });

  it("refuses a clear on a UDID the REAL probe cannot name, and resolves no service", async () => {
    // The refusal composed with the probe that feeds it. Held apart, both halves
    // pass a mutant that answers "mobile": the refusal's own tests hand it
    // `undefined` from a `vi.fn`, and the probe's tests only ask about
    // simulators the listing carries.
    mockSimctl();
    const device: DeviceInfo = { id: UNLISTED_UDID, platform: "ios", kind: "simulator" };
    const resolveService = vi.fn(async () => {
      throw new Error("no service may be resolved for a refused clear");
    });
    const err = await makeIosImpl({ resolveService } as unknown as Registry)
      .handler({}, { udid: device.id, clear: true }, device)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    const signal = getFailureSignal(err);
    expect(signal?.error_code).toBe(FAILURE_CODES.KEYBOARD_TARGET_KIND_UNKNOWN);
    expect(signal?.failure_stage).toBe("keyboard_ios_runtime_kind");
    // Nothing was sent: the burst never got as far as a transport.
    expect(resolveService).not.toHaveBeenCalled();
  });
});
