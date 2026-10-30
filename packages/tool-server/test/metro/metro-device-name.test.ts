import { describe, it, expect, vi, beforeEach } from "vitest";

type ExecOptions = { timeout?: number; killSignal?: string } | undefined;
const calls: Array<{ cmd: string; args: readonly string[]; options: ExecOptions }> = [];
type Devices = Record<string, Array<{ udid: string; name: string; state: string }>>;
let simctlDevices: Devices = {};
/** Devices of each additional set, keyed by the `--set` path simctl was given. */
let setDevices: Record<string, Devices> = {};
let ownSet: string | null = null;
let additionalSets: string[] = [];
let simctlFails = false;
/** Sets that fail to list, as a timed-out or broken simctl would. */
let failingSets: string[] = [];
let hostedDevices: Devices = {};
let hostedFails = false;
let providerDevices: Array<{ platform: "ios" | "android"; deviceSet?: string }> = [];
/** A wedged simctl behind the device-set probe, which has its own longer timeout. */
let deviceSetProbeHangs = false;

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
      if (cmd === "sim-remote") {
        if (hostedFails)
          callback(new Error("sim-remote: not signed in"), { stdout: "", stderr: "" });
        else callback(null, { stdout: JSON.stringify({ devices: hostedDevices }), stderr: "" });
        return;
      }
      const setIndex = args.indexOf("--set");
      const set = setIndex >= 0 ? args[setIndex + 1]! : null;
      if (simctlFails || (set && failingSets.includes(set))) {
        callback(new Error("xcrun: error: unable to find utility"), { stdout: "", stderr: "" });
        return;
      }
      const devices = set ? (setDevices[set] ?? {}) : simctlDevices;
      callback(null, { stdout: JSON.stringify({ devices }), stderr: "" });
    },
  };
});

vi.mock("../../src/utils/ios-device-sets", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/ios-device-sets")>(
    "../../src/utils/ios-device-sets"
  );
  return {
    ...actual,
    deviceSetForUdid: () => (deviceSetProbeHangs ? new Promise(() => {}) : Promise.resolve(ownSet)),
    configuredAdditionalDeviceSets: () => additionalSets,
  };
});

vi.mock("../../src/utils/external-devices", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/external-devices")>(
    "../../src/utils/external-devices"
  );
  return { ...actual, listExternalDevices: async () => providerDevices };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: (p: string) => p.startsWith("/sets/") || actual.existsSync(p) };
});

import {
  metroDeviceNamesFor as namesOnPort,
  noteHostedSimulatorOnMetro,
} from "../../src/utils/debugger/metro-device-name";

const PORT = 8081;
const HOSTED_PORT = 8090;
const metroDeviceNamesFor = (deviceId: string) => namesOnPort(deviceId, PORT);

const UDID_A = "AAAAAAAA-1111-1111-1111-111111111111";
const UDID_B = "22222222-2222-2222-2222-222222222222";
const UDID_C = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  calls.length = 0;
  setDevices = {};
  ownSet = null;
  additionalSets = [];
  simctlFails = false;
  failingSets = [];
  hostedDevices = {};
  hostedFails = false;
  providerDevices = [];
  deviceSetProbeHangs = false;
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
    expect(hint).toEqual({
      name: "iPhone 16 Pro",
      forms: ["iPhone 16 Pro"],
      booted: true,
      bootedTwins: 0,
    });
  });

  it("reports a shut-down simulator as not booted, next to its booted twin", async () => {
    const hint = await metroDeviceNamesFor(UDID_B);
    expect(hint?.booted).toBe(false);
    expect(hint?.bootedTwins).toBe(1);
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

  it("queries the simulator's own device set", async () => {
    ownSet = "/sets/radon";
    additionalSets = ["/sets/radon"];
    setDevices["/sets/radon"] = {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
        { udid: UDID_A, name: "Radon Sim", state: "Booted" },
      ],
    };
    expect((await metroDeviceNamesFor(UDID_A))?.name).toBe("Radon Sim");
    expect(calls[0]?.args).toEqual(["simctl", "--set", "/sets/radon", "list", "devices", "-j"]);
  });

  it("counts a same-named booted simulator in another device set as a twin", async () => {
    additionalSets = ["/sets/radon"];
    setDevices["/sets/radon"] = {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
        { udid: "55555555-5555-5555-5555-555555555555", name: "iPhone 16 Pro", state: "Booted" },
      ],
    };
    expect((await metroDeviceNamesFor(UDID_A))?.bootedTwins).toBe(1);
  });

  it("counts names that only collide after Metro's query parsing as twins", async () => {
    simctlDevices["com.apple.CoreSimulator.SimRuntime.iOS-17-5"]!.push({
      udid: "66666666-6666-6666-6666-666666666666",
      name: "Dev QA&2",
      state: "Booted",
    });
    expect((await metroDeviceNamesFor(UDID_C))?.bootedTwins).toBe(1);
  });

  it("gives no hint when another device set fails to list, since it may hold a twin", async () => {
    additionalSets = ["/sets/radon", "/sets/broken"];
    failingSets = ["/sets/broken"];
    await expect(metroDeviceNamesFor(UDID_A)).resolves.toBeUndefined();
  });

  it("counts a twin in a device set a provider declares", async () => {
    providerDevices = [{ platform: "ios", deviceSet: "/sets/provider" }];
    setDevices["/sets/provider"] = {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
        { udid: "77777777-7777-7777-7777-777777777777", name: "iPhone 16 Pro", state: "Booted" },
      ],
    };
    expect((await metroDeviceNamesFor(UDID_A))?.bootedTwins).toBe(1);
  });

  it("counts a hosted simulator as a twin only on a Metro a hosted app is tunneled into", async () => {
    hostedDevices = {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
        { udid: "88888888-8888-8888-8888-888888888888", name: "iPhone 16 Pro", state: "Booted" },
      ],
    };
    noteHostedSimulatorOnMetro(HOSTED_PORT);
    expect((await namesOnPort(UDID_A, HOSTED_PORT))?.bootedTwins).toBe(1);
    expect((await metroDeviceNamesFor(UDID_A))?.bootedTwins).toBe(0);
    hostedFails = true;
    await expect(namesOnPort(UDID_A, HOSTED_PORT)).resolves.toBeUndefined();
  });

  it("gives no hint once the whole lookup outlasts its deadline", async () => {
    vi.useFakeTimers();
    try {
      deviceSetProbeHangs = true;
      const hint = metroDeviceNamesFor(UDID_A);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(hint).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives no hint when simctl fails, so connect falls back to the id-only rules", async () => {
    simctlFails = true;
    await expect(metroDeviceNamesFor(UDID_A)).resolves.toBeUndefined();
  });
});
