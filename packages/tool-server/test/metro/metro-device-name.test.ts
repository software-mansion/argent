import { describe, it, expect, vi, beforeEach } from "vitest";

type ExecOptions = { timeout?: number; killSignal?: string } | undefined;
const calls: Array<{ cmd: string; args: readonly string[]; options: ExecOptions }> = [];
let simctlDevices: Record<string, Array<{ udid: string; name: string; state: string }>> = {};

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
      const options = (typeof opts === "function" ? undefined : opts) as ExecOptions;
      calls.push({ cmd, args, options });
      callback(null, { stdout: JSON.stringify({ devices: simctlDevices }), stderr: "" });
    },
  };
});

vi.mock("../../src/utils/ios-device-sets", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/ios-device-sets")>(
    "../../src/utils/ios-device-sets"
  );
  return { ...actual, deviceSetForUdid: async () => null };
});

import { metroDeviceNamesFor } from "../../src/utils/debugger/metro-device-name";

const UDID_A = "11111111-1111-1111-1111-111111111111";
const UDID_B = "22222222-2222-2222-2222-222222222222";
const UDID_C = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  calls.length = 0;
  simctlDevices = {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
      { udid: UDID_A, name: "iPhone 16 Pro", state: "Booted" },
      { udid: UDID_C, name: "Dev+QA&1", state: "Booted" },
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
      { udid: UDID_B, name: "iPhone 16 Pro", state: "Shutdown" },
    ],
  };
});

describe("metroDeviceNamesFor", () => {
  it("returns the simulator's simctl name, case-insensitively by UDID", async () => {
    const hint = await metroDeviceNamesFor(UDID_A.toLowerCase());
    expect(hint).toEqual({ name: "iPhone 16 Pro", forms: ["iPhone 16 Pro"], bootedTwins: 0 });
  });

  it("counts booted simulators with the same name", async () => {
    simctlDevices["com.apple.CoreSimulator.SimRuntime.iOS-17-5"]![0]!.state = "Booted";
    expect((await metroDeviceNamesFor(UDID_A))?.bootedTwins).toBe(1);
  });

  it("adds the form Metro's query parsing turns the name into", async () => {
    expect((await metroDeviceNamesFor(UDID_C))?.forms).toEqual(["Dev+QA&1", "Dev QA"]);
  });

  it("resolves a provider-prefixed simulator by its native UDID", async () => {
    expect((await metroDeviceNamesFor(`ext:prov:${UDID_A}`))?.name).toBe("iPhone 16 Pro");
  });

  it("bounds simctl with a SIGKILL timeout", async () => {
    await metroDeviceNamesFor(UDID_A);
    expect(calls[0]?.options?.killSignal).toBe("SIGKILL");
    expect(calls[0]?.options?.timeout).toBeGreaterThan(0);
  });

  it("re-reads simctl on every call, so a rename is picked up", async () => {
    await metroDeviceNamesFor(UDID_A);
    simctlDevices["com.apple.CoreSimulator.SimRuntime.iOS-18-5"]![0]!.name = "Sim A";
    expect((await metroDeviceNamesFor(UDID_A))?.name).toBe("Sim A");
  });

  it("gives no hint for an Android serial or an unknown UDID, without spawning anything for Android", async () => {
    expect(await metroDeviceNamesFor("emulator-5554")).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await metroDeviceNamesFor("44444444-4444-4444-4444-444444444444")).toBeUndefined();
  });
});
