import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { access, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIMCTL_LIST_DEVICES_LOCK_STALE_MS } from "../src/utils/simctl-config";

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
      const result = execFileMock(cmd, args, options, callback);
      if (
        result &&
        typeof result === "object" &&
        "__asyncHandled" in result &&
        result.__asyncHandled === true
      ) {
        return;
      }
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
  __setSimctlListDevicesLockPathForTesting,
  __resetSimctlListDevicesLockPathForTesting,
  __removeStaleSimctlListDevicesLockForTesting,
  listIosSimulators,
} from "../src/utils/ios-devices";

const TV_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const PHONE_UDID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
let testLockPath: string;

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
  testLockPath = join(
    tmpdir(),
    `argent-test-simctl-list-devices-${process.pid}-${randomUUID()}.lock`
  );
  __setSimctlListDevicesLockPathForTesting(testLockPath);
});

afterEach(async () => {
  __resetSimctlListDevicesLockPathForTesting();
  await unlink(testLockPath).catch(() => {});
  await unlink(`${testLockPath}.cleanup`).catch(() => {});
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

describe("listIosSimulators — simctl discovery fan-out cap", () => {
  it("serializes concurrent simctl list probes through the host lock", async () => {
    let activeSimctl = 0;
    let maxActiveSimctl = 0;
    execFileMock.mockImplementation(
      (
        cmd: string,
        args: string[],
        _opts: unknown,
        cb?: (err: Error | null, out: { stdout: string; stderr: string }) => void
      ) => {
        if (cmd !== "xcrun" || args[0] !== "simctl" || args[1] !== "list") {
          cb?.(null, { stdout: "", stderr: "" });
          return { __asyncHandled: true };
        }
        activeSimctl += 1;
        maxActiveSimctl = Math.max(maxActiveSimctl, activeSimctl);
        setTimeout(() => {
          activeSimctl -= 1;
          cb?.(null, {
            stdout: JSON.stringify({
              devices: {
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
          });
        }, 20);
        return { __asyncHandled: true };
      }
    );

    const results = await Promise.all([
      listIosSimulators(),
      listIosSimulators(),
      listIosSimulators(),
    ]);
    expect(results.map((devices) => devices[0]?.udid)).toEqual([
      PHONE_UDID,
      PHONE_UDID,
      PHONE_UDID,
    ]);
    expect(maxActiveSimctl).toBe(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("keeps a fresh malformed lock file instead of treating it as stale", async () => {
    await writeFile(testLockPath, "");
    const freshMtimeMs = (await stat(testLockPath)).mtimeMs;

    await __removeStaleSimctlListDevicesLockForTesting(testLockPath, freshMtimeMs + 1);

    await expect(access(testLockPath)).resolves.toBeUndefined();
  });

  it("removes malformed lock files once they are old enough to be stale", async () => {
    await writeFile(testLockPath, "");
    const staleMtimeMs = Date.now() - SIMCTL_LIST_DEVICES_LOCK_STALE_MS - 1_000;
    await utimes(testLockPath, staleMtimeMs / 1_000, staleMtimeMs / 1_000);

    await __removeStaleSimctlListDevicesLockForTesting(testLockPath, Date.now());

    await expect(access(testLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves stale lock cleanup to one contender at a time", async () => {
    await writeFile(testLockPath, "");
    const staleMtimeMs = Date.now() - SIMCTL_LIST_DEVICES_LOCK_STALE_MS - 1_000;
    await utimes(testLockPath, staleMtimeMs / 1_000, staleMtimeMs / 1_000);
    await writeFile(`${testLockPath}.cleanup`, JSON.stringify({ createdAt: Date.now() }));

    await __removeStaleSimctlListDevicesLockForTesting(testLockPath, Date.now());

    await expect(access(testLockPath)).resolves.toBeUndefined();
  });
});
