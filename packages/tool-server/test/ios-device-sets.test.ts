import { describe, it, expect, vi, beforeEach } from "vitest";

const execFileMock = vi.fn();
const additionalSetsMock = vi.fn<() => string[]>(() => []);
const existsSyncMock = vi.fn<(p: string) => boolean>(() => true);

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
      const result = execFileMock(cmd, args);
      if (result instanceof Error) callback(result, { stdout: "", stderr: "" });
      else callback(null, result ?? { stdout: "", stderr: "" });
    },
  };
});

vi.mock("@argent/configuration-core", async () => {
  const actual = await vi.importActual<typeof import("@argent/configuration-core")>(
    "@argent/configuration-core"
  );
  return { ...actual, getAdditionalIosDeviceSets: () => additionalSetsMock() };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: (p: string) => existsSyncMock(p) };
});

import {
  deviceSetForUdid,
  cachedDeviceSetForUdid,
  rememberDeviceSet,
  simctlArgsForUdid,
  simctlArgsForUdidSync,
  simctlPrefix,
  __resetDeviceSetCacheForTesting,
} from "../src/utils/ios-device-sets";
import { listIosSimulators } from "../src/utils/ios-devices";

const DEFAULT_UDID = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const RADON_UDID = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const RADON_SET = "/Users/dev/Library/Caches/com.swmansion.radon-ide/Devices/iOS";

function listPayload(udid: string, name: string): { stdout: string; stderr: string } {
  return {
    stdout: JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
          { udid, name, state: "Shutdown", deviceTypeIdentifier: "x", isAvailable: true },
        ],
      },
    }),
    stderr: "",
  };
}

/** simctl list responses: default set has DEFAULT_UDID, RADON_SET has RADON_UDID. */
function mockTwoSets(): void {
  execFileMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd !== "xcrun" || args[0] !== "simctl") return { stdout: "", stderr: "" };
    if (args[1] === "--set") {
      expect(args[2]).toBe(RADON_SET);
      return listPayload(RADON_UDID, "iPhone Air");
    }
    return listPayload(DEFAULT_UDID, "iPhone 17");
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  additionalSetsMock.mockReset().mockReturnValue([]);
  existsSyncMock.mockReset().mockReturnValue(true);
  __resetDeviceSetCacheForTesting();
});

describe("simctlPrefix", () => {
  it("injects --set only for a non-default set", () => {
    expect(simctlPrefix(null)).toEqual(["simctl"]);
    expect(simctlPrefix(RADON_SET)).toEqual(["simctl", "--set", RADON_SET]);
  });
});

describe("deviceSetForUdid — no additional sets configured", () => {
  it("resolves to the default set without any simctl probe", async () => {
    expect(await deviceSetForUdid(DEFAULT_UDID)).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
    expect(await simctlArgsForUdid(DEFAULT_UDID, ["boot", DEFAULT_UDID])).toEqual([
      "simctl",
      "boot",
      DEFAULT_UDID,
    ]);
  });
});

describe("deviceSetForUdid — lazy probe with additional sets", () => {
  it("finds a device in an additional set and caches the verdict", async () => {
    additionalSetsMock.mockReturnValue([RADON_SET]);
    mockTwoSets();
    expect(await deviceSetForUdid(RADON_UDID)).toBe(RADON_SET);
    const probes = execFileMock.mock.calls.length;
    expect(probes).toBe(2); // default set (miss) + RADON_SET (hit)
    // Cached: no further probes, sync view agrees.
    expect(await simctlArgsForUdid(RADON_UDID, ["boot", RADON_UDID])).toEqual([
      "simctl",
      "--set",
      RADON_SET,
      "boot",
      RADON_UDID,
    ]);
    expect(execFileMock.mock.calls.length).toBe(probes);
    expect(cachedDeviceSetForUdid(RADON_UDID)).toBe(RADON_SET);
    expect(simctlArgsForUdidSync(RADON_UDID, ["shutdown", RADON_UDID])).toEqual([
      "simctl",
      "--set",
      RADON_SET,
      "shutdown",
      RADON_UDID,
    ]);
  });

  it("keeps default-set behavior for a default-set device (probe caches null)", async () => {
    additionalSetsMock.mockReturnValue([RADON_SET]);
    mockTwoSets();
    expect(await deviceSetForUdid(DEFAULT_UDID)).toBeNull();
    const probes = execFileMock.mock.calls.length;
    expect(probes).toBe(1); // found in the default set, RADON_SET never queried
    await deviceSetForUdid(DEFAULT_UDID);
    expect(execFileMock.mock.calls.length).toBe(probes);
  });

  it("resolves an unknown-everywhere UDID to the default set WITHOUT caching", async () => {
    additionalSetsMock.mockReturnValue([RADON_SET]);
    mockTwoSets();
    const ghost = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC";
    expect(await deviceSetForUdid(ghost)).toBeNull();
    expect(cachedDeviceSetForUdid(ghost)).toBeNull(); // sync default fallback
    const probes = execFileMock.mock.calls.length;
    // Not cached → a later call re-probes (the device may have appeared).
    await deviceSetForUdid(ghost);
    expect(execFileMock.mock.calls.length).toBeGreaterThan(probes);
  });

  it("never queries a configured set whose directory does not exist", async () => {
    additionalSetsMock.mockReturnValue([RADON_SET]);
    existsSyncMock.mockImplementation((p) => p !== RADON_SET);
    mockTwoSets();
    await deviceSetForUdid(RADON_UDID);
    expect(execFileMock.mock.calls.every((c) => !(c[1] as string[]).includes("--set"))).toBe(true);
  });
});

describe("listIosSimulators — additional-set enumeration", () => {
  it("merges sets, tags additional-set devices, and warms the mapping", async () => {
    additionalSetsMock.mockReturnValue([RADON_SET]);
    mockTwoSets();
    const sims = await listIosSimulators();
    expect(sims.map((s) => s.udid).sort()).toEqual([DEFAULT_UDID, RADON_UDID]);
    expect(sims.find((s) => s.udid === DEFAULT_UDID)?.deviceSet).toBeUndefined();
    expect(sims.find((s) => s.udid === RADON_UDID)?.deviceSet).toBe(RADON_SET);
    // Discovery warmed the map: no extra probe for a follow-up argv build.
    const probes = execFileMock.mock.calls.length;
    expect(await simctlArgsForUdid(RADON_UDID, ["launch", RADON_UDID, "com.app"])).toEqual([
      "simctl",
      "--set",
      RADON_SET,
      "launch",
      RADON_UDID,
      "com.app",
    ]);
    expect(execFileMock.mock.calls.length).toBe(probes);
  });

  it("skips a configured set whose directory does not exist (no dir materialization)", async () => {
    additionalSetsMock.mockReturnValue([RADON_SET]);
    existsSyncMock.mockImplementation((p) => p !== RADON_SET);
    mockTwoSets();
    const sims = await listIosSimulators();
    expect(sims.map((s) => s.udid)).toEqual([DEFAULT_UDID]);
    expect(execFileMock.mock.calls.every((c) => !(c[1] as string[]).includes("--set"))).toBe(true);
  });

  it("dedups a UDID seen in two sets, keeping the first (default-first) sighting", async () => {
    additionalSetsMock.mockReturnValue([RADON_SET]);
    execFileMock.mockImplementation((cmd: string, args: string[]) =>
      cmd === "xcrun" && args[0] === "simctl" ? listPayload(DEFAULT_UDID, "iPhone 17") : undefined
    );
    const sims = await listIosSimulators();
    expect(sims).toHaveLength(1);
    expect(sims[0].deviceSet).toBeUndefined();
    expect(await deviceSetForUdid(DEFAULT_UDID)).toBeNull();
  });

  it("rememberDeviceSet overrides are visible to the sync view", () => {
    rememberDeviceSet(RADON_UDID, RADON_SET);
    expect(cachedDeviceSetForUdid(RADON_UDID)).toBe(RADON_SET);
  });
});
